import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import ipaddr from "ipaddr.js";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export function publicAddress(address: string): boolean {
  try {
    let ip = ipaddr.parse(address);
    if (ip.kind() === "ipv6" && (ip as ipaddr.IPv6).isIPv4MappedAddress()) ip = (ip as ipaddr.IPv6).toIPv4Address();
    return ip.range() === "unicast";
  } catch { return false; }
}
export function mediaUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new HttpError(400, "Invalid media address."); }
  if (raw.length > 8192 || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || /[\r\n\0]/.test(raw)) throw new HttpError(400, "Only ordinary HTTP(S) media is supported.");
  return url;
}
const allowedHeaders = new Set(["user-agent", "referer", "origin", "authorization", "cookie", "accept", "accept-language"]);
export function upstreamHeaders(input: Record<string, string> = {}): Record<string, string> {
  const output: Record<string, string> = {};
  let size = 0;
  for (const [name, value] of Object.entries(input)) {
    size += name.length + value.length;
    if (size > 8192 || /[\r\n\0]/.test(name + value)) throw new HttpError(400, "Invalid upstream headers.");
    if (!allowedHeaders.has(name.toLowerCase())) throw new HttpError(400, "An unsupported upstream header was requested.");
    output[name.toLowerCase()] = value;
  }
  return output;
}
export type NetOptions = { headers?: Record<string, string>; method?: string; body?: string; signal?: AbortSignal; timeoutMs?: number; redirects?: number };
/** DNS answers are validated, then pinned into the actual socket lookup. */
export async function safeRequest(raw: string, options: NetOptions = {}): Promise<{ response: http.IncomingMessage; url: URL }> {
  const url = mediaUrl(raw);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  options.signal?.throwIfAborted();
  let dnsTimer: ReturnType<typeof setTimeout> | undefined;
  const addresses = await Promise.race([
    dns.lookup(hostname, { all: true }),
    new Promise<never>((_resolve, reject) => { dnsTimer = setTimeout(() => reject(new HttpError(504, "The media host could not be resolved in time.")), 5000); }),
  ]).finally(() => clearTimeout(dnsTimer));
  options.signal?.throwIfAborted();
  if (!addresses.length || addresses.some((entry) => !publicAddress(entry.address))) throw new HttpError(403, "Private or reserved network destinations are blocked.");
  const pin = addresses[0];
  const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).request(url, {
      method: options.method ?? "GET", headers: { ...options.headers, "accept-encoding": "identity" },
      agent: false, maxHeaderSize: 16_384, family: pin.family,
      lookup: (_hostname, _options, callback) => callback(null, pin.address, pin.family),
      signal: options.signal,
    }, resolve);
    request.setTimeout(options.timeoutMs ?? 20_000, () => request.destroy(new HttpError(504, "The upstream media host timed out.")));
    request.on("error", reject);
    if (options.body) request.write(options.body);
    request.end();
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
    response.destroy();
    if ((options.redirects ?? 0) >= 4 || !response.headers.location) throw new HttpError(502, "Too many upstream redirects.");
    const next = mediaUrl(new URL(response.headers.location, url).toString());
    const headers = { ...options.headers };
    // Never send one provider's authentication to a redirect on another origin.
    if (next.origin !== url.origin) {
      for (const key of Object.keys(headers)) if (["authorization", "cookie"].includes(key.toLowerCase())) delete headers[key];
    }
    return safeRequest(next.toString(), { ...options, headers, redirects: (options.redirects ?? 0) + 1 });
  }
  return { response, url };
}
export async function readLimited(stream: Readable, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const raw of stream) {
    const chunk = Buffer.from(raw); bytes += chunk.length;
    if (bytes > limit) { stream.destroy(); throw new HttpError(413, "Response exceeds the allowed size."); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export function safeLog(event: string, details: Record<string, string | number | boolean | undefined> = {}) {
  // Call sites only supply generated ids, enum values, counts and measured numbers.
  console.info(JSON.stringify({ time: new Date().toISOString(), event, ...details }));
}
