import defaults from "../../deployment/defaults.json" with { type: "json" };

function integer(name: string, fallback: number, min: number, max: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}
export const config = {
  port: integer("PORT", 3101, 1, 65535),
  backendUrl: (process.env.NUVIO_SUPABASE_URL || defaults.backendUrl).replace(/\/+$/, ""),
  publishableKey: process.env.NUVIO_SUPABASE_ANON_KEY || defaults.publishableKey,
  allowedUsers: (process.env.COMPANION_ALLOWED_USERS || "").split(",").map((value) => value.trim()).filter(Boolean),
  tempRoot: process.env.TRANSCODE_TEMP_DIR || "/tmp/nuvio-companion",
  maxTranscodes: integer("MAX_TRANSCODES", 2, 1, 16),
  maxSessions: integer("MAX_PLAYBACK_SESSIONS", 8, 1, 64),
  tempLimit: integer("TRANSCODE_TEMP_LIMIT", 1024 * 1024 * 1024, 16 * 1024 * 1024, 16 * 1024 ** 3),
  idleMs: integer("TRANSCODE_IDLE_TIMEOUT", 90, 30, 3600) * 1000,
};

// This value is intentionally sent to the browser; refuse privileged backend keys.
if (config.publishableKey.startsWith("sb_secret_")) throw new Error("Only a public backend key is allowed");
if (config.publishableKey.split(".").length === 3) {
  const claims = JSON.parse(Buffer.from(config.publishableKey.split(".")[1], "base64url").toString()) as { role?: string };
  if (claims.role !== "anon") throw new Error("Only an anonymous/public backend key is allowed");
}
if (new URL(config.backendUrl).protocol !== "https:") throw new Error("The Nuvio backend must use HTTPS");
