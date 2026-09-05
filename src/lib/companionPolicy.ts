/** Shared, pure policy. Browser support is measured by the requesting device. */
export type PlaybackMode = "direct" | "native-hls" | "hls-js" | "relay" | "remux" | "audio-transcode" | "transcode";
export type BrowserCapabilities = {
  nativeHls: boolean;
  mse: boolean;
  video: Record<string, boolean>;
  audio: Record<string, boolean>;
  hdr: boolean;
};
export type MediaTrack = {
  index: number; codec: string; profile?: string; language?: string; title?: string;
  channels?: number; width?: number; height?: number; bitDepth?: number;
  frameRate?: number; hdr?: boolean; dolbyVision?: boolean; default?: boolean;
};
export type MediaProbe = {
  container: string; duration: number; video?: MediaTrack;
  audio: MediaTrack[]; subtitles: MediaTrack[];
  seekable: boolean; contentType?: string; contentLength?: number; acceptRanges?: string;
};
export type PlaybackPreferences = {
  mode: "automatic" | "direct" | "compatibility";
  resolution: "original" | "1080" | "720";
};
export type CompanionPlayback = {
  id: string; url: string; mode: PlaybackMode; offset: number; generation: number;
  probe: MediaProbe; audioIndex: number; speed?: number; error?: string;
};
export function choosePlaybackMode(
  probe: MediaProbe,
  caps: BrowserCapabilities,
  audioIndex?: number,
  previous: PlaybackMode[] = [],
  preference: PlaybackPreferences["mode"] = "automatic",
): PlaybackMode {
  const video = probe.video;
  const audio = probe.audio.find((track) => track.index === audioIndex) ?? probe.audio[0];
  const videoKey = video?.codec === "hevc" && (video.bitDepth ?? 8) > 8 ? "hevc10" : video?.codec ?? "";
  const videoOk = !video || (!!caps.video[videoKey] && (!video.dolbyVision || !!caps.video.dolbyVision));
  const audioOk = !audio || !!caps.audio[audio.codec];
  if (preference === "compatibility" || !videoOk || previous.includes("audio-transcode") || previous.includes("remux") && audioOk) return "transcode";
  if (!audioOk || previous.includes("remux")) return "audio-transcode";
  if (previous.includes("relay") || /matroska|avi|mpegts|ogg/.test(probe.container)) return "remux";
  return "relay";
}
