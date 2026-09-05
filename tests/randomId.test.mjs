import assert from "node:assert/strict";
import test from "node:test";
import { randomId } from "../src/lib/randomId.ts";

test("worker coordination IDs work without the secure-context-only randomUUID API", () => {
  const source = { getRandomValues(array) { array.fill(171); return array; } };
  assert.equal(randomId(source), "ab".repeat(16));
});
test("worker coordination IDs use 128 bits of browser-provided randomness", () => {
  const first = randomId();
  assert.match(first, /^[a-f0-9]{32}$/);
  assert.notEqual(first, randomId());
});
