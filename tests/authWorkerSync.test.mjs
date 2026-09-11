import assert from "node:assert/strict";
import test from "node:test";
import { deferred, loadTypedModule, tick } from "./helpers/loadTypedModule.mjs";

const backend = { url: "https://api.example.test", key: "public-test-key", selfHosted: false };
const tokens = (id, count = 1) => ({ access_token: `test-access-${id}-${count}`, refresh_token: `test-refresh-${id}-${count}`, user: { id } });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

function workerFixture() {
  const store = new Map();
  const pending = new Map();
  const notifications = [];
  const calls = [];
  let listener, broadcastListener, nextId = 0;
  let server = async (url) => url.includes("grant_type=password") ? json(tokens("a")) : json([]);
  loadTypedModule(new URL("../src/workers/authWorker.ts", import.meta.url), {
    "../lib/idb": {
      getValue: async (key) => store.get(key),
      setValue: async (key, value) => { store.set(key, value); },
      deleteValue: async (key) => { store.delete(key); },
    },
    "../lib/randomId.ts": { randomId: () => "test-worker" },
  }, {
    navigator: {}, // No Web Locks, matching a plain-HTTP LAN deployment.
    BroadcastChannel: class {
      addEventListener(_event, callback) { broadcastListener = callback; }
      postMessage() {}
    },
    self: {
      location: { origin: "http://nuvio.example.test" },
      addEventListener(_event, callback) { listener = callback; },
      postMessage(message) {
        if (!message.id) { notifications.push(message); return; }
        const entry = pending.get(message.id);
        pending.delete(message.id);
        if (message.ok) entry.resolve(message.value);
        else entry.reject(new Error(message.error));
      },
    },
    fetch: async (url, init) => { calls.push({ url, init }); return server(url, init); },
  });
  const command = (type, extra = {}) => {
    const id = ++nextId;
    const reply = deferred();
    pending.set(id, reply);
    listener({ data: { id, type, ...extra } });
    return reply.promise;
  };
  return {
    store, notifications, calls, command,
    signIn: () => command("signIn", { backend, email: "test@example.test", password: "test-only" }),
    request: () => command("request", { path: "/rest/v1/rpc/test", init: { method: "POST", body: "{}" } }),
    setServer: (next) => { server = next; },
    invalidate: () => broadcastListener({ data: { type: "invalidate", source: "another-worker" } }),
  };
}

test("LAN HTTP sign-ins are serialized even without Web Locks", async () => {
  const f = workerFixture();
  const gate = deferred();
  let count = 0;
  f.setServer(async () => { count += 1; return count === 1 ? gate.promise : json(tokens("b")); });
  const a = f.signIn();
  const b = f.signIn();
  await tick();
  assert.equal(count, 1);
  gate.resolve(json(tokens("a")));
  assert.equal((await a).user.id, "a");
  assert.equal((await b).user.id, "b");
  assert.equal(f.store.get("refresh-session").user.id, "b");
});

test("a late old-account 401 cannot refresh the newly signed-in account", async () => {
  const f = workerFixture();
  await f.signIn();
  const gate = deferred();
  f.setServer(async (url) => url.includes("grant_type=password") ? json(tokens("b")) : gate.promise);
  const request = f.request();
  const rejected = assert.rejects(request, /session changed/);
  await tick();
  await f.signIn();
  gate.resolve(json({ message: "expired" }, 401));
  await rejected;
  assert.equal(f.calls.filter((call) => call.url.includes("grant_type=refresh_token")).length, 0);
  assert.equal(f.store.get("refresh-session").user.id, "b");
});

test("refresh rejection cannot erase a newer queued sign-in", async () => {
  const f = workerFixture();
  await f.signIn();
  const gate = deferred();
  f.setServer(async (url) => {
    if (url.includes("grant_type=password")) return json(tokens("b"));
    if (url.includes("grant_type=refresh_token")) return gate.promise;
    return json({ message: "expired" }, 401);
  });
  const request = f.request();
  const rejected = assert.rejects(request, /expired/);
  await tick();
  const newSession = f.signIn();
  gate.resolve(json({ message: "expired" }, 400));
  await rejected;
  assert.equal((await newSession).user.id, "b");
  assert.equal(f.store.get("refresh-session").user.id, "b");
});

test("late parallel 401s reuse the already refreshed token", async () => {
  const f = workerFixture();
  await f.signIn();
  let oldRequests = 0, refreshes = 0;
  const late = deferred();
  f.setServer(async (url, init) => {
    if (url.includes("grant_type=refresh_token")) { refreshes += 1; return json(tokens("a", 2)); }
    if (init.headers.get("authorization") === "Bearer test-access-a-1") {
      oldRequests += 1;
      return oldRequests === 1 ? json({}, 401) : late.promise;
    }
    return json({ saved: true });
  });
  const first = f.request();
  const second = f.request();
  await first;
  late.resolve(json({}, 401));
  await second;
  assert.equal(refreshes, 1);
});

test("refresh never adopts a different user's persisted session", async () => {
  const f = workerFixture();
  await f.signIn();
  f.store.set("refresh-session", { backend, user: { id: "b" }, refreshToken: "test-refresh-b-1" });
  f.setServer(async () => json({}, 401));
  await assert.rejects(f.request(), /saved Nuvio session has expired/);
  assert.equal(f.calls.filter((call) => call.url.includes("grant_type=refresh_token")).length, 0);
  assert.equal(f.store.get("refresh-session").user.id, "b");
  assert.equal(f.notifications.at(-1).type, "sessionLost");
});

test("cross-tab invalidation tells the window to stop showing the old account", async () => {
  const f = workerFixture();
  await f.signIn();
  f.invalidate();
  assert.equal(f.notifications.at(-1).type, "sessionLost");
  await assert.rejects(f.request(), /Sign in first/);
});

test("switching account aborts an in-flight companion exchange and rejects its late reply", async () => {
  const f = workerFixture();
  await f.signIn();
  const gate = deferred();
  let exchangeSignal;
  f.setServer(async (url, init) => {
    if (url.includes("/api/companion/auth")) { exchangeSignal = init.signal; return gate.promise; }
    return json(tokens("b"));
  });
  const exchange = f.command("companionSession");
  const rejected = assert.rejects(exchange, /session changed/);
  await tick();
  assert.equal(exchangeSignal.aborted, false);
  await f.signIn();
  assert.equal(exchangeSignal.aborted, true);
  // Model a response that finished just as cancellation was delivered.
  gate.resolve(json({ csrf: "stale-nonce", expires: Date.now() + 60000 }));
  await rejected;
});

test("a slow companion logout cannot erase a subsequent sign-in", async () => {
  const f = workerFixture();
  await f.signIn();
  const gate = deferred();
  f.setServer(async (url) => {
    if (url.endsWith("/api/companion/auth")) return json({ csrf: "test-nonce", expires: Date.now() + 60000 });
    if (url.endsWith("/api/companion/logout")) return gate.promise;
    if (url.includes("grant_type=password")) return json(tokens("b"));
    return json({});
  });
  await f.command("companionSession");
  const signOut = f.command("signOut");
  await tick();
  const signIn = f.signIn();
  await tick();
  assert.equal(f.store.get("refresh-session").user.id, "a");
  gate.resolve(json({}));
  await signOut;
  assert.equal((await signIn).user.id, "b");
  assert.equal(f.store.get("refresh-session").user.id, "b");
  const revoked = f.calls.find((call) => call.url.includes("/auth/v1/logout"));
  assert.equal(revoked.init.headers.get("authorization"), "Bearer test-access-a-1");
});
