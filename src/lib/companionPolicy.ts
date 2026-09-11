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
  errorKind?: "source" | "conversion";
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
  const videoKey = ["hevc", "h264"].includes(video?.codec ?? "") && (video?.bitDepth ?? 8) > 8 ? `${video?.codec}${video?.bitDepth}` : video?.codec ?? "";
  const videoOk = !video || (!!caps.video[videoKey] && (!video.dolbyVision || !!caps.video.dolbyVision));
  const audioOk = !audio || !!caps.audio[audio.codec];
  const needsHls = previous.includes("relay") || /matroska|avi|mpegts|ogg/.test(probe.container) || !audioOk || previous.includes("remux");
  // A browser's WebM support does not imply these tracks can be copied into our
  // fMP4 output. Skip known-impossible muxes, while leaving playable files alone.
  const copyVideoOk = !video || !["vp8", "theora"].includes(video.codec);
  const copyAudioOk = !audio || !["vorbis", "pcm_s16le", "pcm_s24le", "pcm_f32le"].includes(audio.codec);
  if (preference === "compatibility" || !videoOk || needsHls && !copyVideoOk || previous.includes("audio-transcode")) return "transcode";
  // Browser codec declarations can be optimistic (notably multichannel audio).
  // Try inexpensive audio normalization before re-encoding an otherwise valid video.
  if (!audioOk || needsHls && !copyAudioOk || previous.includes("remux")) return "audio-transcode";
  if (needsHls) return "remux";
  return "relay";
}
