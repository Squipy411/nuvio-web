import { HttpError } from "./security.ts";

export function toWebVtt(text: string): string {
  const value = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (value.trimStart().startsWith("WEBVTT")) return value;
  if (/\[Script Info\]|\[Events\]/i.test(value)) {
    const cues = value.split("\n").filter((line) => line.startsWith("Dialogue:"));
    const time = (raw: string) => { const [h, m, s] = raw.trim().split(":"); return `${h.padStart(2, "0")}:${m}:${s.padEnd(6, "0")}`; };
    return "WEBVTT\n\n" + cues.map((line) => {
      const fields = line.slice(9).split(",");
      if (fields.length < 10) return "";
      const content = fields.slice(9).join(",").replace(/\{[^}]*\}/g, "").replace(/\\[Nn]/g, "\n").replace(/<[^>]*>/g, "");
      return `${time(fields[1])} --> ${time(fields[2])}\n${content}\n`;
    }).join("\n");
  }
  if (!/\d{2}:\d{2}:\d{2}[,.]\d{3}\s+-->/.test(value)) throw new HttpError(415, "This subtitle format is not supported. Choose WebVTT, SRT, or text ASS/SSA.");
  return "WEBVTT\n\n" + value.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
}
