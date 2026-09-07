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
