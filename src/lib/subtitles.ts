import { languageName } from "./languageName.ts";

export type BrowserSubtitleCue = {
  start: number;
  end: number;
  text: string;
};

function timestampSeconds(value: string): number | null {
  const match = value.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/);
  if (!match) return null;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const milliseconds = Number(match[4].padEnd(3, "0"));
  if (![hours, minutes, seconds, milliseconds].every(Number.isFinite)) return null;
  return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
}

function plainCueText(lines: string[]): string {
  return lines
    .join("\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .trim();
}

/** Parses ordinary WebVTT and SRT into safe cues for video or canvas output. */
export function parseBrowserSubtitles(source: string): BrowserSubtitleCue[] {
  const normalized = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const cues: BrowserSubtitleCue[] = [];
  for (const block of normalized.split(/\n{2,}/)) {
    const lines = block.split("\n").map((line) => line.trimEnd());
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const [startText, endText = ""] = lines[timingIndex].split(/\s+-->\s+/, 2);
    const start = timestampSeconds(startText);
    const end = timestampSeconds(endText);
    const text = plainCueText(lines.slice(timingIndex + 1));
    if (start == null || end == null || end <= start || !text) continue;
    cues.push({ start, end, text });
  }
  return cues.sort((left, right) => left.start - right.start);
}

/**
 * Finds the cue at a playback position without walking the entire subtitle
 * file on every animation frame. Ordinary SRT/WebVTT cues are ordered and do
 * not overlap, so the last cue whose start is not in the future is the only
 * candidate that can be visible.
 */
export function activeBrowserSubtitleText(
  cues: BrowserSubtitleCue[],
  time: number,
): string {
  let low = 0;
  let high = cues.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (cues[middle].start <= time) low = middle + 1;
    else high = middle;
  }
  const cue = cues[low - 1];
  return cue && time < cue.end ? cue.text : "";
}

/** Same conservative forced-track inference used by the native client. */
export function isForcedSubtitle(
  id: string,
  language: string,
  url = "",
): boolean {
  if (language.trim().toLowerCase() === "forced") return true;
  const text = `${id} ${language} ${url}`.toLowerCase();
  return text.includes("forced") || (text.includes("songs") && text.includes("sign"));
}

export type BrowserSubtitleOption = {
  id: string;
  lang: string;
  url?: string;
};

/**
 * Mirrors Nuvio's forced-subtitle selection policy for external browser tracks.
 * A primary preference of Off is final, regardless of a stale fallback value.
 */
export function chooseBrowserSubtitle(
  tracks: BrowserSubtitleOption[],
  preferredLanguage: string,
  secondaryLanguage: string,
  deviceLanguages: readonly string[],
  audioLanguage: string | undefined,
  useForcedSubtitles: boolean,
): number {
  const preferred = preferredLanguage.trim().toLowerCase();
  if (!preferred || preferred === "none") return -1;
  const normalizedAudio = languageName(audioLanguage).toLowerCase();
  if (useForcedSubtitles && !normalizedAudio) return -1;

  const targets = [
    ...(preferred === "forced"
      ? normalizedAudio ? [normalizedAudio] : []
      : preferred === "device"
        ? deviceLanguages
        : [preferred]),
    secondaryLanguage,
  ]
    .map((value) => languageName(value).toLowerCase())
    .filter(Boolean);
  const forcedOnly =
    preferred === "forced" ||
    (useForcedSubtitles && targets[0] === normalizedAudio);
  return tracks.findIndex(
    (track) =>
      targets.includes(languageName(track.lang).toLowerCase()) &&
      isForcedSubtitle(track.id, track.lang, track.url) === forcedOnly,
  );
}
