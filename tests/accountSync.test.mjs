import assert from "node:assert/strict";
import test from "node:test";
import { createSessionWriteQueue } from "../src/lib/sessionWriteQueue.ts";
import { deferred, loadTypedModule, tick } from "./helpers/loadTypedModule.mjs";

const sessionFor = (id = "account-a", url = "https://api.example.test") => ({
  user: { id }, backend: { url, key: "public-test-key", selfHosted: false },
});

function watchFixture() {
  let session = sessionFor();
  const store = new Map();
  const calls = [];
  const api = {
    currentSession: () => session,
    loadProgress: async () => { calls.push("snapshot"); return [{ contentId: session.user.id }]; },
    progressDeltaCursor: async () => { calls.push("cursor"); return 7; },
    pullProgressDelta: async (_profile, cursor, rows) => {
      calls.push(["delta", cursor]); return { cursor: cursor + 1, rows };
    },
    loadWatchedItems: async () => [], watchedDeltaCursor: async () => 0,
    pullWatchedDelta: async (_profile, cursor, items) => ({ cursor, items }),
  };
  const sync = loadTypedModule(new URL("../src/lib/watchSync.ts", import.meta.url), {
    "./account": api,
    "../platform/index.ts": { platform: { storage: {
      get: async (key) => store.get(key) ?? null,
      set: async (key, value) => { store.set(key, value); },
      remove: async (key) => { store.delete(key); },
    } } },
  });
  return { sync, api, store, calls, setSession: (next) => { session = next; } };
}

test("watch snapshots read the cursor first, then return only deltas", async () => {
  const f = watchFixture();
  await f.sync.syncProgress(1);
  await f.sync.syncProgress(1);
  assert.deepEqual(f.calls, ["cursor", "snapshot", ["delta", 7]]);
});

test("watch caches are isolated by account, backend and profile", async () => {
  const f = watchFixture();
  f.store.set("watch-sync:progress:1", { profileIndex: 1, cursor: 9999, rows: [{ contentId: "legacy-other-user" }] });
  assert.equal((await f.sync.syncProgress(1))[0].contentId, "account-a");
  f.setSession(sessionFor("account-b"));
  assert.equal((await f.sync.syncProgress(1))[0].contentId, "account-b");
  f.setSession(sessionFor("account-b", "https://other.example.test"));
  await f.sync.syncProgress(1);
  await f.sync.syncProgress(2);
  assert.equal(f.calls.filter((call) => call === "snapshot").length, 4);
  assert.equal(f.calls.some(Array.isArray), false);
});

test("simultaneous refreshes share one pull instead of racing stored cursors", async () => {
  const f = watchFixture();
  const gate = deferred();
  f.api.loadProgress = async () => { f.calls.push("snapshot"); return gate.promise; };
  const first = f.sync.syncProgress(1);
  const second = f.sync.syncProgress(1);
  await tick();
  gate.resolve([{ contentId: "shared" }]);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.equal(f.calls.filter((call) => call === "snapshot").length, 1);
});

test("a sign-out during a pull rejects the old result and does not cache it", async () => {
  const f = watchFixture();
  const gate = deferred();
  f.api.loadProgress = async () => gate.promise;
  const pending = f.sync.syncProgress(1);
  const rejected = assert.rejects(pending, /session changed/);
  await tick();
  f.setSession(null);
  gate.resolve([{ contentId: "old" }]);
  await rejected;
  assert.equal(f.store.size, 0);
});

test("clearing a cache also invalidates a pull already in flight", async () => {
  const f = watchFixture();
  const gate = deferred();
  f.api.loadProgress = async () => gate.promise;
  const pending = f.sync.syncProgress(1);
  const rejected = assert.rejects(pending, /session changed/);
  await tick();
  await f.sync.clearWatchSyncCache(1);
  gate.resolve([{ contentId: "old" }]);
  await rejected;
  assert.equal(f.store.size, 0);
});

