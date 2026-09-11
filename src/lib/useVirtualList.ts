import { useLayoutEffect, useRef, useState } from "react";

type VirtualState = {
  key: unknown;
  rowSize: number;
  gap: number;
  start: number;
  end: number;
};

export function virtualRange(
  count: number,
  visibleStart: number,
  visibleEnd: number,
  rowSize: number,
  gap: number,
  overscan: number,
) {
  const step = Math.max(1, rowSize + gap);
  const start = Math.max(0, Math.floor(visibleStart / step) - overscan);
  const end = Math.min(
    count,
    Math.max(start, Math.ceil(visibleEnd / step) + overscan),
  );
  return { start, end };
}

export function virtualSpacers(
  count: number,
  start: number,
  end: number,
  rowSize: number,
  gap: number,
) {
  const step = rowSize + gap;
  const totalSize = count ? count * step - gap : 0;
  return {
    beforeSize: start ? Math.max(0, start * step - gap) : 0,
    afterSize: end < count ? Math.max(0, totalSize - end * step) : 0,
  };
}

function scrollsVertically(element: HTMLElement) {
  return /^(auto|scroll|overlay)$/.test(getComputedStyle(element).overflowY);
}

function scrollParent(element: HTMLElement): HTMLElement | Window {
  if (scrollsVertically(element)) return element;
  let parent = element.parentElement;
  while (parent) {
    if (scrollsVertically(parent)) return parent;
    parent = parent.parentElement;
  }
  return window;
}

/**
 * A small responsive-height virtualizer for the vertical episode lists.
 *
 * Rows remain direct grid children, preserving the existing responsive card
 * CSS. Empty spacers represent everything above and below the mounted window,
 * so even a thousand-episode season keeps only a screenful of cards in React.
 */
export function useVirtualList<T>(
  items: T[],
  options: { resetKey: unknown; estimateSize?: number; overscan?: number },
) {
  const { resetKey, estimateSize = 120, overscan = 8 } = options;
  const listRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number | undefined>(undefined);
  const firstEnd = Math.min(items.length, 24);
  const [stored, setStored] = useState<VirtualState>({
    key: resetKey,
    rowSize: estimateSize,
    gap: 0,
    start: 0,
    end: firstEnd,
  });
  const state = Object.is(stored.key, resetKey)
    ? stored
    : {
        key: resetKey,
        rowSize: estimateSize,
        gap: 0,
        start: 0,
        end: firstEnd,
      };

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    let rowSize = state.rowSize;
    let gap = state.gap;

    const update = () => {
      frameRef.current = undefined;
      const root = scrollParent(list);
      const row = list.querySelector<HTMLElement>(":scope > .episode-row");
      const measuredRow = row?.getBoundingClientRect().height;
      if (measuredRow && Number.isFinite(measuredRow)) rowSize = measuredRow;
      const measuredGap = Number.parseFloat(getComputedStyle(list).rowGap);
      gap = Number.isFinite(measuredGap) ? measuredGap : 0;

      let visibleStart = 0;
      let visibleEnd = root === list ? list.clientHeight : window.innerHeight;
      if (root === list) {
        visibleStart = list.scrollTop;
        visibleEnd += visibleStart;
      } else {
        const listBox = list.getBoundingClientRect();
        const rootBox = root === window
          ? { top: 0, bottom: window.innerHeight }
          : (root as HTMLElement).getBoundingClientRect();
        visibleStart = Math.max(0, rootBox.top - listBox.top);
        visibleEnd = Math.max(0, rootBox.bottom - listBox.top);
      }

      const { start, end } = virtualRange(
        items.length,
        visibleStart,
        visibleEnd,
        rowSize,
        gap,
        overscan,
      );
      setStored((current) => {
        if (
          Object.is(current.key, resetKey) &&
          current.rowSize === rowSize &&
          current.gap === gap &&
          current.start === start &&
          current.end === end
        ) {
          return current;
        }
        return { key: resetKey, rowSize, gap, start, end };
      });
    };
    const schedule = () => {
      if (frameRef.current !== undefined) return;
      frameRef.current = window.requestAnimationFrame(update);
    };

    update();
    // Scroll events do not bubble, but a capture listener sees both the
    // desktop list's own scrollport and the mobile detail-page scrollport.
    // This also survives crossing the responsive breakpoint while open.
    document.addEventListener("scroll", schedule, { passive: true, capture: true });
    window.addEventListener("resize", schedule, { passive: true });
    const observer = typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(schedule);
    observer?.observe(list);
    const firstRow = list.querySelector<HTMLElement>(":scope > .episode-row");
    if (firstRow) observer?.observe(firstRow);
    return () => {
      document.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
      observer?.disconnect();
      if (frameRef.current !== undefined) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = undefined;
      }
    };
  }, [estimateSize, items.length, overscan, resetKey]);

  const { beforeSize, afterSize } = virtualSpacers(
    items.length,
    state.start,
    state.end,
    state.rowSize,
    state.gap,
  );

  return {
    listRef,
    visible: items.slice(state.start, state.end),
    beforeSize,
    afterSize,
  };
}
