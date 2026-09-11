import {
  currentSession,
  loadProgress,
  loadWatchedItems,
  progressDeltaCursor,
  pullProgressDelta,
  pullWatchedDelta,
  watchedDeltaCursor,
} from "./account";
import { platform } from "../platform/index.ts";
import type { ProgressRow, Session, WatchedItem } from "../types";

/**
 * Snapshot-once, then deltas.
 *
 * The first load for a profile takes a full pull and records the log cursor;
 * every load after that asks only for events since that cursor. The cached
 * rows live in IndexedDB, so a returning session starts from disk and reaches
 * the network only for what changed.
 *
 * Anything unexpected falls back to a full snapshot. Correct-but-slow beats a
 * cache that has quietly drifted from the server.
 */
type Cached<T> = { cursor: number; rows: T[]; profileIndex: number };

const key = (name: string, profileIndex: number, session: Session) =>
  `watch-sync:v2:${JSON.stringify([session.backend.url, session.user.id, name, profileIndex])}`;
const flights = new Map<string, { session: Session; promise: Promise<unknown[]> }>();
const revisions = new Map<string, number>();

async function sync<T>(
  name: string,
  profileIndex: number,
  snapshot: () => Promise<T[]>,
  cursorOf: (profileIndex: number) => Promise<number | null>,
  drain: (
    profileIndex: number,
    since: number,
    rows: T[],
  ) => Promise<{ cursor: number; rows: T[] }>,
): Promise<T[]> {
  const session = currentSession();
  if (!session) throw new Error("Sign in first.");
  const storeKey = key(name, profileIndex, session);
  const existing = flights.get(storeKey);
  if (existing?.session === session) return existing.promise as Promise<T[]>;
  const revision = revisions.get(storeKey) ?? 0;
  const assertCurrent = () => {
    if (currentSession() !== session || (revisions.get(storeKey) ?? 0) !== revision)
      throw new Error("The Nuvio session changed while syncing.");
  };
  const run = syncOwned(storeKey, profileIndex, snapshot, cursorOf, drain, assertCurrent);
  flights.set(storeKey, { session, promise: run });
  try {
    return await run;
  } finally {
    if (flights.get(storeKey)?.promise === run) flights.delete(storeKey);
  }
}

async function syncOwned<T>(
  storeKey: string,
  profileIndex: number,
  snapshot: () => Promise<T[]>,
  cursorOf: (profileIndex: number) => Promise<number | null>,
  drain: (profileIndex: number, since: number, rows: T[]) => Promise<{ cursor: number; rows: T[] }>,
  assertCurrent: () => void,
): Promise<T[]> {
  const cached = await platform.storage
    .get<Cached<T>>(storeKey)
    .catch(() => null);
  assertCurrent();

  if (cached && cached.profileIndex === profileIndex &&
      Number.isSafeInteger(cached.cursor) && cached.cursor >= 0 && Array.isArray(cached.rows)) {
    try {
      const next = await drain(profileIndex, cached.cursor, cached.rows);
      assertCurrent();
      await platform.storage
        .set(storeKey, { ...next, profileIndex })
        .catch(() => undefined);
      assertCurrent();
      return next.rows;
    } catch {
      // Fall through to a snapshot rather than serving a stale cache.
    }
  }

  // Cursor first: a write landing during the snapshot is then replayed as a
  // delta instead of falling into the gap between the two calls.
  assertCurrent();
  const cursor = await cursorOf(profileIndex).catch(() => null);
  assertCurrent();
  const rows = await snapshot();
  assertCurrent();
  if (cursor != null)
    await platform.storage
      .set(storeKey, { cursor, rows, profileIndex })
      .catch(() => undefined);
  assertCurrent();
  return rows;
}

export const syncProgress = (profileIndex: number): Promise<ProgressRow[]> =>
  sync(
    "progress",
    profileIndex,
    () => loadProgress(profileIndex),
    progressDeltaCursor,
    async (profile, since, rows) => {
      const result = await pullProgressDelta(profile, since, rows);
      return { cursor: result.cursor, rows: result.rows };
    },
  );

export const syncWatched = (profileIndex: number): Promise<WatchedItem[]> =>
  sync(
    "watched",
    profileIndex,
    () => loadWatchedItems(profileIndex),
    watchedDeltaCursor,
    async (profile, since, rows) => {
      const result = await pullWatchedDelta(profile, since, rows);
      return { cursor: result.cursor, rows: result.items };
    },
  );

/** Drops this account's caches; an in-flight pull may not recreate them. */
export async function clearWatchSyncCache(profileIndex: number) {
  const session = currentSession();
  await Promise.all(
    ["progress", "watched"].flatMap((name) => {
      const keys = [`watch-sync:${name}:${profileIndex}`];
      if (session) keys.push(key(name, profileIndex, session));
      return keys.map((storeKey) => {
        revisions.set(storeKey, (revisions.get(storeKey) ?? 0) + 1);
        flights.delete(storeKey);
        return platform.storage.remove(storeKey).catch(() => undefined);
      });
    }),
  );
}
