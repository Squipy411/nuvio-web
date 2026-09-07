import assert from "node:assert/strict";
import test from "node:test";
import { parseBrowserSubtitles } from "../src/lib/subtitles.ts";

test("browser subtitles parse both SRT and WebVTT timestamps", () => {
  assert.deepEqual(
    parseBrowserSubtitles("1\r\n00:00:01,250 --> 00:00:03,500\r\nHello <i>there</i>\r\n"),
    [{ start: 1.25, end: 3.5, text: "Hello there" }],
  );
  assert.deepEqual(
    parseBrowserSubtitles("WEBVTT\n\ncue-one\n01:02.100 --> 01:04.900 align:center\nFirst<br>Second"),
    [{ start: 62.1, end: 64.9, text: "First\nSecond" }],
  );
});

test("metadata and malformed blocks are ignored safely", () => {
  assert.deepEqual(
    parseBrowserSubtitles("WEBVTT\n\nNOTE hello\nnot a cue\n\n00:02.000 --> nope\nNo end"),
    [],
  );
});
