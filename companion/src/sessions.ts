import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { ChildProcess } from "node:child_process";
import { choosePlaybackMode, type BrowserCapabilities, type CompanionPlayback, type MediaProbe, type PlaybackMode, type PlaybackPreferences } from "../../src/lib/companionPolicy.ts";
import { opaqueId } from "./auth.ts";
import { config } from "./config.ts";
import { ffmpegArguments, startFfmpeg, stopProcess } from "./ffmpeg.ts";
import { rewritePlaylist } from "./playlist.ts";
import { probeMedia } from "./probe.ts";
import { HttpError, mediaUrl, readLimited, safeLog, safeRequest, upstreamHeaders } from "./security.ts";

type Session = {
  id: string; owner: string; upstream: string; headers: Record<string, string>;
  capabilities: BrowserCapabilities; preferences: PlaybackPreferences; probe: MediaProbe;
  resources: Map<string, string>; secret: string; directory: string; generation: number;
  mode: PlaybackMode; attempted: PlaybackMode[]; audioIndex: number; offset: number;
  heartbeat: number; created: number; speed?: number; error?: string; child?: ChildProcess;
  controller: AbortController; changing: boolean; disposed: boolean; paused?: boolean;
};
type CreateInput = { url: string; headers?: Record<string, string>; capabilities: BrowserCapabilities; preferences: PlaybackPreferences; position: number; preferredAudio?: string; previous?: PlaybackMode[] };
type NetResponse = Awaited<ReturnType<typeof safeRequest>>;

