import assert from "node:assert/strict";
import test from "node:test";
import { CompanionPlayer } from "../src/lib/companionPlayer.ts";
import { companionRequest, readCompanionPreferences } from "../src/lib/companionClient.ts";
import { clearCompanionAuthorization } from "../src/lib/companionAuthState.ts";
import { platform } from "../src/platform/index.ts";

class Video extends EventTarget {
  currentTime = 2; duration = 60; paused = false; ended = false; readyState = 4;
  buffered = { length: 1, end: () => 30 };
  textTracks = [];
  canPlayType() { return "probably"; }
  getVideoPlaybackQuality() { return { totalVideoFrames: 20 }; }
  pause() { this.paused = true; this.dispatchEvent(new Event("pause")); }
  play() { this.paused = false; this.dispatchEvent(new Event("play")); return Promise.resolve(); }
  removeAttribute() {}
  load() {}
}
globalThis.document = { createElement: () => new Video() };
globalThis.matchMedia = () => ({ matches: false });
globalThis.localStorage = { getItem: () => null };
globalThis.window = new EventTarget();
globalThis.location = { protocol: "http:" };
const originalFetch = globalThis.fetch;
const originalExchange = platform.auth.companionSession;
const session = () => ({ id: "test", url: "/api/companion/test.m3u8", generation: 0, mode: "remux", offset: 0, audioIndex: 1, probe: { duration: 60, container: "matroska", audio: [{ index: 1, codec: "aac" }], subtitles: [], seekable: true } });
function setup(t) {
  clearCompanionAuthorization();
  platform.auth.companionSession = async () => ({ csrf: "nonce", expires: Date.now() + 120_000 });
  const player = new CompanionPlayer(new Video(), { url: "https://media.example/video.mp4", title: "Test", name: "Test", addonName: "Test" }, 0, "en", { state() {}, time() {}, audio() {}, subtitles() {} });
  t.after(() => { player.stop(); globalThis.fetch = originalFetch; platform.auth.companionSession = originalExchange; clearCompanionAuthorization(); });
  return player;
}

test("expired companion cookie is renewed once before retrying a rejected mutation", async (t) => {
  setup(t);
  let exchanges = 0, requests = 0;
  platform.auth.companionSession = async () => ({ csrf: `nonce${++exchanges}`, expires: Date.now() + 120_000 });
  globalThis.fetch = async () => new Response(JSON.stringify(++requests === 1 ? { error: "Reconnect" } : { ok: true }), { status: requests === 1 ? 401 : 200 });
  assert.deepEqual(await companionRequest("/sessions", {}), { ok: true });
  assert.equal(exchanges, 2);
  assert.equal(requests, 2);
});

test("another tab's CSRF nonce is recoverable, but an origin rejection is not retried", async (t) => {
  setup(t);
  let requests = 0;
  globalThis.fetch = async () => new Response(JSON.stringify(++requests === 1 ? { error: "Invalid playback session request." } : { ok: true }), { status: requests === 1 ? 403 : 200 });
  assert.deepEqual(await companionRequest("/sessions", {}), { ok: true });
  assert.equal(requests, 2);
  requests = 0;
  globalThis.fetch = async () => { requests++; return new Response('{"error":"Same-origin access is required."}', { status: 403 }); };
  await assert.rejects(companionRequest("/sessions", {}), /Same-origin/);
  assert.equal(requests, 1);
});

test("a transient heartbeat error does not stop already buffered playback", async (t) => {
  const player = setup(t); player.session = session();
  globalThis.fetch = async () => new Response('{"error":"Temporary proxy outage"}', { status: 502 });
  await player.ping();
  assert.equal(player.failed, false);
  assert.equal(player.element.paused, false);
  assert.equal(player.heartbeatFailures, 1);
  globalThis.fetch = async () => Response.json(session());
  await player.ping();
  assert.equal(player.heartbeatFailures, 0);
  assert.equal(player.failed, false);
});

test("heartbeat calls cannot overlap while a proxy response is pending", async (t) => {
  const player = setup(t); player.session = session();
  let finish, calls = 0;
  globalThis.fetch = () => { calls++; return new Promise((resolve) => { finish = resolve; }); };
  const first = player.ping();
  await new Promise((resolve) => setImmediate(resolve));
  await player.ping();
  assert.equal(calls, 1);
  finish(Response.json(session()));
  await first;
});

test("a network stall restarts the same mode at a backward seek instead of full conversion", async (t) => {
  const player = setup(t); player.session = session(); player.hasPlayed = true; player.resume = 30;
  let body, attachments = 0;
  globalThis.fetch = async (_url, init) => { body = JSON.parse(init.body); return Response.json({ ...session(), offset: body.position, generation: 1 }); };
  player.attach = async () => { attachments++; };
  await player.fallback("stall");
  assert.deepEqual(body, { position: 2 });
  assert.equal(player.session.mode, "remux");
  assert.equal(attachments, 1);
  assert.equal(player.failed, false);
});

test("a paused attachment never starts autoplay", async (t) => {
  const player = setup(t); player.wantsPlayback = false;
  player.element.autoplay = true;
  let plays = 0;
  player.element.play = () => { plays++; return Promise.resolve(); };
  await player.attach("https://media.example/video.mp4", false);
  assert.equal(plays, 0);
  assert.equal(player.element.autoplay, false);
  assert.equal(player.attaching, false);
});

