import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import type { MediaProbe, PlaybackMode, PlaybackPreferences } from "../../src/lib/companionPolicy.ts";
import { HttpError } from "./security.ts";
import { INPUT_FORMATS } from "./probe.ts";

export function ffmpegArguments(input: { url: string; directory: string; mode: PlaybackMode; position: number; audioIndex: number; probe: MediaProbe; resolution: PlaybackPreferences["resolution"] }): string[] {
  const videoTranscode = input.mode === "transcode";
  const audioTranscode = videoTranscode || input.mode === "audio-transcode";
  if (videoTranscode && input.probe.video?.dolbyVision && !input.probe.video.hdr) throw new HttpError(415, "This Dolby Vision profile cannot be safely converted to SDR. Use a compatible source or external player.");
  // Build a useful initial buffer without letting a fast remux run away from a
  // viewer and delete unread segments. The rolling window stays larger than the burst.
  const args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-protocol_whitelist", "http,tcp", "-format_whitelist", INPUT_FORMATS, "-rw_timeout", "15000000", "-analyzeduration", "5000000", "-probesize", "5000000", "-readrate", "1", "-readrate_initial_burst", "20"];
  if (input.position > 0) args.push("-ss", input.position.toFixed(3));
  args.push("-i", input.url);
  if (input.probe.video) args.push("-map", `0:${input.probe.video.index}`);
  if (input.audioIndex >= 0) args.push("-map", `0:${input.audioIndex}`);
  args.push("-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1");
  if (videoTranscode) {
    const filters: string[] = [];
    if (input.probe.video?.hdr) filters.push("zscale=t=linear:npl=100", "format=gbrpf32le", "zscale=p=bt709", "tonemap=tonemap=hable:desat=0", "zscale=t=bt709:m=bt709:r=tv");
    if (input.resolution !== "original") filters.push(`scale=w=-2:h='min(ih,${input.resolution})':force_divisible_by=2`);
    filters.push("format=yuv420p");
    args.push("-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-crf", "22", "-threads", "2", "-vf", filters.join(","), "-force_key_frames", "expr:gte(t,n_forced*2)", "-sc_threshold", "0");
  } else args.push("-c:v", "copy");
  if (audioTranscode) args.push("-c:a", "aac", "-b:a", "192k", "-ac", "2", "-ar", "48000");
  else args.push("-c:a", "copy");
  if (input.probe.video?.codec === "hevc" && !videoTranscode) args.push("-tag:v", "hvc1");
  args.push("-max_muxing_queue_size", "1024", "-avoid_negative_ts", "make_zero", "-f", "hls", "-hls_segment_type", "fmp4", "-hls_time", "2", "-hls_list_size", "24", "-hls_delete_threshold", "2", "-hls_flags", "delete_segments+independent_segments+temp_file", "-hls_fmp4_init_filename", "init.mp4", "-hls_segment_filename", join(input.directory, "segment-%06d.m4s"), "-progress", "pipe:1", join(input.directory, "index.m3u8"));
  return args;
}
export function startFfmpeg(args: string[], callbacks: { speed(value: number): void; failed(): void }): ChildProcess {
  const child = spawn(process.env.FFMPEG_PATH || "ffmpeg", args, { stdio: ["ignore", "pipe", "ignore"] });
  child.stdout!.on("data", (data: Buffer) => { const speed = /speed=\s*([\d.]+)x/.exec(data.toString()); if (speed) callbacks.speed(Number(speed[1])); });
  child.on("error", () => callbacks.failed());
  child.on("exit", (code, signal) => { if (code !== 0 && !signal) callbacks.failed(); });
  return child;
}
export async function stopProcess(child?: ChildProcess) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const kill = setTimeout(() => child.kill("SIGKILL"), 2000);
    child.once("close", () => { clearTimeout(kill); resolve(); });
    child.kill("SIGCONT");
    child.kill("SIGTERM");
  });
}