export class PlaybackSessions {
  private network: typeof safeRequest;
  constructor(network: typeof safeRequest = safeRequest) { this.network = network; }
  sessions = new Map<string, Session>();
  cache = new Map<string, { probe: MediaProbe; until: number }>();
  private root = "";
  private internalBase = "";
  private sweep?: ReturnType<typeof setInterval>;
  private sweeping = false;
  private reader = createServer((req, res) => {
    void this.internal(req, res).catch(() => { if (!res.headersSent) res.writeHead(502); res.end(); });
  });
  async init() {
    await mkdir(config.tempRoot, { recursive: true, mode: 0o700 });
    // This is a dedicated temporary directory. Only our generated session names are removed.
    for (const item of await readdir(config.tempRoot)) if (/^run-[A-Za-z0-9_-]{32}$/.test(item)) await rm(join(config.tempRoot, item), { recursive: true, force: true });
    this.root = join(config.tempRoot, `run-${opaqueId()}`);
    await mkdir(this.root, { mode: 0o700 });
    await new Promise<void>((resolve) => this.reader.listen(0, "127.0.0.1", resolve));
    const address = this.reader.address();
    if (!address || typeof address === "string") throw new Error("Reader could not listen");
    this.internalBase = `http://127.0.0.1:${address.port}`;
    this.sweep = setInterval(() => void this.cleanup().catch(() => safeLog("cleanup.error")), 2000);
    this.sweep.unref();
  }
  get(id: string, owner: string): Session {
    const session = this.sessions.get(id);
    if (!session || session.owner !== owner || session.disposed) throw new HttpError(404, "Playback session expired. Choose the source again.");
    return session;
  }
  view(session: Session): CompanionPlayback {
    return { id: session.id, mode: session.mode, generation: session.generation, offset: session.offset, probe: session.probe,
      audioIndex: session.audioIndex, speed: session.speed, error: session.error,
      url: session.mode === "relay" ? `/api/companion/sessions/${session.id}/media/root` : `/api/companion/sessions/${session.id}/hls/${session.generation}/index.m3u8` };
  }
  async create(owner: string, input: CreateInput, signal: AbortSignal) {
    if (this.sessions.size >= config.maxSessions || [...this.sessions.values()].filter((s) => s.owner === owner).length >= 3) throw new HttpError(429, "Stop another playback session before starting this one.");
    const id = opaqueId();
    const session: Session = { id, owner, upstream: mediaUrl(input.url).toString(), headers: upstreamHeaders(input.headers),
      capabilities: input.capabilities, preferences: input.preferences, resources: new Map(), secret: opaqueId(),
      directory: join(this.root, id), generation: 0, mode: "relay", attempted: input.previous ?? [],
      audioIndex: -1, offset: 0, heartbeat: Date.now(), created: Date.now(), controller: new AbortController(), changing: false, disposed: false,
      probe: { container: "unknown", duration: 0, audio: [], subtitles: [], seekable: false } };
    session.resources.set("root", session.upstream);
    this.sessions.set(id, session);
    const cancel = () => void this.stop(session);
    signal.addEventListener("abort", cancel, { once: true });
    safeLog("session.create", { session: id });
    try {
      const key = createHash("sha256").update(JSON.stringify([session.upstream, session.headers])).digest("hex");
      const cached = this.cache.get(key);
      if (cached && cached.until > Date.now()) session.probe = structuredClone(cached.probe);
      else {
        session.probe = await probeMedia(`${this.internalBase}/${session.secret}/${id}/root`, session.controller.signal);
        const response = await this.network(session.upstream, { headers: { ...session.headers, range: "bytes=0-1023" }, signal: session.controller.signal });
        session.probe.acceptRanges = String(response.response.headers["accept-ranges"] ?? "unknown");
        session.probe.seekable = response.response.statusCode === 206 || session.probe.acceptRanges === "bytes";
        session.probe.contentType = String(response.response.headers["content-type"] ?? "").slice(0, 100);
        session.probe.contentLength = Number(response.response.headers["content-range"]?.split("/")[1] ?? response.response.headers["content-length"]) || undefined;
        response.response.destroy();
        if (this.cache.size >= 64) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, { probe: structuredClone(session.probe), until: Date.now() + 5 * 60_000 });
      }
      safeLog("probe.complete", { session: id, container: session.probe.container, video: session.probe.video?.codec, audioTracks: session.probe.audio.length });
      const language = input.preferredAudio?.toLowerCase().split(/[-_]/)[0];
      const aliases: Record<string, string[]> = { en: ["en", "eng"], fr: ["fr", "fra", "fre"], de: ["de", "deu", "ger"], es: ["es", "spa"], it: ["it", "ita"], ja: ["ja", "jpn"] };
      session.audioIndex = (session.probe.audio.find((track) => (aliases[language ?? ""] ?? [language ?? ""]).includes(track.language?.toLowerCase() ?? "unknown")) ?? session.probe.audio.find((t) => t.default) ?? session.probe.audio[0])?.index ?? -1;
      session.mode = choosePlaybackMode(session.probe, session.capabilities, session.audioIndex, session.attempted, session.preferences.mode);
      if (session.mode !== "relay") await this.restart(session, input.position);
      if (session.disposed || signal.aborted) throw new HttpError(499, "Playback was cancelled.");
      safeLog("playback.selected", { session: id, mode: session.mode });
      return this.view(session);
    } catch (error) { await this.stop(session); throw error; }
    finally { signal.removeEventListener("abort", cancel); }
  }
  async restart(session: Session, position: number) {
    if (session.disposed) throw new HttpError(404, "Playback has stopped.");
    if (session.changing) throw new HttpError(409, "A playback change is already in progress.");
    const running = [...this.sessions.values()].filter((s) => s !== session && (s.changing || s.child && s.child.exitCode === null && s.child.signalCode === null)).length;
    if (running >= config.maxTranscodes) throw new HttpError(429, "The companion is busy. Stop another conversion or try a direct source.");
    if (position > 0 && !session.probe.seekable && !/hls/.test(session.probe.container)) throw new HttpError(409, "The source host does not support seeking. Start at the beginning or select another source.");
    session.changing = true;
    try {
      await stopProcess(session.child); session.child = undefined;
      if (session.disposed) throw new HttpError(404, "Playback has stopped.");
      if (session.generation) await rm(session.directory, { recursive: true, force: true });
      await mkdir(session.directory, { recursive: true, mode: 0o700 });
      if (session.disposed) { await rm(session.directory, { recursive: true, force: true }); throw new HttpError(404, "Playback has stopped."); }
      session.generation++; session.error = undefined; session.speed = undefined;
      session.offset = Math.min(Math.max(0, position), session.probe.duration > 0 ? Math.max(0, session.probe.duration - 1) : position);
      session.heartbeat = Date.now();
      const generation = session.generation;
      const args = ffmpegArguments({ url: `${this.internalBase}/${session.secret}/${session.id}/root`, directory: session.directory, mode: session.mode, position: session.offset, audioIndex: session.audioIndex, probe: session.probe, resolution: session.preferences.resolution });
      session.child = startFfmpeg(args, { speed: (value) => { if (session.generation === generation) session.speed = value; }, failed: () => { if (!session.disposed && session.generation === generation) session.error = "The conversion stopped. Try the next compatibility mode or another source."; } });
      session.paused = false;
      safeLog("ffmpeg.start", { session: session.id, mode: session.mode, generation, position: session.offset });
    } finally { session.changing = false; }
  }
  async change(session: Session, input: { position: number; audioIndex?: number; recover?: boolean }) {
    if (session.changing) throw new HttpError(409, "A playback change is already in progress.");
    if (input.audioIndex !== undefined) {
      if (!session.probe.audio.some((track) => track.index === input.audioIndex)) throw new HttpError(400, "Audio track does not exist.");
      session.audioIndex = input.audioIndex;
      session.mode = choosePlaybackMode(session.probe, session.capabilities, session.audioIndex, ["relay"], session.preferences.mode);
    }
    if (input.recover) {
      if (session.mode === "transcode") throw new HttpError(415, "All compatibility modes failed. The source may be damaged or protected; select another source or use an external player.");
      session.attempted.push(session.mode);
      session.mode = choosePlaybackMode(session.probe, session.capabilities, session.audioIndex, session.attempted, session.preferences.mode);
    }
    if (session.mode === "relay") return this.view(session);
    await this.restart(session, input.position);
    return this.view(session);
  }
  heartbeat(session: Session, paused?: boolean) {
    session.heartbeat = Date.now();
    if (paused === undefined || paused === session.paused || session.changing) return;
    // Pause production too: a rolling playlist must never discard a paused viewer's position.
    if (session.child?.exitCode === null && session.child.signalCode === null) session.child.kill(paused ? "SIGSTOP" : "SIGCONT");
    session.paused = paused;
  }
  private register(session: Session, url: string) {
    for (const [id, value] of session.resources) if (value === url) return id;
    if (session.resources.size > 8192) throw new HttpError(413, "Playlist contains too many resources.");
    const id = opaqueId(); session.resources.set(id, url); return id;
  }
  private async internal(request: IncomingMessage, response: ServerResponse) {
    const match = /^\/([A-Za-z0-9_-]{32})\/([A-Za-z0-9_-]{32})\/([A-Za-z0-9_-]+)$/.exec(request.url ?? "");
    if (!match || !["GET", "HEAD"].includes(request.method ?? "")) throw new HttpError(404, "Not found.");
    const session = this.sessions.get(match[2]);
    if (!session || session.secret !== match[1] || session.disposed) throw new HttpError(404, "Not found.");
    await this.relay(request, response, session, match[3], true);
  }
  async relay(request: IncomingMessage, response: ServerResponse, session: Session, resource: string, internal = false) {
    const url = session.resources.get(resource);
    if (!url) throw new HttpError(404, "Media resource not found.");
    const range = request.headers.range;
    if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) throw new HttpError(416, "Only a single byte range is supported.");
    const controller = new AbortController();
    const abort = () => controller.abort();
    response.once("close", abort);
    let upstream: NetResponse | undefined;
    try {
      const headers = { ...session.headers };
      if (new URL(url).origin !== new URL(session.upstream).origin) { delete headers.authorization; delete headers.cookie; }
      if (range) headers.range = range;
      if (request.headers["if-range"]) headers["if-range"] = String(request.headers["if-range"]);
      upstream = await this.network(url, { headers, method: request.method === "HEAD" ? "HEAD" : "GET", signal: AbortSignal.any([controller.signal, session.controller.signal]) });
      const incoming = upstream.response;
      if ((incoming.statusCode ?? 500) >= 400) {
        response.writeHead(incoming.statusCode ?? 502, { ...(incoming.headers["content-range"] ? { "content-range": incoming.headers["content-range"] } : {}) }); response.end(); return;
      }
      const type = String(incoming.headers["content-type"] ?? "application/octet-stream");
      if (/mpegurl/i.test(type) || /\.m3u8(?:\?|$)/i.test(url)) {
        const text = (await readLimited(incoming, 2 * 1024 * 1024)).toString();
        const playlist = rewritePlaylist(text, upstream.url.toString(), (child) => {
          const key = this.register(session, child);
          return internal ? `${this.internalBase}/${session.secret}/${session.id}/${key}` : `/api/companion/sessions/${session.id}/media/${key}`;
        });
        response.writeHead(200, { "content-type": "application/vnd.apple.mpegurl", "cache-control": "no-store" }); response.end(playlist); return;
      }
      const output: Record<string, string | number> = { "content-type": /^(?:video|audio)\/|^application\/(?:octet-stream|mp4|vnd\.apple\.mpegurl|x-mpegurl)/i.test(type) ? type : "application/octet-stream", "cache-control": "no-store", "x-content-type-options": "nosniff" };
      for (const name of ["content-length", "content-range", "accept-ranges", "etag", "last-modified"]) if (incoming.headers[name] !== undefined) output[name] = String(incoming.headers[name]);
      response.writeHead(incoming.statusCode ?? 200, output);
      await pipeline(incoming, response);
    } finally { response.removeListener("close", abort); upstream?.response.destroy(); }
  }
  async segment(request: IncomingMessage, response: ServerResponse, session: Session, generation: number, name: string) {
    if (generation !== session.generation || !/^(?:index\.m3u8|init\.mp4|segment-\d{6}\.m4s)$/.test(name)) throw new HttpError(404, "Segment is no longer available.");
    if (session.error) throw new HttpError(502, session.error);
    const path = join(session.directory, name);
    // First segment generation is progressive. Bound the wait; no infinite spinner.
    const until = Date.now() + 20_000;
    while (!(await stat(path).catch(() => null))) {
      if (session.error || session.disposed || response.destroyed || generation !== session.generation || Date.now() > until) throw new HttpError(504, session.error || "The companion did not produce a segment in time.");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    response.writeHead(200, { "content-type": name.endsWith("m3u8") ? "application/vnd.apple.mpegurl" : "video/mp4", "cache-control": "no-store" });
    if (request.method === "HEAD") response.end(); else await pipeline(createReadStream(path), response);
  }
  async stop(session: Session) {
    if (session.disposed) return;
    session.disposed = true; session.controller.abort();
    await stopProcess(session.child);
    await rm(session.directory, { recursive: true, force: true });
    this.sessions.delete(session.id);
    safeLog("session.stop", { session: session.id });
  }
  async stopOwner(owner: string) { await Promise.all([...this.sessions.values()].filter((s) => s.owner === owner).map((s) => this.stop(s))); }
  private async cleanup() {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      let total = 0;
      for (const session of [...this.sessions.values()]) {
        if (Date.now() - session.heartbeat > config.idleMs || Date.now() - session.created > 8 * 3600_000) { await this.stop(session); continue; }
        const files = await readdir(session.directory).catch(() => []);
        for (const name of files) total += (await stat(join(session.directory, name)).catch(() => null))?.size ?? 0;
      }
      if (total > config.tempLimit) {
        const largest = [...this.sessions.values()].find((session) => session.child && !session.error);
        if (largest) { largest.error = "Temporary stream storage limit reached. Select a lower compatibility resolution or another source."; await stopProcess(largest.child); await rm(largest.directory, { recursive: true, force: true }); safeLog("storage.limit", { session: largest.id, bytes: total }); }
      }
    } finally { this.sweeping = false; }
  }
  async close() {
    clearInterval(this.sweep);
    await Promise.all([...this.sessions.values()].map((s) => this.stop(s)));
    this.reader.close(); this.reader.closeAllConnections();
    await rm(this.root, { recursive: true, force: true });
  }
}
