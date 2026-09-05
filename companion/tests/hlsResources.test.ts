import assert from "node:assert/strict";
import test from "node:test";
import { HlsResources } from "../src/hlsResources.ts";

test("rolling live HLS retires stale links across more than eight hours", () => {
  let now = 100_000;
  const resources = new HlsResources(() => now);
  resources.set("root", "https://media.example/live.m3u8");
  let previous = "";
  for (let segment = 0; segment < 15_000; segment++) {
    now += 2000;
    const id = resources.register(`https://media.example/segment-${segment}.ts`);
    resources.updatePlaylist("root", new Set([id]));
    if (previous) assert.ok(resources.has(previous), "in-flight requests retain their grace window");
    previous = id;
  }
  assert.ok(resources.size < 50, `live resource memory must stay bounded, got ${resources.size}`);
});
test("master, audio, video and VOD playlist references survive pruning", () => {
  let now = 100_000;
  const resources = new HlsResources(() => now);
  resources.set("root", "https://media.example/master.m3u8");
  const audio = resources.register("https://media.example/audio.m3u8");
  const video = resources.register("https://media.example/video.m3u8");
  const audioSegment = resources.register("https://media.example/audio.aac");
  const init = resources.register("https://media.example/init.mp4");
  resources.updatePlaylist("root", new Set([audio, video]));
  resources.updatePlaylist(audio, new Set([audioSegment]));
  resources.updatePlaylist(video, new Set([init]));
  now += 120_000; resources.prune();
  for (const id of [audio, video, audioSegment, init]) assert.ok(resources.has(id));
  resources.updatePlaylist("root", new Set([video]));
  assert.equal(resources.has(audioSegment), false);
  assert.ok(resources.has(init));
});
test("a single oversized active playlist still fails at the resource cap", () => {
  const resources = new HlsResources(Date.now, 3);
  resources.set("root", "https://media.example/list.m3u8");
  const first = resources.register("https://media.example/1.ts");
  const second = resources.register("https://media.example/2.ts");
  resources.updatePlaylist("root", new Set([first, second]));
  assert.throws(() => resources.register("https://media.example/3.ts"), /too many active/);
});
