import assert from "node:assert/strict";
import test from "node:test";
import {
  activeBrowserSubtitleText,
  chooseBrowserSubtitle,
  isForcedSubtitle,
  parseBrowserSubtitles,
} from "../src/lib/subtitles.ts";

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

test("active cue lookup does not scan from the beginning of a subtitle file", () => {
  const cues = Array.from({ length: 10_000 }, (_, index) => ({
    start: index * 2,
    end: index * 2 + 1.5,
    text: `Cue ${index}`,
  }));
  assert.equal(activeBrowserSubtitleText(cues, 19_998.5), "Cue 9999");
  assert.equal(activeBrowserSubtitleText(cues, 19_999.75), "");
});

test("forced subtitles are identified from language, id, or songs-and-signs labels", () => {
  assert.equal(isForcedSubtitle("regular", "forced"), true);
  assert.equal(isForcedSubtitle("english-forced", "eng"), true);
  assert.equal(isForcedSubtitle("songs-and-signs", "eng"), true);
  assert.equal(isForcedSubtitle("english-full", "eng"), false);
});

test("Off stays off even when a fallback language remains saved", () => {
  const tracks = [{ id: "english-full", lang: "eng" }];
  assert.equal(
    chooseBrowserSubtitle(tracks, "none", "eng", ["en-US"], "eng", true),
    -1,
  );
});

test("forced selection follows the audio-language rule from the official client", () => {
  const tracks = [
    { id: "english-full", lang: "eng" },
    { id: "english-forced", lang: "eng" },
    { id: "spanish-full", lang: "spa" },
  ];
  assert.equal(
    chooseBrowserSubtitle(tracks, "eng", "", ["en"], "eng", true),
    1,
    "matching English audio selects only the English forced track",
  );
  assert.equal(
    chooseBrowserSubtitle(tracks, "spa", "", ["en"], "eng", true),
    2,
    "different-language audio selects the normal preferred subtitle",
  );
});
