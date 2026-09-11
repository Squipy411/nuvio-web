import assert from "node:assert/strict";
import test from "node:test";
import { createServer, request, type IncomingMessage } from "node:http";
import { setImmediate as tick } from "node:timers/promises";
import { PlaybackSessions } from "../src/sessions.ts";
import { HlsResources } from "../src/hlsResources.ts";
import type { safeRequest } from "../src/security.ts";

test("the internal media reader distinguishes source outages from deliberate cancellation", async (t) => {
  const upstream = createServer((_req, res) => { res.writeHead(503); res.end("unavailable"); });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => { upstream.close(); upstream.closeAllConnections(); });
  const port = (upstream.address() as { port: number }).port;
  let network: typeof safeRequest = async (raw) => ({
    url: new URL(raw),
    response: await new Promise<IncomingMessage>((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port }, resolve);
      req.on("error", reject); req.end();
    }),
  });
  const manager = new PlaybackSessions((...args) => network(...args));
  const session: Parameters<PlaybackSessions["relay"]>[2] = {
    id: "test", owner: "fixture", upstream: "https://media-fixtures.invalid/video.mkv", headers: {},
    capabilities: { mse: true, nativeHls: false, hdr: false, video: {}, audio: {} },
    preferences: { mode: "automatic", resolution: "original" },
    probe: { container: "matroska", duration: 60, audio: [], subtitles: [], seekable: true },
    resources: new HlsResources(), secret: "fixture", directory: "not-used", generation: 1,
    mode: "remux", attempted: [], audioIndex: -1, offset: 0, heartbeat: 0, created: 0,
    controller: new AbortController(), changing: false, disposed: false,
  };
  session.resources.set("root", session.upstream);
  let internal = true;
  const proxy = createServer((req, res) => {
    void manager.relay(req, res, session, "root", internal).catch(() => {
      if (!res.destroyed) { res.writeHead(502); res.end(); }
    });
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => { proxy.close(); proxy.closeAllConnections(); });
  const endpoint = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  const get = async () => { const result = await fetch(endpoint); await result.arrayBuffer(); return result.status; };

  await t.test("upstream HTTP denial marks an active FFmpeg generation", async () => {
    assert.equal(await get(), 503);
    assert.equal(session.sourceReadFailed, true);
  });
  await t.test("a public relay error is not a converter failure", async () => {
    session.sourceReadFailed = false; internal = false;
    assert.equal(await get(), 503);
    assert.equal(session.sourceReadFailed, false);
    internal = true;
  });
  await t.test("inspection and old-generation shutdown do not contaminate conversion", async () => {
    session.sourceReadFailed = false; session.generation = 0;
    assert.equal(await get(), 503);
    assert.equal(session.sourceReadFailed, false);
    session.generation = 1; session.changing = true;
    assert.equal(await get(), 503);
    assert.equal(session.sourceReadFailed, false);
    session.changing = false;
  });
  await t.test("a failed upstream connection marks a source failure", async () => {
    network = async (_raw, options) => {
      assert.equal(options?.timeoutMs, 12000, "source stalls must be detected before FFmpeg's 15s deadline");
      throw new Error("test connection reset");
    };
    assert.equal(await get(), 502);
    assert.equal(session.sourceReadFailed, true);
  });
  await t.test("closing the FFmpeg consumer is not mistaken for a source failure", async () => {
    session.sourceReadFailed = false;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    network = async (_raw, options) => {
      started();
      return new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("consumer closed")), { once: true }));
    };
    const controller = new AbortController();
    const response = fetch(endpoint, { signal: controller.signal });
    const rejection = assert.rejects(response);
    await ready;
    controller.abort();
    await rejection;
    await tick(); await tick();
    assert.equal(session.sourceReadFailed, false);
  });
});
