import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const update = source("../src/lib/appUpdate.ts");
const main = source("../src/main.tsx");
const vite = source("../vite.config.ts");
const guard = source("../public/pwa-update-guard.js");

test("updates download automatically but cannot take over caches before safe activation", () => {
  assert.match(vite, /registerType:\s*"prompt"/);
  assert.match(vite, /skipWaiting:\s*false/);
  assert.match(vite, /pwa-update-guard\.js/);
  assert.match(main, /onNeedRefresh\(\)/);
  assert.match(main, /requestAutomaticUpdate\(\)/);
  assert.match(main, /accountSyncState\(\)\.pending === 0/);
  assert.doesNotMatch(update, /type:\s*"SKIP_WAITING"/);
});

function clientHarness() {
  let playing = false;
  let pending = false;
  let editing = false;
  let reloads = 0;
  let nextTimer = 0;
  const timers = new Map();
  const messages = [];
  const workerListeners = {};
  const documentListeners = {};
  const observers = [];
  const context = {
    navigator: { serviceWorker: { addEventListener: (name, callback) => { workerListeners[name] = callback; } } },
    document: { querySelector: () => playing ? {} : null, activeElement: { matches: () => editing }, documentElement: {}, addEventListener: (name, callback) => { documentListeners[name] = callback; } },
    window: { setTimeout: (callback) => { timers.set(++nextTimer, callback); return nextTimer; }, clearTimeout: (id) => timers.delete(id), addEventListener() {}, location: { reload: () => { reloads++; } } },
    MutationObserver: class { constructor(callback) { observers.push(callback); } observe() {} },
  };
  runInNewContext(stripTypeScriptTypes(update).replace(/^export /gm, ""), context);
  context.initializeUpdateHandling(() => !pending);
  const tick = async () => { const jobs = [...timers.values()]; timers.clear(); jobs.forEach((job) => job()); await Promise.resolve(); await Promise.resolve(); };
  return { context, messages, workerListeners, tick, reloads: () => reloads,
    playing: (value) => { playing = value; observers.forEach((notify) => notify()); },
    pending: (value) => { pending = value; },
    editing: (value) => { editing = value; documentListeners.focusout?.(); },
    waiting: () => context.setRegistration({ waiting: { postMessage: (message) => messages.push(message) } }),
  };
}

test("an idle client automatically requests guarded activation; an open player defers it", async () => {
  const app = clientHarness(); app.playing(true); app.waiting();
  await app.tick(); await app.tick(); assert.equal(app.messages.length, 0);
  app.playing(false); await app.tick(); await app.tick();
  assert.equal(app.messages[0]?.type, "NUVIO_ACTIVATE_WHEN_SAFE");
});

test("reload waits for the last queued progress write, including a write enqueued by cleanup", async () => {
  const app = clientHarness(); app.context.reloadForUpdateWhenSafe();
  await app.tick(); app.pending(true); await app.tick();
  assert.equal(app.reloads(), 0);
  app.pending(false); await app.tick(); await app.tick();
  assert.equal(app.reloads(), 1);
});

test("focused editable fields defer updates until typing focus leaves", async () => {
  const app = clientHarness(); app.editing(true); app.waiting();
  await app.tick(); await app.tick(); assert.equal(app.messages.length, 0);
  app.editing(false); await app.tick(); await app.tick();
  assert.equal(app.messages[0]?.type, "NUVIO_ACTIVATE_WHEN_SAFE");
});

test("an external worker takeover reloads safely even without a Workbox update callback", async () => {
  const app = clientHarness();
  app.workerListeners.controllerchange();
  await app.tick(); assert.equal(app.reloads(), 0); // Initial installation only.
  app.workerListeners.controllerchange();
  await app.tick(); await app.tick(); assert.equal(app.reloads(), 1);
});

test("cross-tab readiness acknowledges neither active playback nor pending writes", async () => {
  const app = clientHarness(); const replies = [];
  const ask = () => app.workerListeners.message({ data: { type: "NUVIO_UPDATE_STATUS_REQUEST", id: "test" }, source: { postMessage: (message) => replies.push(message) } });
  app.playing(true); ask(); await app.tick(); assert.equal(replies.at(-1).safe, false);
  app.playing(false); app.pending(true); ask(); await app.tick(); assert.equal(replies.at(-1).safe, false);
  app.pending(false); ask(); await app.tick(); assert.equal(replies.at(-1).safe, true);
});

function workerHarness(states) {
  const listeners = {};
  const timers = new Map();
  let skipped = 0;
  let timerId = 0;
  let lifetime;
  const notifications = [];
  const clients = states.map((safe, index) => ({ id: String(index), url: "https://watch.example/", postMessage(message) {
    if (safe === undefined) return;
    queueMicrotask(() => listeners.message({ data: { type: "NUVIO_UPDATE_STATUS", id: message.id, safe }, source: { id: String(index) } }));
  } }));
  runInNewContext(guard, { self: { registration: { scope: "https://watch.example/" }, clients: { matchAll: async () => clients }, skipWaiting: async () => { skipped++; }, addEventListener: (name, callback) => { listeners[name] = callback; } },
    setTimeout: (callback) => { timers.set(++timerId, callback); return timerId; }, clearTimeout: (id) => timers.delete(id),
  });
  listeners.message({ data: { type: "NUVIO_ACTIVATE_WHEN_SAFE" }, source: { postMessage: (message) => notifications.push(message) }, waitUntil: (promise) => { lifetime = promise; } });
  return { settle: async () => { for (let turn = 0; turn < 10; turn++) await Promise.resolve(); for (const callback of [...timers.values()]) callback(); await lifetime; }, skipped: () => skipped, notifications };
}

test("the waiting worker activates only when ALL open tabs acknowledge safe idle", { timeout: 5000 }, async () => {
  const ready = workerHarness([true, true]); await ready.settle(); assert.equal(ready.skipped(), 1);
  for (const state of [false, undefined]) {
    const blocked = workerHarness([true, state]); await blocked.settle();
    assert.equal(blocked.skipped(), 0);
    assert.equal(blocked.notifications[0]?.type, "NUVIO_UPDATE_DEFERRED");
  }
});