test("failed deltas fall back to a fresh snapshot", async () => {
  const f = watchFixture();
  await f.sync.syncProgress(1);
  f.api.pullProgressDelta = async () => { throw new Error("expired cursor"); };
  f.api.loadProgress = async () => [{ contentId: "fresh" }];
  assert.equal((await f.sync.syncProgress(1))[0].contentId, "fresh");
});

test("ordered writes cannot overtake final progress or a reset", async () => {
  const session = sessionFor();
  const queue = createSessionWriteQueue(() => session);
  const gate = deferred();
  const written = [];
  const first = queue.run("watch", async () => { await gate.promise; written.push(10); });
  const last = queue.run("watch", async () => { written.push(90); });
  const reset = queue.run("watch", async () => { written.push("clear"); });
  await tick();
  assert.deepEqual(written, []);
  assert.equal(queue.state().pending, 3);
  gate.resolve();
  await Promise.all([first, last, reset]);
  assert.deepEqual(written, [10, 90, "clear"]);
  assert.equal(queue.state().pending, 0);
  assert.equal(queue.state().revision, 6);
});

test("failed writes do not prevent later saves", async () => {
  const queue = createSessionWriteQueue(() => "session");
  const first = queue.run("watch", async () => { throw new Error("offline"); });
  const next = queue.run("watch", async () => "saved");
  await assert.rejects(first, /offline/);
  assert.equal(await next, "saved");
});

test("queued writes never run after a different account signs in", async () => {
  let session = sessionFor();
  const queue = createSessionWriteQueue(() => session);
  const gate = deferred();
  let secondRan = false;
  const first = queue.run("watch", async () => gate.promise);
  const next = queue.run("watch", async () => { secondRan = true; });
  const rejects = Promise.all([assert.rejects(first, /session changed/), assert.rejects(next, /session changed/)]);
  await tick();
  session = sessionFor("account-b");
  gate.resolve();
  await rejects;
  assert.equal(secondRan, false);
});

async function accountFixture() {
  const requests = [];
  const auth = {
    onSessionLost: () => {}, signIn: async () => sessionFor(), signOut: async () => {},
    request: async (path, init) => { requests.push({ path, body: JSON.parse(init.body) }); return []; },
  };
  const account = loadTypedModule(new URL("../src/lib/account.ts", import.meta.url), {
    "../platform/index.ts": { platform: { auth, storage: { set: async () => {} } } },
    "./runtimeBackend.ts": {}, "./settingsBlob": {}, "./providerCredentials": {},
    "./sessionWriteQueue.ts": { createSessionWriteQueue },
  }, {
    localStorage: { getItem: () => "nuvio-web-test-identity" },
    matchMedia: () => ({ matches: false }), navigator: { userAgent: "test desktop" },
  });
  await account.signIn(sessionFor().backend, "user@example.test", "not-a-real-password");
  return { account, auth, requests };
}

test("older progress rows without server keys remain distinct on an empty delta", async () => {
  const { account } = await accountFixture();
  const rows = [{ contentId: "movie-a" }, { contentId: "movie-b" }, { contentId: "show", season: 1, episode: 2 }];
  const result = await account.pullProgressDelta(1, 1, rows);
  assert.equal(result.rows.length, 3);
});

test("non-advancing delta pages fail once instead of looping forever", async () => {
  const { account, auth } = await accountFixture();
  let calls = 0;
  auth.request = async () => { calls += 1; return Array.from({ length: 900 }, () => ({ event_id: 10 })); };
  await assert.rejects(account.pullProgressDelta(1, 10, []), /cursor did not advance/);
  assert.equal(calls, 1);
});

