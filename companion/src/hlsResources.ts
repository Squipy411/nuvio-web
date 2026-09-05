import { randomBytes } from "node:crypto";
import { HttpError } from "./security.ts";

/** Opaque links reachable from current playlists, plus a short in-flight grace.
 * Rolling live windows retire old links; master/audio playlists and VOD keep
 * their currently referenced children, so pruning cannot break another track.
 */
export class HlsResources extends Map<string, string> {
  private playlists = new Map<string, Set<string>>();
  private seen = new Map<string, number>();
  private clock: () => number;
  private maximum: number;
  private graceMs: number;
  constructor(clock = Date.now, maximum = 8192, graceMs = 90_000) {
    super(); this.clock = clock; this.maximum = maximum; this.graceMs = graceMs;
  }

  register(url: string) {
    for (const [id, value] of this) if (value === url) { this.seen.set(id, this.clock()); return id; }
    if (this.size >= this.maximum) throw new HttpError(413, "Playlist contains too many active resources.");
    const id = randomBytes(24).toString("base64url");
    this.set(id, url); this.seen.set(id, this.clock()); return id;
  }

  updatePlaylist(parent: string, children: Set<string>) {
    this.playlists.set(parent, children);
    this.prune();
  }

  prune() {
    const reachable = new Set<string>();
    const pending = ["root"];
    while (pending.length) {
      const id = pending.pop()!;
      if (reachable.has(id)) continue;
      reachable.add(id);
      for (const child of this.playlists.get(id) ?? []) pending.push(child);
    }
    const cutoff = this.clock() - this.graceMs;
    for (const id of this.keys()) if (!reachable.has(id) && (this.seen.get(id) ?? 0) < cutoff) {
      this.delete(id); this.seen.delete(id); this.playlists.delete(id);
    }
  }
}
