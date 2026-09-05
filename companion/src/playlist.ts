import { HttpError, mediaUrl } from "./security.ts";

/** Keep FFmpeg's media-extension checks enabled without exposing provider paths.
 * MPEG-TS is also an accepted HLS suffix for AAC/fMP4 in FFmpeg, so extensionless
 * provider endpoints use that media hint. Routing still uses only the opaque ID.
 */
export function readerSuffix(url: string) {
  return /\.(m3u8|ts|m4s|mp4|m4a|aac|mp3|vtt|webvtt|cmfv|cmfa)$/i.exec(new URL(url).pathname)?.[0].toLowerCase() ?? ".ts";
}

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
