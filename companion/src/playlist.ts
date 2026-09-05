import { HttpError, mediaUrl } from "./security.ts";

/** Every HLS child becomes an opaque session resource, including URI attributes. */
export function rewritePlaylist(text: string, base: string, register: (url: string) => string): string {
  if (!text.trimStart().startsWith("#EXTM3U")) throw new HttpError(415, "Invalid HLS playlist.");
  if (/#EXT-X-(?:SESSION-)?KEY:(?!METHOD=NONE(?:,|\s|$))/i.test(text)) throw new HttpError(415, "Encrypted or DRM-protected playlists are not supported by the companion.");
  if (/#EXT-X-DEFINE|\{\$/.test(text)) throw new HttpError(415, "Variable HLS playlists are not supported by the companion.");
  const resource = (value: string) => register(mediaUrl(new URL(value, base).toString()).toString());
  return text.split(/\r?\n/).map((line) => {
    if (!line.trim()) return line;
    if (!line.startsWith("#")) return resource(line.trim());
    return line.replace(/URI="([^"]+)"/g, (_match, value: string) => `URI="${resource(value)}"`);
  }).join("\n");
}