test("a codec callback cannot race a pending seek mutation", async (t) => {
  const player = setup(t); player.session = session();
  let calls = 0, finish;
  globalThis.fetch = () => { calls++; return new Promise((resolve) => { finish = resolve; }); };
  player.attach = async () => {};
  const seek = player.seek(20);
  await new Promise((resolve) => setImmediate(resolve));
  await player.fallback();
  assert.equal(calls, 1);
  finish(Response.json({ ...session(), generation: 1, offset: 20 }));
  await seek;
});

test("a terminal error invalidates a delayed fallback attachment", async (t) => {
  const player = setup(t); player.session = session();
  let finish, attachments = 0;
  globalThis.fetch = (url) => url.endsWith("/stop") ? Promise.resolve(Response.json({})) : new Promise((resolve) => { finish = resolve; });
  player.attach = async () => { attachments++; };
  const pending = player.fallback();
  await new Promise((resolve) => setImmediate(resolve));
  player.finalError("Stop this playback.");
  // A server response can arrive despite cancellation; it must stay inert.
  finish(Response.json(session()));
  await pending;
  assert.equal(attachments, 0);
  assert.equal(player.failed, true);
  assert.equal(player.controller.signal.aborted, true);
});

test("an explicit network error before first companion frame does not request codec recovery", async (t) => {
  const player = setup(t); player.session = session();
  let request;
  globalThis.fetch = async (_url, init) => { request = JSON.parse(init.body); return Response.json(session()); };
  player.attach = async () => {};
  await player.fallback("network");
  assert.equal(request.recover, undefined);
  assert.equal(player.session.mode, "remux");
});

test("a direct transport retry preserves the resume snapshot while media is reloading", async (t) => {
  const player = setup(t); player.hasPlayed = true; player.element.currentTime = 22;
  player.attachedUrl = "https://media.example/video.mp4";
  player.attach = async () => { player.element.currentTime = 0; };
  await player.fallback("network");
  assert.equal(player.currentTime, 22);
});

test("native HLS to MSE keeps original and relative positions", async (t) => {
  const player = setup(t); player.session = { ...session(), offset: 20 };
  player.hasPlayed = true; player.element.currentTime = 7;
  player.attachedHls = true; player.caps.nativeHls = true; player.caps.mse = true;
  let start;
  player.attach = async (_url, _hls, startAt) => { start = startAt; player.element.currentTime = 0; };
  await player.fallback();
  assert.equal(start, 7);
  assert.equal(player.currentTime, 27);
});

test("native refusal of an extensionless HLS link retries HLS before creating a server session", async (t) => {
  const player = setup(t); player.attachedUrl = "https://media.example/play";
  let attachments = [];
  globalThis.fetch = async () => new Response("#EXTM3U", { headers: { "content-type": "application/vnd.apple.mpegurl" } });
  player.attach = async (url, hls) => { attachments.push({ url, hls }); };
  await player.fallback();
  assert.deepEqual(attachments, [{ url: player.attachedUrl, hls: true }]);
  assert.equal(player.session, null);
});

test("new automatic preferences cap full conversion at 1080p but preserve an explicit original setting", (t) => {
  const original = localStorage.getItem;
  t.after(() => { localStorage.getItem = original; });
  localStorage.getItem = () => null;
  assert.deepEqual(readCompanionPreferences(), { mode: "automatic", resolution: "1080" });
  localStorage.getItem = () => JSON.stringify({ mode: "direct", resolution: "original" });
  assert.deepEqual(readCompanionPreferences(), { mode: "direct", resolution: "original" });
});

test("native audio array indexes never replace server track IDs on a file relay", (t) => {
  const player = setup(t); player.session = { ...session(), mode: "relay", probe: { ...session().probe, container: "mov,mp4", audio: [{ index: 1, codec: "aac", language: "eng" }, { index: 2, codec: "aac", language: "fra" }] } };
  let tracks;
  player.callbacks.audio = (value) => { tracks = value; };
  player.syncCompanionAudio();
  player.element.audioTracks = [{ language: "eng", enabled: true }, { language: "fra", enabled: false }];
  player.syncNativeTracks();
  assert.deepEqual(tracks.map((track) => track.id), [1, 2]);
});

test("a paused server seek publishes its original position before metadata arrives", async (t) => {
  const player = setup(t); player.session = session(); player.wantsPlayback = false;
  let observed;
  player.callbacks.time = (position) => { observed = position; };
  globalThis.fetch = async () => Response.json({ ...session(), offset: 12, generation: 1 });
  player.attach = async () => {};
  await player.seek(12);
  assert.equal(observed, 12);
  assert.equal(player.currentTime, 12);
});

test("a failed upstream reader reported by heartbeat retries transport, not codecs", async (t) => {
  const player = setup(t); player.session = session();
  let reason;
  player.fallback = async (value) => { reason = value; };
  globalThis.fetch = async () => Response.json({ ...session(), error: "Source unavailable", errorKind: "source" });
  await player.ping();
  assert.equal(reason, "network");
});
