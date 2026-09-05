import assert from "node:assert/strict";
import test from "node:test";
import { choosePlaybackMode, type BrowserCapabilities, type MediaProbe } from "../../src/lib/companionPolicy.ts";
import { ffmpegArguments } from "../src/ffmpeg.ts";

const caps: BrowserCapabilities = { nativeHls: false, mse: true, hdr: false, video: { h264: true, hevc: false, hevc10: false, av1: false }, audio: { aac: true, eac3: false, dts: false } };
const media = (container: string, video = "h264", audio = "aac"): MediaProbe => ({ container, video: { index: 0, codec: video }, audio: [{ index: 1, codec: audio }], subtitles: [], duration: 30, seekable: true });
test("compatibility policy chooses relay, stream copy, audio conversion, and video conversion only as needed", () => {
  assert.equal(choosePlaybackMode(media("mov,mp4"), caps), "relay");
  assert.equal(choosePlaybackMode(media("matroska"), caps), "remux");
  assert.equal(choosePlaybackMode(media("matroska", "h264", "eac3"), caps), "audio-transcode");
  assert.equal(choosePlaybackMode(media("matroska", "hevc"), caps), "transcode");
  assert.equal(choosePlaybackMode(media("matroska", "hevc"), { ...caps, video: { hevc: true } }), "remux");
  assert.equal(choosePlaybackMode(media("matroska", "av1"), { ...caps, video: { av1: true } }), "remux");
  const main10 = media("matroska", "hevc", "eac3"); main10.video!.bitDepth = 10;
  assert.equal(choosePlaybackMode(main10, { ...caps, video: { hevc10: true } }), "audio-transcode");
});
test("remux and audio-only commands never use a video encoder or scale filter", () => {
  for (const mode of ["remux", "audio-transcode"] as const) {
    const args = ffmpegArguments({ url: "http://127.0.0.1:1/opaque", directory: "/tmp/test", mode, position: 5, audioIndex: 1, probe: media("matroska"), resolution: "1080" });
    assert.equal(args[args.indexOf("-c:v") + 1], "copy");
    assert.equal(args[args.indexOf("-c:a") + 1], mode === "remux" ? "copy" : "aac");
    assert.ok(!args.includes("-vf")); assert.ok(args.includes("delete_segments+independent_segments+temp_file"));
  }
});
test("HDR tone mapping and downscale are restricted to full conversion", () => {
  const probe = media("matroska", "hevc"); probe.video!.hdr = true;
  const args = ffmpegArguments({ url: "http://127.0.0.1:1/opaque", directory: "/tmp/test", mode: "transcode", position: 0, audioIndex: 1, probe, resolution: "1080" });
  assert.ok(args.some((a) => a.includes("tonemap=hable"))); assert.ok(args.some((a) => a.includes("min(ih,1080)")));
  assert.equal(args[args.indexOf("-preset") + 1], "veryfast");
});
