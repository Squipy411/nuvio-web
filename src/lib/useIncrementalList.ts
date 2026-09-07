import { useEffect, useRef, useState } from "react";

/**
 * Keeps exceptionally long card lists bounded and reveals another slice only
 * when their end approaches the viewport. Unlike useProgressiveList, this
 * does not eventually mount the entire collection while the user is idle.
 */
export function useIncrementalList<T>(
  items: T[],
  options: { resetKey: unknown; first?: number; chunk?: number },
) {
  const { resetKey, first = 40, chunk = 40 } = options;
  const [page, setPage] = useState({ key: resetKey, limit: first });
  const sentinelRef = useRef<HTMLDivElement>(null);
  const limit = Object.is(page.key, resetKey) ? page.limit : first;

  useEffect(() => {
    setPage({ key: resetKey, limit: first });
  }, [resetKey, first]);

  useEffect(() => {
    if (limit >= items.length) return;
    const sentinel = sentinelRef.current;
    if (!sentinel || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setPage((current) => ({
          key: resetKey,
          limit: Math.min(
            items.length,
            Object.is(current.key, resetKey) ? current.limit + chunk : first,
          ),
        }));
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [chunk, first, items.length, limit, resetKey]);

  return {
    visible: limit >= items.length ? items : items.slice(0, limit),
    complete: limit >= items.length,
    sentinelRef,
  };
}
