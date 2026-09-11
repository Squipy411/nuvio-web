import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { authenticate, exchange, revoke, sameOrigin } from "../src/auth.ts";
import { config, parsePublicOrigins } from "../src/config.ts";
import type { safeRequest } from "../src/security.ts";

const request = (headers: IncomingMessage["headers"]): IncomingMessage => ({ headers, socket: { remoteAddress: "proxy-test" } }) as IncomingMessage;
const response = () => {
  const headers = new Map<string, string>();
  return { headers, value: { setHeader: (name: string, value: string) => headers.set(name, value) } as unknown as ServerResponse };
};
const network: typeof safeRequest = async (raw) => {
  const body = Readable.from([Buffer.from(JSON.stringify({ id: "proxy-test-user" }))]) as IncomingMessage;
  body.statusCode = 200;
  return { response: body, url: new URL(raw) };
};

test("public origin configuration canonicalizes exact origins and rejects wildcard/path credentials", () => {
  assert.deepEqual(parsePublicOrigins(" https://watch.example/ , http://192.168.1.10:3075,https://watch.example"), ["https://watch.example", "http://192.168.1.10:3075"]);
  for (const value of ["*", "https://*.example", "https://watch.example/nuvio", "https://user:secret@watch.example", "https://watch.example?x=1", "https://watch.example#x", "file:///tmp"]) {
    assert.throws(() => parsePublicOrigins(value), Error, value);
  }
});

test("same-origin checks preserve LAN access and reject malformed or cross-site browser origins", () => {
  assert.equal(sameOrigin(request({ host: "192.168.1.10:3075", origin: "http://192.168.1.10:3075" })).protocol, "http:");
  for (const origin of [undefined, "null", "https://evil.example", "https://user@watch.example", "https://watch.example/", "https://watch.example?x=1", "https://watch.example#x", "https://watch.example https://evil.example"]) {
    assert.throws(() => sameOrigin(request({ host: "watch.example", origin })), /Same-origin/);
  }
  assert.throws(() => sameOrigin(request({ host: "watch.example", origin: "https://watch.example", "sec-fetch-site": "cross-site" })), /Same-origin/);
});

test("public HTTPS allowlist survives HTTP proxy hops without trusting forwarded headers", () => {
  const previous = config.publicOrigins;
  config.publicOrigins = ["https://watch.example"];
  try {
    const valid = request({ host: "watch.example", origin: "https://watch.example", "x-forwarded-proto": "http", "x-forwarded-host": "evil.example" });
    assert.equal(sameOrigin(valid).origin, "https://watch.example");
    assert.throws(() => sameOrigin(request({ host: "watch.example", origin: "http://watch.example", "x-forwarded-proto": "https" })), /Same-origin/);
    assert.throws(() => sameOrigin(request({ host: "companion:3101", origin: "https://watch.example", "x-forwarded-host": "watch.example", forwarded: "host=watch.example;proto=https" })), /Same-origin/);
    assert.throws(() => sameOrigin(request({ host: "evil.example", origin: "https://evil.example", "x-forwarded-host": "watch.example" })), /Same-origin/);
  } finally { config.publicOrigins = previous; }
});

test("HTTPS proxy auth sets secure private cookie while mutations still require CSRF and exact origin", async () => {
  const previous = config.publicOrigins;
  config.publicOrigins = ["https://watch.example"];
  try {
    const headers = { host: "watch.example", origin: "https://watch.example", authorization: "Bearer proxy-test-only", "x-forwarded-proto": "http" };
    const output = response();
    const auth = await exchange(request(headers), output.value, { backend: config.backendUrl }, network);
    const setCookie = output.headers.get("Set-Cookie")!;
    assert.match(setCookie, /; HttpOnly; SameSite=Strict; Path=\/api\/companion; Max-Age=1800; Secure$/);
    const cookie = setCookie.split(";")[0];
    assert.equal(authenticate(request({ cookie })).owner, "proxy-test-user");
    assert.throws(() => authenticate(request({ ...headers, cookie }), true), /Invalid playback session/);
    assert.throws(() => authenticate(request({ ...headers, origin: "http://watch.example", cookie, "x-nuvio-csrf": auth.csrf }), true), /Same-origin/);
    assert.equal(authenticate(request({ ...headers, cookie, "x-nuvio-csrf": auth.csrf }), true).owner, "proxy-test-user");
    const logout = response();
    revoke(request({ ...headers, cookie, "x-nuvio-csrf": auth.csrf }), logout.value);
    assert.match(logout.headers.get("Set-Cookie")!, /Max-Age=0; Secure$/);
    assert.throws(() => authenticate(request({ cookie })), /Reconnect/);
  } finally { config.publicOrigins = previous; }
});

