import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { z } from "zod";
import { authenticate, exchange, revoke } from "./auth.ts";
import { config } from "./config.ts";
import { HttpError, readLimited, safeLog, safeRequest } from "./security.ts";
import { PlaybackSessions } from "./sessions.ts";
import { toWebVtt } from "./subtitles.ts";

const modes = z.enum(["direct", "native-hls", "hls-js", "relay", "remux", "audio-transcode", "transcode"]);
const createSchema = z.object({
  url: z.string().min(1).max(8192), headers: z.record(z.string().max(80), z.string().max(4096)).optional(),
  capabilities: z.object({ nativeHls: z.boolean(), mse: z.boolean(), video: z.record(z.string().max(30), z.boolean()), audio: z.record(z.string().max(30), z.boolean()), hdr: z.boolean() }),
  preferences: z.object({ mode: z.enum(["automatic", "direct", "compatibility"]), resolution: z.enum(["original", "1080", "720"]) }),
  position: z.number().finite().min(0).max(7 * 24 * 3600).default(0), preferredAudio: z.string().max(32).optional(), previous: z.array(modes).max(7).optional(),
});
const changeSchema = z.object({ position: z.number().finite().min(0).max(7 * 24 * 3600), audioIndex: z.number().int().min(0).max(256).optional(), recover: z.boolean().optional() });

async function ffmpegVersion() {
  return new Promise<string>((resolve, reject) => {
    const process = spawn(globalThis.process.env.FFMPEG_PATH || "ffmpeg", ["-version"], { stdio: ["ignore", "pipe", "ignore"] });
    let result = "";
    process.stdout.on("data", (part: Buffer) => { if (result.length < 1000) result += part.toString(); });
    process.on("error", reject); process.on("close", (code) => code === 0 ? resolve(result.split("\n")[0].slice(0, 150)) : reject(new Error("FFmpeg is not installed")));
  });
}

export async function startCompanion(network: typeof safeRequest = safeRequest, port = config.port) {
  const version = await ffmpegVersion();
  const sessions = new PlaybackSessions(network); await sessions.init();
  const server = createServer({ maxHeaderSize: 16_384, requestTimeout: 30_000, headersTimeout: 10_000 }, (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    const path = new URL(request.url ?? "/", "http://companion").pathname;
    const controller = new AbortController(); response.once("close", () => controller.abort());
    const json = (value: unknown, status = 200) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)); };
    const body = async () => { if (!request.headers["content-type"]?.startsWith("application/json")) throw new HttpError(415, "JSON requests are required."); return JSON.parse((await readLimited(request, 32_768)).toString()) as unknown; };
    void (async () => {
      if (request.method === "GET" && ["/healthz", "/api/companion/healthz"].includes(path)) { json({ status: "ok", ffmpeg: version }); return; }
      if (request.method === "GET" && path === "/api/companion/config") { json({ backendUrl: config.backendUrl, publishableKey: config.publishableKey }); return; }
      if (request.method === "POST" && path === "/api/companion/auth") { json(await exchange(request, response, z.object({ backend: z.string().url().max(2048) }).parse(await body()), network)); return; }
      if (request.method === "POST" && path === "/api/companion/logout") { const owner = revoke(request, response); await sessions.stopOwner(owner); json({ ok: true }); return; }
      const auth = authenticate(request, !["GET", "HEAD"].includes(request.method ?? ""));
      if (request.method === "POST" && path === "/api/companion/subtitles") {
        const input = z.object({ url: z.string().url().max(8192) }).parse(await body());
        const upstream = await network(input.url, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
        if (upstream.response.statusCode !== 200) { upstream.response.destroy(); throw new HttpError(502, "The subtitle host did not return a subtitle."); }
        json({ vtt: toWebVtt((await readLimited(upstream.response, 2 * 1024 * 1024)).toString()) }); return;
      }
      if (request.method === "GET" && path === "/api/companion/diagnostics") { json({ ffmpeg: version, sessions: [...sessions.sessions.values()].filter((s) => s.owner === auth.owner).map((s) => { const { url: _url, ...safe } = sessions.view(s); return safe; }), maxTranscodes: config.maxTranscodes }); return; }
      if (request.method === "POST" && path === "/api/companion/sessions") { json(await sessions.create(auth.owner, createSchema.parse(await body()), controller.signal), 201); return; }
      const match = /^\/api\/companion\/sessions\/([A-Za-z0-9_-]{32})(?:\/(.*))?$/.exec(path);
      if (!match) throw new HttpError(404, "Not found.");
      const session = sessions.get(match[1], auth.owner);
      const action = match[2] ?? "";
      if (request.method === "GET" && !action) { json(sessions.view(session)); return; }
      if (request.method === "DELETE" && !action || request.method === "POST" && action === "stop") { await sessions.stop(session); json({ ok: true }); return; }
      if (request.method === "POST" && action === "heartbeat") { const input = z.object({ paused: z.boolean().optional(), generation: z.number().int().min(0).optional() }).parse(await body()); sessions.heartbeat(session, input.generation === undefined || input.generation === session.generation ? input.paused : undefined); json(sessions.view(session)); return; }
      if (request.method === "POST" && action === "change") { json(await sessions.change(session, changeSchema.parse(await body()))); return; }
      if (["GET", "HEAD"].includes(request.method ?? "") && action.startsWith("media/")) { await sessions.relay(request, response, session, action.slice(6)); return; }
      const segment = /^hls\/(\d+)\/(.+)$/.exec(action);
      if (segment && ["GET", "HEAD"].includes(request.method ?? "")) { await sessions.segment(request, response, session, Number(segment[1]), segment[2]); return; }
      throw new HttpError(404, "Not found.");
    })().catch((error: unknown) => {
      if (response.destroyed) return;
      const status = error instanceof HttpError ? error.status : error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 502;
      const message = error instanceof HttpError ? error.message : status === 400 ? "Invalid playback request." : "The upstream request failed. Check the source and try again.";
      safeLog("request.error", { status });
      if (!response.headersSent) json({ error: message }, status); else response.destroy();
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "0.0.0.0", resolve); });
  } catch (error) { await sessions.close(); throw error; }
  safeLog("companion.ready", { port: (server.address() as { port: number }).port });
  const close = async () => { server.close(); await sessions.close(); server.closeAllConnections(); };
  process.once("SIGTERM", () => void close()); process.once("SIGINT", () => void close());
  return { server, sessions, close };
}

if (import.meta.main) void startCompanion().catch(() => { console.error("Companion startup failed. Verify FFmpeg and temporary-directory permissions."); process.exitCode = 1; });
