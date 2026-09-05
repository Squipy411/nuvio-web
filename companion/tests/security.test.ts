import assert from "node:assert/strict";
import test from "node:test";
import { publicAddress, mediaUrl, upstreamHeaders, safeRequest } from "../src/security.ts";
import { rewritePlaylist } from "../src/playlist.ts";
import { toWebVtt } from "../src/subtitles.ts";

test("SSRF blocks private, reserved, link-local, multicast, mapped IPv6 and metadata destinations", () => {
  for (const address of ["0.0.0.0", "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.0.1", "169.254.169.254", "100.64.0.1", "224.0.0.1", "::1", "::", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2001:db8::1"]) assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress("1.1.1.1"), true);
  assert.equal(publicAddress("2606:4700:4700::1111"), true);
});
test("the real network reader refuses alternate numeric loopback URLs", async () => {
  for (const url of ["http://2130706433/", "http://0x7f000001/", "http://127.1/", "http://[::ffff:127.0.0.1]/"]) await assert.rejects(safeRequest(url), /Private or reserved/);
});
test("URLs and headers cannot inject protocols, userinfo, CRLF or hop-by-hop headers", () => {
  for (const url of ["file:///etc/passwd", "concat:http://a|http://b", "http://u:p@a/", "http://a/#bad", "http://a/\n"]) assert.throws(() => mediaUrl(url));
  assert.throws(() => upstreamHeaders({ Host: "localhost" }));
  assert.throws(() => upstreamHeaders({ authorization: "a\r\nHost: local" }));
  assert.deepEqual(upstreamHeaders({ Referer: "https://media.example/" }), { referer: "https://media.example/" });
});
test("all HLS references become opaque resources and encrypted playlists fail closed", () => {
  const registered: string[] = [];
  const value = rewritePlaylist('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio.m3u8"\nsegment.m4s\n', "https://video.example/main/index.m3u8", (url) => { registered.push(url); return `/safe/${registered.length}`; });
  assert.equal(registered.length, 3); assert.ok(!value.includes("video.example"));
  assert.throws(() => rewritePlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"', "https://video.example/", String), /Encrypted/);
  assert.throws(() => rewritePlaylist('#EXTM3U\nfile:///etc/passwd', "https://video.example/", String));
});
test("SRT and text ASS convert to timestamped WebVTT, image subtitles are rejected", () => {
  assert.match(toWebVtt("1\n00:00:01,000 --> 00:00:03,000\nHello\n"), /WEBVTT\n\n1\n00:00:01.000/);
  assert.match(toWebVtt("[Events]\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\b1}Hello\\Nworld"), /Hello\nworld/);
  assert.throws(() => toWebVtt("PGS binary"), /format is not supported/);
});
