import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, stat, writeFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import type { safeRequest } from "../src/security.ts";
import type { CompanionPlayback } from "../../src/lib/companionPolicy.ts";

test("real FFmpeg media matrix, authenticated HTTP, byte ranges, seek, audio output and cleanup", { skip: process.env.NUVIO_MEDIA_TEST !== "1", timeout: 180_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nuvio-generated-media-"));
  // @ts-expect-error Test-only fixture generator is plain ESM and never bundled.
  const { generateMediaFixtures } = await import("../../scripts/media-fixtures.mjs");
  await generateMediaFixtures(directory);
  const ranges: string[] = []; const customHeaders: string[] = [];
  const fixture = http.createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://fixture").pathname;
    if (path === "/auth/v1/user") { res.writeHead(req.headers.authorization === "Bearer test-nuvio-access" ? 200 : 401, { "content-type": "application/json" }); res.end(JSON.stringify({ id: "fixture-user" })); return; }
    if (path === "/broken") { res.writeHead(404); res.end(); return; }
    const name = path.startsWith("/headers/") ? path.slice(9) : path.slice(1);
    if (path.startsWith("/headers/")) { customHeaders.push(String(req.headers.referer)); if (req.headers.referer !== "https://allowed.example/") { res.writeHead(403); res.end(); return; } }
    if (!/^(?:direct\.mp4|remux\.mkv|audio\.mkv|hevc\.mkv|hevc10\.mkv|av1\.webm|sample\.srt|hls(?:-fmp4|-extensionless)?\/[a-z0-9.-]+)$/.test(name)) { res.writeHead(404); res.end(); return; }
    const file = join(directory, name); const info = await stat(file).catch(() => null);
    if (!info) { res.writeHead(404); res.end(); return; }
    const range = req.headers.range; if (range) ranges.push(range);
    let start = 0; let end = info.size - 1;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match) { res.writeHead(416); res.end(); return; }
      start = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2]));
      end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
      if (start > end) { res.writeHead(416, { "content-range": `bytes */${info.size}` }); res.end(); return; }
    }
    res.writeHead(range ? 206 : 200, { "content-length": end - start + 1, "accept-ranges": "bytes", "content-type": name.endsWith("m3u8") ? "application/vnd.apple.mpegurl" : name.endsWith("srt") ? "text/plain" : "application/octet-stream", ...(range ? { "content-range": `bytes ${start}-${end}/${info.size}` } : {}) });
    if (req.method === "HEAD") res.end(); else { const stream = createReadStream(file, { start, end }); stream.pipe(res); res.once("close", () => stream.destroy()); }
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  t.after(() => { fixture.close(); fixture.closeAllConnections(); });
  const address = fixture.address(); assert.ok(address && typeof address !== "string");
  const network: typeof safeRequest = async (raw, options = {}) => {
    const url = new URL(raw);
    assert.ok(url.hostname === "media-fixtures.invalid" || url.hostname === "api.nuvio.tv");
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const request = http.request({ hostname: "127.0.0.1", port: address.port, path: url.pathname, headers: options.headers, method: options.method, signal: options.signal }, resolve);
      request.on("error", reject); request.end();
    });
    return { response, url };
  };
  process.env.TRANSCODE_TEMP_DIR = join(directory, "temporary");
  const { startCompanion } = await import("../src/index.ts");
  const app = await startCompanion(network, 0);
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const base = origin + "/api/companion";
  let cookie = ""; let csrf = "";
  const api = (path: string, body?: unknown) => fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { origin, "content-type": "application/json", cookie, "x-nuvio-csrf": csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  const caps = { nativeHls: false, mse: true, hdr: false, video: { h264: true, hevc: false, hevc10: false, av1: false }, audio: { aac: true, eac3: false, opus: true } };
  const create = async (filename: string, capabilities = caps, extra = {}) => {
    const response = await api("/sessions", { url: `https://media-fixtures.invalid/${filename}`, capabilities, preferences: { mode: "automatic", resolution: "original" }, ...extra });
    const value = await response.json() as CompanionPlayback & { error?: string };
    assert.equal(response.status, 201, value.error); return value;
  };
  const stop = async (session: CompanionPlayback) => { assert.equal((await api(`/sessions/${session.id}/stop`, {})).status, 200); };
  const output = async (session: CompanionPlayback) => {
    const playlist = await fetch(origin + session.url, { headers: { cookie } });
    assert.equal(playlist.status, 200, await playlist.clone().text());
    const text = await playlist.text(); const segment = text.split("\n").find((line) => line.endsWith(".m4s")); assert.ok(segment, text);
    const baseUrl = origin + session.url.replace(/index\.m3u8$/, "");
    const chunks = await Promise.all(["init.mp4", segment].map(async (file) => Buffer.from(await (await fetch(baseUrl + file, { headers: { cookie } })).arrayBuffer())));
    const file = join(directory, `output-${session.id}-${session.generation}.mp4`); await writeFile(file, Buffer.concat(chunks));
    const probe = spawnSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", file], { encoding: "utf8" });
    assert.equal(probe.status, 0, probe.stderr);
    const decoded = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-t", "0.5", "-f", "null", "-"], { encoding: "utf8" }); assert.equal(decoded.status, 0, decoded.stderr);
    return { file, streams: (JSON.parse(probe.stdout) as { streams: Array<{ codec_type: string; codec_name: string }> }).streams };
  };
  try {
    await t.test("authenticated session exchange, CSRF and private media access", async () => {
      assert.equal((await api("/sessions", {})).status, 401);
      const response = await fetch(base + "/auth", { method: "POST", headers: { origin, authorization: "Bearer test-nuvio-access", "content-type": "application/json" }, body: JSON.stringify({ backend: "https://api.nuvio.tv" }) });
      assert.equal(response.status, 200); cookie = response.headers.get("set-cookie")!.split(";")[0]; csrf = (await response.json() as { csrf: string }).csrf;
      const rejected = await fetch(base + "/sessions", { method: "POST", headers: { cookie, "content-type": "application/json", origin: "https://evil.example" }, body: "{}" }); assert.equal(rejected.status, 403);
    });
    await t.test("MP4 relay preserves exact ranges and required upstream headers", async () => {
      const session = await create("headers/direct.mp4", caps, { headers: { Referer: "https://allowed.example/" } }); assert.equal(session.mode, "relay");
      const response = await fetch(origin + session.url, { headers: { cookie, range: "bytes=100-199" } });
      assert.equal(response.status, 206); assert.equal(response.headers.get("content-range"), `bytes 100-199/${(await stat(join(directory, "direct.mp4"))).size}`);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), (await readFile(join(directory, "direct.mp4"))).subarray(100, 200));
      assert.ok(customHeaders.every((value) => value === "https://allowed.example/"));
      assert.equal((await fetch(origin + session.url)).status, 401); await stop(session);
    });
    await t.test("HLS playlists are probed and every media URI stays behind authentication", async () => {
      for (const file of ["hls/index.m3u8", "hls-fmp4/index.m3u8", "hls-extensionless/index.m3u8"]) {
        const session = await create(file); assert.equal(session.mode, "relay");
        const response = await fetch(origin + session.url, { headers: { cookie } });
        assert.equal(response.status, 200); const playlist = await response.text();
        assert.ok(!playlist.includes("media-fixtures.invalid"));
        const segment = playlist.split("\n").find((line) => line.startsWith("/api/companion/")); assert.ok(segment, playlist);
        assert.equal((await fetch(origin + segment, { headers: { cookie } })).status, 200);
        assert.equal((await fetch(origin + segment)).status, 401);
        await stop(session);
      }
    });
    for (const [file, mode, codecCaps] of [
      ["remux.mkv", "remux", caps], ["audio.mkv", "audio-transcode", caps], ["hevc.mkv", "transcode", caps],
      ["hevc10.mkv", "audio-transcode", { ...caps, video: { ...caps.video, hevc10: true } }], ["av1.webm", "transcode", caps],
    ] as const) await t.test(`${file}: real ${mode} output decodes`, async () => {
      const start = performance.now(); const session = await create(file, codecCaps); assert.equal(session.mode, mode);
      const value = await output(session); assert.equal(value.streams.find((s) => s.codec_type === "video")?.codec_name, file === "hevc10.mkv" ? "hevc" : "h264");
      assert.equal(value.streams.find((s) => s.codec_type === "audio")?.codec_name, "aac");
      console.info(JSON.stringify({ fixture: file, mode, startupMs: Math.round(performance.now() - start) })); await stop(session);
    });
    await t.test("seeking both directions restarts output and actual audio frequency changes", async () => {
      const session = await create("remux.mkv"); const first = await output(session);
      let current = session;
      for (const position of [16, 4, 20]) {
        const response = await api(`/sessions/${session.id}/change`, { position }); assert.equal(response.status, 200);
        current = await response.json() as CompanionPlayback; assert.equal(current.offset, position); await output(current);
      }
      const response = await api(`/sessions/${session.id}/change`, { position: 0, audioIndex: 2 }); assert.equal(response.status, 200);
      current = await response.json() as CompanionPlayback; assert.equal(current.audioIndex, 2); const second = await output(current);
      const frequency = (file: string) => {
        const pcm = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-vn", "-t", "1", "-ac", "1", "-ar", "8000", "-f", "s16le", "-"], { maxBuffer: 1_000_000 }).stdout;
        let crossings = 0; for (let i = 2; i + 1 < pcm.length; i += 2) if (pcm.readInt16LE(i - 2) <= 0 && pcm.readInt16LE(i) > 0) crossings++;
        return crossings / (pcm.length / 2 / 8000);
      };
      assert.ok(Math.abs(frequency(first.file) - 440) < 30); assert.ok(Math.abs(frequency(second.file) - 880) < 30);
      assert.ok(ranges.some((range) => !range.startsWith("bytes=0-"))); await stop(current);
    });
    await t.test("pause suspends production, resume continues, and concurrency is bounded", async () => {
      const first = await create("audio.mkv"); await output(first);
      assert.equal((await api(`/sessions/${first.id}/heartbeat`, { paused: true })).status, 200);
      const child = app.sessions.sessions.get(first.id)!.child!;
      assert.match(await readFile(`/proc/${child.pid}/status`, "utf8"), /State:\s+T/);
      assert.equal((await api(`/sessions/${first.id}/heartbeat`, { paused: false })).status, 200);
      const second = await create("remux.mkv");
      const rejected = await api("/sessions", { url: "https://media-fixtures.invalid/hevc.mkv", capabilities: caps, preferences: { mode: "automatic", resolution: "original" } });
      assert.equal(rejected.status, 429);
      await stop(first); await stop(second);
      assert.equal(app.sessions.sessions.size, 0);
    });
    await t.test("subtitle conversion and broken source cleanup", async () => {
      const response = await api("/subtitles", { url: "https://media-fixtures.invalid/sample.srt" }); assert.equal(response.status, 200); assert.match((await response.json() as { vtt: string }).vtt, /WEBVTT/);
      const broken = await api("/sessions", { url: "https://media-fixtures.invalid/broken", capabilities: caps, preferences: { mode: "automatic", resolution: "original" } }); assert.equal(broken.status, 415);
      assert.equal(app.sessions.sessions.size, 0);
      const runs = await readdir(join(directory, "temporary"));
      for (const run of runs) assert.deepEqual(await readdir(join(directory, "temporary", run)), []);
    });
  } finally { await app.close(); fixture.close(); fixture.closeAllConnections(); await rm(directory, { recursive: true, force: true }); }
});
