/**
 * Asks the server one small question before the player commits to the file.
 *
 * The decoding player reads the container over range requests, and when that
 * cannot happen it does not fail — it stalls, because there is nothing to
 * decode and no error to raise. Every reason it stalls is a plain HTTP one:
 * the link expired, the host refuses cross-origin reads, the page is https and
 * the source is not. All of them are visible in a single one-byte request, and
 * all of them are worth saying precisely rather than blaming the file.
 */

/**
 * `ranges` is a hint and nothing more.
 *
 * "unknown" is the common answer, not the rare one: a host may answer 200 to a
 * probe range and still serve ranges perfectly, and `Accept-Ranges` is only
 * readable cross-origin when the host chooses to expose it. Nothing may be
 * refused on this — the reader copes without ranges, just more slowly — so it
 * exists only to make a later failure easier to explain.
 */
export type RangeSupport = "yes" | "no" | "unknown";

export type SourceProbe =
  | { ok: true; ranges: RangeSupport }
  | { ok: false; reason: string };

/** What the response says about serving parts of the file. */
export function rangeSupport(
  status: number,
  acceptRanges: string | null,
): RangeSupport {
  if (status === 206) return "yes";
  if (acceptRanges && /bytes/i.test(acceptRanges)) return "yes";
  if (acceptRanges && /none/i.test(acceptRanges)) return "no";
  return "unknown";
}

/**
 * A page on https may not fetch http, and the browser blocks it before the
 * request is made — silently, from the page's point of view.
 */
export function mixedContentProblem(
  pageProtocol: string,
  url: string,
): string | null {
  if (pageProtocol !== "https:") return null;
  if (!/^http:\/\//i.test(url)) return null;
  return "This source is served over plain http:// while Nuvio is on https://, so the browser refuses to load it. Pick another source, or open it in an external player.";
}

/** What an HTTP status means for a stream, in the terms that matter here. */
/**
 * What the reader has actually managed to pull, in plain words.
 *
 * Shown while it works and repeated if it gives up, because the difference
 * between nothing arriving and megabytes arriving slowly is the difference
 * between a blocked request and a file being read the long way round — and
 * from a phone, that difference is otherwise invisible.
 */
export function describeTransfer(
  bytes: number,
  requests: number,
  ranges: RangeSupport,
): string {
  const size =
    bytes >= 1_000_000
      ? `${(bytes / 1_000_000).toFixed(1)} MB`
      : bytes > 0
        ? `${Math.round(bytes / 1000)} kB`
        : "nothing";
  const tries = `${requests} request${requests === 1 ? "" : "s"}`;
  const note =
    ranges === "yes" ? "" : ranges === "no" ? ", no ranges" : ", ranges unknown";
  return `${size} in ${tries}${note}`;
}

export function statusReason(status: number): string {
  if (status === 401 || status === 403)
    return `The host refused this link (${status}). Debrid links expire, so re-fetching the sources usually fixes it.`;
  if (status === 404 || status === 410)
    return `This link is no longer there (${status}). Fetch the sources again and pick a fresh one.`;
  if (status === 429)
    return "The host is rate-limiting this device (429). Wait a moment and try again.";
  if (status >= 500)
    return `The host had an error serving this link (${status}). Try another source.`;
  return `The host answered ${status}, which this player cannot read. Try another source.`;
}

/**
 * A small range, so the answer costs nothing and arrives quickly.
 *
 * A kilobyte rather than the single byte this asked for first: `bytes=0-0` is
 * an edge case some hosts answer 200 to while serving ordinary ranges fine,
 * which made the answer look worse than the truth.
 */
export async function probeSource(
  url: string,
  headers?: Record<string, string>,
  timeoutMs = 15_000,
  fetchImpl: typeof fetch = fetch,
): Promise<SourceProbe> {
  const mixed = mixedContentProblem(
    typeof location === "undefined" ? "https:" : location.protocol,
    url,
  );
  if (mixed) return { ok: false, reason: mixed };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { ...(headers ?? {}), Range: "bytes=0-1023" },
      signal: controller.signal,
    });
    // Nothing here reads the body; letting it stream would download the file.
    void response.body?.cancel().catch(() => undefined);
    if (response.ok || response.status === 206)
      return {
        ok: true,
        ranges: rangeSupport(
          response.status,
          response.headers.get("accept-ranges"),
        ),
      };
    return { ok: false, reason: statusReason(response.status) };
  } catch {
    if (controller.signal.aborted)
      return {
        ok: false,
        reason:
          "The host did not answer in time. It may be slow, or the link may have expired — fetch the sources again, or try an external player.",
      };
    // Which of the network-level refusals this was, established rather than
    // guessed: they all arrive as the same opaque TypeError.
    return {
      ok: false,
      reason: await describeFetchFailure(url, headers, fetchImpl),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Says why a fetch failed, having checked rather than assumed.
 *
 * `fetch` rejects with the same opaque TypeError whether the host refused a
 * cross-origin read, the connection never opened, DNS failed, or something on
 * the device blocked it. Both callers used to answer "CORS" to all of them,
 * because it is the most common — which makes the message a guess presented as
 * a finding, and wrong often enough to be worth not saying.
 *
 * A `no-cors` request settles it. It cannot read the response, but it still
 * makes the request: if it resolves, the host answered and the only thing that
 * stopped the first attempt was the cross-origin policy. If it rejects too,
 * nothing reached the host and the policy is irrelevant.
 */
export async function describeFetchFailure(
  url: string,
  headers?: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    // No Range and no custom headers: `no-cors` forbids anything that is not
    // safelisted, and a request it refuses to send proves nothing.
    const response = await fetchImpl(url, {
      method: "GET",
      mode: "no-cors",
      signal: controller.signal,
      ...(headers ? {} : {}),
    });
    void response.body?.cancel().catch(() => undefined);
    return "This host answers, but does not allow this page to read the file (CORS). No in-browser player can work around that, because the bytes themselves are refused — use an external player, or pick another source.";
  } catch {
    return "The browser could not reach this host at all: the request never got an answer. That is a network, DNS or connection problem rather than a permissions one — check the link is still valid, or try another source.";
  } finally {
    clearTimeout(timer);
  }
}
