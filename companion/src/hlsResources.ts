import { randomBytes } from "node:crypto";
import { HttpError } from "./security.ts";

/** Opaque links reachable from current playlists, plus a short in-flight grace.
 * Rolling live windows retire old links; master/audio playlists and VOD keep
 * their currently referenced children, so pruning cannot break another track.
 */
export class HlsResources extends Map<string, string> {
  private playlists = new Map<string, Set<string>>();
  private seen = new Map<string, number>();
  private idsByUrl = new Map<string, string>();
  private clock: () => number;
  private maximum: number;
  private graceMs: number;
  constructor(clock = Date.now, maximum = 8192, graceMs = 90_000) {
    super(); this.clock = clock; this.maximum = maximum; this.graceMs = graceMs;
  }

  override set(id: string, url: string): this {
    const previous = this.get(id);
    if (previous !== undefined && this.idsByUrl.get(previous) === id) this.idsByUrl.delete(previous);
    super.set(id, url); this.idsByUrl.set(url, id); return this;
  }

  override delete(id: string): boolean {
    const url = this.get(id);
    if (url !== undefined && this.idsByUrl.get(url) === id) this.idsByUrl.delete(url);
    this.seen.delete(id); this.playlists.delete(id);
    return super.delete(id);
  }

  override clear() {
    super.clear(); this.idsByUrl.clear(); this.seen.clear(); this.playlists.clear();
  }

  register(url: string) {
    // VOD manifests can contain thousands of segments. A reverse index avoids
    // an O(n²) scan on every playlist refresh without changing opaque URL rules.
    const existing = this.idsByUrl.get(url);
    if (existing !== undefined) { this.seen.set(existing, this.clock()); return existing; }
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
      this.delete(id);
    }
  }
}
