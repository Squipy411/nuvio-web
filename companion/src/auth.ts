import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "./config.ts";
import { HttpError, readLimited, safeRequest } from "./security.ts";

type BrowserSession = { owner: string; csrf: string; expires: number };
const sessions = new Map<string, BrowserSession>();
const attempts = new Map<string, { count: number; until: number }>();
export const opaqueId = () => randomBytes(24).toString("base64url");
function browserSessionId(request: IncomingMessage) {
  return request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("nuvio_companion="))?.slice("nuvio_companion=".length);
}
export function sameOrigin(request: IncomingMessage) {
  try {
    const value = request.headers.origin;
    if (typeof value !== "string") throw new Error();
    const origin = new URL(value);
    // The edge must preserve Host. Never infer browser origin from spoofable
    // Forwarded/X-Forwarded-* headers or from the private HTTP proxy hop.
    if (!["http:", "https:"].includes(origin.protocol) || value !== origin.origin || origin.host !== request.headers.host || request.headers["sec-fetch-site"] === "cross-site") throw new Error();
    if (config.publicOrigins.length && !config.publicOrigins.includes(origin.origin)) throw new Error();
    return origin;
  } catch { throw new HttpError(403, "Same-origin access is required."); }
}
export function rateLimit(key: string, maximum = 20) {
  const now = Date.now();
  for (const [id, item] of attempts) if (item.until < now) attempts.delete(id);
  if (attempts.size > 2000) throw new HttpError(429, "Too many requests. Try again shortly.");
  const entry = attempts.get(key) ?? { count: 0, until: now + 60_000 };
  entry.count++; attempts.set(key, entry);
  if (entry.count > maximum) throw new HttpError(429, "Too many requests. Try again shortly.");
}
export async function exchange(request: IncomingMessage, response: ServerResponse, input: { backend: string }, network: typeof safeRequest = safeRequest) {
  const origin = sameOrigin(request); rateLimit(`auth:${request.socket.remoteAddress}`);
  if (input.backend.replace(/\/+$/, "") !== config.backendUrl) throw new HttpError(403, "This companion is configured for a different Nuvio backend.");
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ") || authorization.length > 16_384) throw new HttpError(401, "Sign into Nuvio first.");
  const result = await network(`${config.backendUrl}/auth/v1/user`, { headers: { authorization, apikey: config.publishableKey }, signal: AbortSignal.timeout(10_000) });
  if (result.response.statusCode !== 200) { result.response.destroy(); throw new HttpError(401, "Your Nuvio session could not be verified."); }
  const user = JSON.parse((await readLimited(result.response, 64_000)).toString()) as { id?: unknown };
  if (typeof user.id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(user.id)) throw new HttpError(401, "Nuvio returned an invalid user.");
  if (config.allowedUsers.length && !config.allowedUsers.includes(user.id)) throw new HttpError(403, "This Nuvio account is not enabled on this companion.");
  for (const [key, session] of sessions) if (session.expires < Date.now()) sessions.delete(key);
  const previousId = browserSessionId(request);
  const previous = previousId ? sessions.get(previousId) : undefined;
  // Cookies are shared across tabs. Rotating the cookie/CSRF on every verified
  // exchange would invalidate other tabs and race with long-playback renewal.
  // Reuse only after verifying the current Nuvio token belongs to the SAME owner.
  const reuse = previous?.owner === user.id;
  if (previousId && previous && !reuse) sessions.delete(previousId);
  if (!reuse && sessions.size >= 512) throw new HttpError(503, "Too many active browser sessions.");
  const id = reuse ? previousId! : opaqueId();
  const session = reuse ? previous! : { owner: user.id, csrf: opaqueId(), expires: 0 };
  session.expires = Date.now() + 30 * 60_000;
  sessions.set(id, session);
  response.setHeader("Set-Cookie", `nuvio_companion=${id}; HttpOnly; SameSite=Strict; Path=/api/companion; Max-Age=1800${origin.protocol === "https:" ? "; Secure" : ""}`);
  return { csrf: session.csrf, expires: session.expires };
}
export function authenticate(request: IncomingMessage, mutation = false) {
  const id = browserSessionId(request);
  const session = id ? sessions.get(id) : null;
  if (!session || session.expires < Date.now()) throw new HttpError(401, "Reconnect the companion using your Nuvio session.");
  if (mutation) {
    sameOrigin(request);
    if (request.headers["x-nuvio-csrf"] !== session.csrf) throw new HttpError(403, "Invalid playback session request.");
    rateLimit(`user:${session.owner}`, 120);
  }
  return session;
}
export function revoke(request: IncomingMessage, response: ServerResponse) {
  const owner = authenticate(request, true).owner;
  for (const [id, session] of sessions) if (session.owner === owner) sessions.delete(id);
  response.setHeader("Set-Cookie", `nuvio_companion=; HttpOnly; SameSite=Strict; Path=/api/companion; Max-Age=0${sameOrigin(request).protocol === "https:" ? "; Secure" : ""}`);
  return owner;
}
