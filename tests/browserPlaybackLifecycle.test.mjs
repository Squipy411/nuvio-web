import assert from 'node:assert/strict';
import test from 'node:test';
import { MediabunnyPlayer } from '../src/lib/mediabunnyPlayer.ts';
import { readFileSync } from 'node:fs';

const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
const player = () => new MediabunnyPlayer('https://example.test/file.mkv', {}, () => {});

test('silent video has an advancing wall clock rather than waiting forever for audio', () => {
  const p = player();
  p.playing = true;
  p.startedFrom = 10;
  p.contextStartTime = performance.now() / 1000 - 2;
  assert.ok(p.currentTime >= 12);
  p.pause();
  const paused = p.currentTime;
  assert.equal(p.currentTime, paused);
});

test('stopped startup cannot continue into another stage', async () => {
  const p = player();
  const pending = deferred();
  const stage = p.stage('Testing', () => pending.promise);
  p.stop();
  pending.resolve('late');
  await assert.rejects(stage, /canceled/);
  let ran = false;
  await assert.rejects(p.stage('Next', async () => { ran = true; }), /canceled/);
  assert.equal(ran, false);
});

test('startup timeout disposes input resources', async () => {
  const p = player();
  let disposed = false;
  p.input = { dispose() { disposed = true; } };
  await assert.rejects(p.stage('Testing', () => new Promise(() => {}), 1), /Gave up/);
  assert.equal(disposed, true);
});

test('late audio resume cannot revive stopped playback', async () => {
  const p = player();
  const pending = deferred();
  p.context = { state: 'suspended', resume: () => pending.promise, close: async () => {} };
  let started = false;
  p.run = () => { started = true; };
  const play = p.play();
  p.stop();
  p.context.state = 'running';
  pending.resolve();
  await play;
  assert.equal(started, false);
  assert.equal(p.paused, true);
});

test('old seek frame cannot paint over a newer seek', async () => {
  const p = player();
  const pending = deferred();
  const drawn = [];
  p.videoSink = { getCanvas: time => time === 1 ? pending.promise : Promise.resolve({ timestamp: time }) };
  p.draw = frame => drawn.push(frame.timestamp);
  const old = p.seek(1);
  await p.seek(2);
  pending.resolve({ timestamp: 1 });
  await old;
  assert.deepEqual(drawn, [2]);
});

test('a seek with no still frame keeps playing rather than failing', async () => {
  // The still drawn at a seek destination is a courtesy. Throwing when one
  // cannot be produced ended playback — and a resumed episode seeks to its
  // saved position first, so the same file played or died depending on where
  // it was left. That is what made it work one time and not the next.
  // Whether frames decode at all is the decode loop's business, and it
  // reports for itself.
  const p = player();
  p.videoSink = { getCanvas: async () => null };
  await assert.doesNotReject(p.seek(0));
});

test("iOS takes the native path, because the canvas one cannot have audio", () => {
  // The canvas engine decodes audio through WebCodecs, and iOS has no
  // AudioDecoder at all — every codec probes false and the file plays silent
  // however playable it is. Choosing that engine there is choosing silence.
  const player = readFileSync(
    new URL("../src/components/Player.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    player,
    /typeof AudioDecoder === "undefined"/,
    "the absence of WebCodecs audio has to be what decides it",
  );
  assert.match(
    player,
    /isAppleWebKit\(\) && noWebCodecsAudio/,
    "and it must route to the native player rather than warn about it",
  );
});

test("an open-ended range answered with 200 is not a refusal", () => {
  // bytes=0- answered with the whole body is legal, common, and exactly the
  // bytes asked for. Rejecting it turned away hosts that seek perfectly well
  // — on the first request, so the whole file went with it.
  const source = readFileSync(
    new URL("../src/lib/nativeMkvPlayer.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /\/\^bytes=0-\/i/, "a range starting at zero is fine");
  assert.match(
    source,
    /response\.status === 200 && !startsAtZero/,
    "only a later offset answered with the whole file is a real problem",
  );
});

test("an automatic native attempt falls back rather than ending playback", () => {
  // iOS is routed to the native path because the canvas one cannot have audio
  // there. If the host will not serve that path, the device is no worse off
  // than it was: the canvas plays the video silently, which is what it did
  // before the routing existed. A dead screen would be worse than no sound.
  // An explicitly chosen native player still fails visibly — that is the
  // answer to what was asked.
  const player = readFileSync(
    new URL("../src/components/Player.tsx", import.meta.url),
    "utf8",
  );
  assert.match(player, /if \(chosenNative\) \{\s*setError\(said\);/, "a chosen path fails loudly");
  assert.match(player, /setNativeRefused\(true\)/, "an automatic one steps aside");
  assert.match(
    player,
    /!nativeRefused && \(chosenNative \|\|/,
    "and the retry must not take the same path again",
  );
});

test("a clock with nothing behind it says so", () => {
  // The engine keeps its own time, so a file that parses but never decodes
  // looks like it is playing: right duration, advancing position, moving
  // scrubber, black picture, no sound. Nothing fails, so nothing was reported
  // — and that is the exact state this player was in on iOS while appearing
  // to work. It has to be able to notice.
  const engine = readFileSync(
    new URL("../src/lib/mediabunnyPlayer.ts", import.meta.url),
    "utf8",
  );
  assert.match(engine, /hasRendered\(\): boolean/, "the engine must know if it drew");
  assert.match(engine, /this\.drawn \+= 1/, "and count frames that reached the canvas");
  const player = readFileSync(
    new URL("../src/components/Player.tsx", import.meta.url),
    "utf8",
  );
  assert.match(player, /engine\.hasRendered\(\)/, "the player must ask");
  assert.match(
    player,
    /engine\.decoderSummary\(\)/,
    "and quote what the browser said about its decoders, since that is the evidence",
  );
});
