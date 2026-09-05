import { spawn } from "node:child_process";
import type { MediaProbe, MediaTrack } from "../../src/lib/companionPolicy.ts";
import { HttpError } from "./security.ts";

type ProbeStream = { index: number; codec_type?: string; codec_name?: string; profile?: string; bits_per_raw_sample?: string; pix_fmt?: string; width?: number; height?: number; channels?: number; avg_frame_rate?: string; color_transfer?: string; tags?: { language?: string; title?: string }; disposition?: { default?: number }; side_data_list?: Array<{ side_data_type?: string }> };
export function mapProbe(data: { format?: { format_name?: string; duration?: string }; streams?: ProbeStream[] }): MediaProbe {
  const map = (s: ProbeStream): MediaTrack => {
    const rate = s.avg_frame_rate?.split("/").map(Number) ?? [];
    return { index: s.index, codec: s.codec_name ?? "unknown", profile: s.profile,
      language: s.tags?.language, title: s.tags?.title?.replace(/[\x00-\x1f]/g, "").slice(0, 120),
      channels: s.channels, width: s.width, height: s.height,
      bitDepth: Number(s.bits_per_raw_sample) || (/10/.test(s.pix_fmt ?? "") ? 10 : 8),
      frameRate: rate[1] ? rate[0] / rate[1] : undefined,
      hdr: ["smpte2084", "arib-std-b67"].includes(s.color_transfer ?? ""),
      dolbyVision: s.side_data_list?.some((item) => /DOVI/i.test(item.side_data_type ?? "")),
      default: s.disposition?.default === 1 };
  };
  return { container: data.format?.format_name ?? "unknown", duration: Math.max(0, Number(data.format?.duration) || 0),
    video: data.streams?.find((s) => s.codec_type === "video") ? map(data.streams.find((s) => s.codec_type === "video")!) : undefined,
    audio: (data.streams ?? []).filter((s) => s.codec_type === "audio").map(map),
    subtitles: (data.streams ?? []).filter((s) => s.codec_type === "subtitle").map(map), seekable: false };
}
export const INPUT_FORMATS = "mov,matroska,webm,mpegts,hls,mp3,aac,ogg,avi,flac,wav";
export async function probeMedia(localUrl: string, signal: AbortSignal): Promise<MediaProbe> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.FFPROBE_PATH || "ffprobe", ["-v", "error", "-protocol_whitelist", "http,tcp", "-format_whitelist", INPUT_FORMATS, "-rw_timeout", "15000000", "-analyzeduration", "5000000", "-probesize", "5000000", "-show_format", "-show_streams", "-of", "json", localUrl], { stdio: ["ignore", "pipe", "ignore"], signal });
    let output = ""; const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.stdout.on("data", (data: Buffer) => { output += data.toString(); if (output.length > 1_000_000) child.kill("SIGKILL"); });
    child.on("error", () => { clearTimeout(timeout); reject(new HttpError(502, "Media inspection could not start.")); });
    child.on("close", (code) => { clearTimeout(timeout); if (code !== 0) return reject(new HttpError(415, "The source could not be inspected. It may be unreachable, encrypted, or an unsupported format."));
      try { const result = mapProbe(JSON.parse(output)); if (!result.video && !result.audio.length) throw new Error(); resolve(result); }
      catch { reject(new HttpError(415, "The source contains no readable media tracks.")); }
    });
  });
}
