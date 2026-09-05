import { platform } from "../platform/index.ts";
import type { BrowserCapabilities, CompanionPlayback, PlaybackPreferences } from "./companionPolicy.ts";

const preferenceKey = "nuvio.companion-preferences.v1";
export function readCompanionPreferences(): PlaybackPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(preferenceKey) || "{}") as Partial<PlaybackPreferences>;
    return { mode: saved.mode === "direct" || saved.mode === "compatibility" ? saved.mode : "automatic", resolution: saved.resolution === "1080" || saved.resolution === "720" ? saved.resolution : "original" };
  } catch { return { mode: "automatic", resolution: "original" }; }
}
export function saveCompanionPreferences(value: PlaybackPreferences) { try { localStorage.setItem(preferenceKey, JSON.stringify(value)); } catch { /* Playback remains usable without storage. */ } }

export function browserCapabilities(element: HTMLVideoElement = document.createElement("video")): BrowserCapabilities {
  const nativeHls = !!element.canPlayType("application/vnd.apple.mpegurl");
  const mse = typeof MediaSource !== "undefined";
  const supports = (mime: string) => !!element.canPlayType(mime) && (nativeHls || !mse || MediaSource.isTypeSupported(mime));
  return { nativeHls, mse, hdr: matchMedia("(dynamic-range: high)").matches,
    video: { h264: supports('video/mp4; codecs="avc1.640028"'), hevc: supports('video/mp4; codecs="hvc1.1.6.L120.B0"'), hevc10: supports('video/mp4; codecs="hvc1.2.4.L153.B0"'), av1: supports('video/mp4; codecs="av01.0.08M.08"'), vp9: supports('video/webm; codecs="vp09.00.41.08"'), vp8: supports('video/webm; codecs="vp8"'), dolbyVision: supports('video/mp4; codecs="dvh1.05.06"') },
    audio: { aac: supports('audio/mp4; codecs="mp4a.40.2"'), ac3: supports('audio/mp4; codecs="ac-3"'), eac3: supports('audio/mp4; codecs="ec-3"'), opus: supports('audio/mp4; codecs="opus"'), vorbis: supports('audio/webm; codecs="vorbis"'), flac: supports('audio/mp4; codecs="fLaC"'), dts: supports('audio/mp4; codecs="dtsc"'), truehd: supports('audio/mp4; codecs="mlpa"') } };
}

let authorization: { csrf: string; expires: number } | null = null;
let authFlight: Promise<{ csrf: string; expires: number }> | null = null;
async function authorize() {
  if (authorization && authorization.expires > Date.now() + 60_000) return authorization;
  if (!platform.auth.companionSession) throw new Error("The companion is not available in this player.");
  authFlight ??= platform.auth.companionSession().then((value) => { authorization = value; return value; }).finally(() => { authFlight = null; });
  return authFlight;
}
export async function companionRequest<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const auth = await authorize();
  const response = await fetch(`/api/companion${path}`, {
    method: body === undefined ? "GET" : "POST", credentials: "same-origin",
    headers: { "content-type": "application/json", "x-nuvio-csrf": auth.csrf },
    body: body === undefined ? undefined : JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(35_000)]) : AbortSignal.timeout(35_000),
  });
  if (response.status === 401) authorization = null;
  if (!response.ok) {
    const value = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(value?.error ?? "The companion could not complete playback.");
  }
  return response.json() as Promise<T>;
}
export function stopCompanion(id: string) {
  if (!authorization) return;
  void fetch(`/api/companion/sessions/${id}/stop`, { method: "POST", credentials: "same-origin", keepalive: true, headers: { "x-nuvio-csrf": authorization.csrf } }).catch(() => undefined);
}
export type SafePlaybackDiagnostics = {
  browser: string; pwa: boolean; capabilities: BrowserCapabilities; mode: string;
  startupMs?: number; bufferSeconds?: number; source?: CompanionPlayback["probe"];
  speed?: number; lastError?: string;
};
let latest: SafePlaybackDiagnostics | null = null;
export function setPlaybackDiagnostics(value: SafePlaybackDiagnostics) { latest = value; }
export function playbackDiagnostics() { return latest; }
