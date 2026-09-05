import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Locally generated color bars and sine waves; no copyrighted test downloads. */
export async function generateMediaFixtures(directory) {
  await mkdir(directory, { recursive: true });
  const run = (args) => {
    const result = spawnSync(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf8", timeout: 60_000 });
    if (result.status !== 0) throw new Error(`Fixture generation failed: ${result.stderr?.slice(-800)}`);
  };
  run(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000", "-map", "0:v", "-map", "1:a", "-map", "2:a", "-t", "24", "-c:v", "libx264", "-preset", "ultrafast", "-g", "48", "-pix_fmt", "yuv420p", "-c:a", "aac", "-metadata:s:a:0", "language=eng", "-metadata:s:a:1", "language=fra", "-movflags", "+faststart", join(directory, "direct.mp4")]);
  run(["-i", join(directory, "direct.mp4"), "-map", "0", "-c", "copy", join(directory, "remux.mkv")]);
  run(["-i", join(directory, "direct.mp4"), "-map", "0", "-c:v", "copy", "-c:a", "eac3", join(directory, "audio.mkv")]);
  run(["-i", join(directory, "direct.mp4"), "-map", "0:v", "-map", "0:a:0", "-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "log-level=error:pools=1:frame-threads=1", "-c:a", "copy", join(directory, "hevc.mkv")]);
  run(["-i", join(directory, "direct.mp4"), "-map", "0:v", "-map", "0:a:0", "-c:v", "libx265", "-pix_fmt", "yuv420p10le", "-preset", "ultrafast", "-x265-params", "log-level=error:pools=1:frame-threads=1", "-c:a", "eac3", join(directory, "hevc10.mkv")]);
  run(["-i", join(directory, "direct.mp4"), "-map", "0:v", "-map", "0:a:0", "-t", "8", "-c:v", "libaom-av1", "-cpu-used", "8", "-threads", "2", "-c:a", "libopus", join(directory, "av1.webm")]);
  await mkdir(join(directory, "hls"), { recursive: true });
  run(["-i", join(directory, "direct.mp4"), "-map", "0:v", "-map", "0:a:0", "-c", "copy", "-f", "hls", "-hls_time", "2", "-hls_list_size", "0", join(directory, "hls", "index.m3u8")]);
  await writeFile(join(directory, "sample.srt"), "1\n00:00:01,000 --> 00:00:04,000\nGenerated subtitle fixture\n\n2\n00:00:10,000 --> 00:00:15,000\nSeeking works\n");
}