test("plain LAN HTTP cookie ignores a spoofed forwarded HTTPS protocol", async () => {
  const headers = { host: "192.168.1.10:3075", origin: "http://192.168.1.10:3075", authorization: "Bearer proxy-test-only", "x-forwarded-proto": "https" };
  const output = response();
  const auth = await exchange(request(headers), output.value, { backend: config.backendUrl }, network);
  const cookie = output.headers.get("Set-Cookie")!;
  assert.doesNotMatch(cookie, /; Secure/);
  revoke(request({ ...headers, cookie: cookie.split(";")[0], "x-nuvio-csrf": auth.csrf }), response().value);
});

test("an HTTP reverse-proxy hop authenticates the allowlisted HTTPS browser origin", async () => {
  const previous = config.publicOrigins;
  config.publicOrigins = ["https://watch.example"];
  const server = createServer((req, res) => {
    void exchange(req, res, { backend: config.backendUrl }, network).then((auth) => {
      res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(auth));
    }).catch(() => { res.statusCode = 403; res.end(); });
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const headers = { host: "watch.example", origin: "https://watch.example", authorization: "Bearer proxy-test-only", "x-forwarded-proto": "http" };
    const send = (values: typeof headers) => new Promise<{ status: number; cookie?: string; body: string }>((resolve, reject) => {
      const req = httpRequest(base, { method: "POST", headers: values }, (res) => {
        let body = "";
        res.on("data", (part: Buffer) => { body += part.toString(); });
        res.on("end", () => resolve({ status: res.statusCode!, cookie: res.headers["set-cookie"]?.[0], body }));
        res.on("error", reject);
      });
      req.on("error", reject); req.end();
    });
    const result = await send(headers);
    assert.equal(result.status, 200);
    assert.match(result.cookie!, /; Secure$/);
    const cookie = result.cookie!.split(";")[0];
    const auth = JSON.parse(result.body) as { csrf: string };
    assert.equal((await send({ ...headers, origin: "http://watch.example", "x-forwarded-proto": "https" })).status, 403);
    revoke(request({ ...headers, cookie, "x-nuvio-csrf": auth.csrf }), response().value);
  } finally { server.close(); server.closeAllConnections(); config.publicOrigins = previous; }
});

test("verified same-owner exchanges renew a stable cookie and CSRF token across browser tabs", async () => {
  const headers = { host: "watch.example", origin: "https://watch.example", authorization: "Bearer proxy-test-only" };
  const first = response();
  const firstAuth = await exchange(request(headers), first.value, { backend: config.backendUrl }, network);
  const cookie = first.headers.get("Set-Cookie")!.split(";")[0];
  const second = response();
  const secondAuth = await exchange(request({ ...headers, cookie }), second.value, { backend: config.backendUrl }, network);
  assert.equal(second.headers.get("Set-Cookie")!.split(";")[0], cookie);
  assert.equal(secondAuth.csrf, firstAuth.csrf);
  assert.ok(secondAuth.expires >= firstAuth.expires);
  assert.equal(authenticate(request({ ...headers, cookie, "x-nuvio-csrf": firstAuth.csrf }), true).owner, "proxy-test-user");
  const deniedNetwork: typeof safeRequest = async (raw) => {
    const result = await network(raw); result.response.statusCode = 401; return result;
  };
  await assert.rejects(exchange(request({ ...headers, cookie }), response().value, { backend: config.backendUrl }, deniedNetwork), /could not be verified/);
  revoke(request({ ...headers, cookie, "x-nuvio-csrf": firstAuth.csrf }), response().value);
});

test("changing the verified Nuvio owner rotates the browser session and rejects previous account mutations", async () => {
  const headers = { host: "watch.example", origin: "https://watch.example", authorization: "Bearer proxy-test-only" };
  const first = response();
  const firstAuth = await exchange(request(headers), first.value, { backend: config.backendUrl }, network);
  const oldCookie = first.headers.get("Set-Cookie")!.split(";")[0];
  const otherNetwork: typeof safeRequest = async (raw) => {
    const body = Readable.from([Buffer.from(JSON.stringify({ id: "proxy-other-user" }))]) as IncomingMessage;
    body.statusCode = 200; return { response: body, url: new URL(raw) };
  };
  const second = response();
  const secondAuth = await exchange(request({ ...headers, cookie: oldCookie }), second.value, { backend: config.backendUrl }, otherNetwork);
  const cookie = second.headers.get("Set-Cookie")!.split(";")[0];
  assert.notEqual(cookie, oldCookie);
  assert.notEqual(secondAuth.csrf, firstAuth.csrf);
  assert.throws(() => authenticate(request({ ...headers, cookie: oldCookie, "x-nuvio-csrf": firstAuth.csrf }), true), /Reconnect/);
  assert.throws(() => authenticate(request({ ...headers, cookie, "x-nuvio-csrf": firstAuth.csrf }), true), /Invalid playback session/);
  assert.equal(authenticate(request({ ...headers, cookie, "x-nuvio-csrf": secondAuth.csrf }), true).owner, "proxy-other-user");
  revoke(request({ ...headers, cookie, "x-nuvio-csrf": secondAuth.csrf }), response().value);
});