test("progress writes preserve official keys, completion and ordering", async () => {
  const { account, requests, auth } = await accountFixture();
  const gate = deferred();
  let requestCount = 0;
  const request = auth.request;
  auth.request = async (...args) => { requestCount += 1; if (requestCount === 1) await gate.promise; return request(...args); };
  const identity = { contentId: "show", contentType: "series", videoId: "show:1:2", season: 1, episode: 2 };
  const rows = [{ ...identity, progressKey: "server-key", lastWatched: 10 }];
  const first = account.pushProgress(2, identity, 12000, 100000, false, rows);
  const end = account.pushProgress(2, identity, 95000, 100000, true, rows);
  await tick();
  assert.equal(requestCount, 1);
  gate.resolve();
  await Promise.all([first, end]);
  assert.equal(requests[0].body.p_entries[0].position, 12000);
  assert.equal(requests[1].body.p_entries[0].position, 100000);
  assert.equal(requests[1].body.p_entries[0].progress_key, "server-key");
  assert.equal(requests[1].body.p_profile_id, 2);
});

test("non-finite player clock values never corrupt remote progress", async () => {
  const { account, requests } = await accountFixture();
  assert.equal(await account.pushProgress(1, { contentId: "movie" }, NaN, Infinity, false, []), false);
  assert.equal(requests.length, 0);
});

for (const kind of ["settings", "addons"]) {
  test(`queued ${kind} count as pending and cannot be replayed into another login`, async () => {
    const { account, auth } = await accountFixture();
    const gate = deferred();
    let calls = 0;
    auth.request = async () => { calls += 1; return calls === 1 ? gate.promise : []; };
    const push = kind === "settings"
      ? () => account.pushSettingsBlob(2, { originalFeature: { futureField: "keep" } })
      : () => account.saveAddons(2, [{ url: "https://addon.example.test/manifest.json", enabled: true }]);
    const first = push();
    const second = push();
    const rejections = Promise.all([assert.rejects(first, /session changed/), assert.rejects(second, /session changed/)]);
    assert.equal(account.accountSyncState().pending, 2);
    await tick();
    assert.equal(calls, 1);
    await account.signOut();
    auth.signIn = async () => sessionFor("account-b");
    await account.signIn(sessionFor().backend, "new@example.test", "test-only");
    gate.resolve([]);
    await rejections;
    assert.equal(calls, 1, "old queued payload must never reach the new user's account");
    assert.equal(account.accountSyncState().pending, 0);
    await push();
    assert.equal(calls, 2, "a fresh edit from the new account is still usable");
  });
}

test("settings and addon queues preserve official payloads and later edit order", async () => {
  const { account, requests } = await accountFixture();
  const first = { unknownFutureFeature: { version: 42 }, chosen: "first" };
  const last = { ...first, chosen: "last" };
  await Promise.all([account.pushSettingsBlob(2, first), account.pushSettingsBlob(2, last)]);
  assert.equal(requests[0].body.p_settings_json.chosen, "first");
  assert.equal(requests[1].body.p_settings_json.chosen, "last");
  assert.equal(requests[1].body.p_settings_json.unknownFutureFeature.version, 42);
  assert.equal(requests[1].body.p_platform, "desktop");
  assert.equal(requests[1].body.p_profile_id, 2);
  await account.saveAddons(1, [{ url: "https://addons.example.test/config/manifest.json", name: "Fixture", enabled: true }]);
  assert.deepEqual(requests[2].body.p_addons, [{ url: "https://addons.example.test/config/manifest.json", name: "Fixture", enabled: true, sort_order: 0 }]);
});

test("an old profile save blocks app updates but not another profile's fresh rows", async () => {
  const { account, auth } = await accountFixture();
  const gate = deferred();
  auth.request = async () => gate.promise;
  const saved = account.pushProgress(1, { contentId: "movie", videoId: "movie", contentType: "movie" }, 12000, 100000, false, []);
  assert.equal(account.accountSyncState().pending, 1);
  assert.equal(account.accountSyncState(1).pending, 1);
  assert.equal(account.accountSyncState(2).pending, 0);
  const newProfileRevision = account.accountSyncState(2).revision;
  gate.resolve([]);
  await saved;
  assert.equal(account.accountSyncState().pending, 0);
  assert.equal(account.accountSyncState(2).revision, newProfileRevision);
});
