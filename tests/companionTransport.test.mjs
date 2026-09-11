import assert from "node:assert/strict";
import test from "node:test";
import { clearCompanionAuthorization, companionAuthorization, peekCompanionAuthorization } from "../src/lib/companionAuthState.ts";
import { CompanionHttpError, isHlsSource, isTransientCompanionError, shouldEscalateStall } from "../src/lib/companionTransport.ts";

test("HLS is recognized from addon filename, redirected URL, or MIME without provider-specific rules", () => {
  assert.equal(isHlsSource("https://cdn.example/play?id=42", "video.m3u8"), true);
  assert.equal(isHlsSource("https://cdn.example/file.M3U8?token=private"), true);
  assert.equal(isHlsSource("https://cdn.example/play", "", "application/vnd.apple.mpegurl; charset=utf-8"), true);
  assert.equal(isHlsSource("https://cdn.example/movie.mkv"), false);
});

test("a proven playable stream does not climb the encode ladder on a network stall", () => {
  assert.equal(shouldEscalateStall(true), false);
  assert.equal(shouldEscalateStall(true, 2), false);
  assert.equal(shouldEscalateStall(true, 3), true);
  assert.equal(shouldEscalateStall(false), true);
});

test("temporary proxy errors are retryable; permission and format failures are not", () => {
  for (const status of [408, 429, 502, 503, 504, 522, 524]) assert.equal(isTransientCompanionError(new CompanionHttpError("Temporary", status)), true);
  for (const status of [401, 403, 404, 415]) assert.equal(isTransientCompanionError(new CompanionHttpError("Denied", status)), false);
  assert.equal(isTransientCompanionError(new TypeError("Failed to fetch")), true);
  assert.equal(isTransientCompanionError(new DOMException("Stopped", "AbortError")), false);
});

test("parallel companion requests share one token-free authorization exchange", async () => {
  clearCompanionAuthorization();
  let calls = 0;
  const exchange = async () => { calls++; return { csrf: "nonce", expires: Date.now() + 120_000 }; };
  const [left, right] = await Promise.all([companionAuthorization(exchange), companionAuthorization(exchange)]);
  assert.equal(calls, 1);
  assert.equal(left, right);
  assert.equal(await companionAuthorization(exchange), left);
  clearCompanionAuthorization();
});

test("an old-account exchange cannot repopulate authorization after sign-out", async () => {
  clearCompanionAuthorization();
  let finish;
  const old = companionAuthorization(() => new Promise((resolve) => { finish = resolve; }));
  clearCompanionAuthorization();
  finish({ csrf: "old", expires: Date.now() + 120_000 });
  await assert.rejects(old, /account changed/);
  assert.equal(peekCompanionAuthorization(), null);
});
