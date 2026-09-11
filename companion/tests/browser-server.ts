// Test-only dependency injection. Neither this fixture server nor test authentication ships in images.
import http from "node:http";
import { createReadStream } from "node:fs";
import { mkdtemp, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { safeRequest } from "../src/security.ts";
// @ts-expect-error Plain ESM fixture generator is test-only.
import { generateMediaFixtures } from "../../scripts/media-fixtures.mjs";

const directory = await mkdtemp(join(tmpdir(), "nuvio-browser-fixtures-"));
await generateMediaFixtures(directory);
const fixture = http.createServer(async (req, res) => {
  const path = new URL(req.url || "/", "http://fixture").pathname.slice(1);
  if (path === "auth/v1/user") { res.writeHead(req.headers.authorization === "Bearer test-nuvio-access" ? 200 : 401, { "content-type": "application/json" }); res.end(JSON.stringify({ id: "fixture-user" })); return; }
  if (["hls-redirect", "hls-redirect-octet"].includes(path)) {
    res.writeHead(302, { location: path.endsWith("octet") ? "/hls/octet.m3u8" : "/hls/manifest", "access-control-allow-origin": "*" }); res.end(); return;
  }
  const name = ["hls/manifest", "hls/octet.m3u8"].includes(path) ? "hls/index.m3u8" : path.replace(/^headers\//, "");
  if (!/^(?:direct\.mp4|remux\.mkv|audio\.mkv|hevc\.mkv|hevc10\.mkv|av1\.webm|sample\.srt|hls(?:-fmp4|-extensionless)?\/[a-z0-9.-]+)$/.test(name)) { res.writeHead(404); res.end(); return; }
  if (path.startsWith("headers/")) {
    if (req.headers.referer !== "https://allowed.example/") { res.writeHead(403); res.end(); return; }
  } else res.setHeader("access-control-allow-origin", "*");
  const file = join(directory, name); const info = await stat(file).catch(() => null);
  if (!info) { res.writeHead(404); res.end(); return; }
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
  const start = Number(range?.[1] || 0); const end = range?.[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
  if (start > end) { res.writeHead(416, { "content-range": `bytes */${info.size}` }); res.end(); return; }
  res.writeHead(range ? 206 : 200, { "content-type": path === "hls/octet.m3u8" ? "application/octet-stream" : name.endsWith("m3u8") ? "application/vnd.apple.mpegurl" : name.endsWith("mp4") ? "video/mp4" : "application/octet-stream", "content-length": end - start + 1, "accept-ranges": "bytes", ...(range ? { "content-range": `bytes ${start}-${end}/${info.size}` } : {}) });
  if (req.method === "HEAD") res.end(); else { const stream = createReadStream(file, { start, end }); stream.pipe(res); res.once("close", () => stream.destroy()); }
});
await new Promise<void>((resolve) => fixture.listen(4320, "127.0.0.1", resolve));
const network: typeof safeRequest = async (raw, options = {}) => {
  const url = new URL(raw);
  if (!["media-fixtures.invalid", "127.0.0.1", "api.nuvio.tv"].includes(url.hostname)) throw new Error("Unknown fixture");
  const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port: 4320, path: url.pathname, headers: options.headers, method: options.method, signal: options.signal }, resolve);
    request.on("error", reject); request.end();
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
    response.destroy();
    if (!response.headers.location || (options.redirects ?? 0) >= 4) throw new Error("Invalid fixture redirect");
    return network(new URL(response.headers.location, url).toString(), { ...options, redirects: (options.redirects ?? 0) + 1 });
  }
  return { response, url };
};
process.env.TRANSCODE_TEMP_DIR = join(directory, "temporary");
const { startCompanion } = await import("../src/index.ts");
const app = await startCompanion(network, 4311);
console.info("Browser fixtures ready: companion 4311, media 4320");
let closing = false;
async function close() { if (closing) return; closing = true; await app.close(); fixture.close(); fixture.closeAllConnections(); await rm(directory, { recursive: true, force: true }); }
process.on("SIGTERM", () => void close()); process.on("SIGINT", () => void close());
