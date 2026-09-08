/**
 * The app's own tooltip, in place of the browser's.
 *
 * The native one is drawn by the operating system: it cannot be styled, it
 * arrives after a delay nothing here chooses, and on Windows it is a pale
 * yellow box with a system font in the middle of a dark application. This
 * draws the same text in the app's own surface instead.
 *
 * It reads `title` rather than asking every button to say something new. A
 * hover takes the attribute off the element — which is the only way to stop
 * the browser drawing its own — shows ours, and puts it back on the way out.
 * Nothing in the tree has to know this exists, including anything added later,
 * and where this file is not installed every one of those elements still has
 * an ordinary working tooltip.
 *
 * A `title` is decoration, not an accessible name: it is never the only label
 * on a control here, and removing it while the pointer rests on something
 * changes nothing a screen reader reads.
 */

/** How long the pointer has to rest before anything appears. */
const OPEN_DELAY_MS = 380;
/** Space between the bubble and the cursor when it has to sit above it. */
const GAP = 8;
/** How far below and right of the pointer the bubble sits, as Windows does. */
const CURSOR_X = 14;
const CURSOR_Y = 20;
/** Kept off the very edge of the window. */
const MARGIN = 8;

/**
 * Where a tooltip would be unhelpful or actively wrong.
 *
 * A touch device has no hover: `pointerover` there fires on the tap that also
 * activates the control, so a tooltip would appear at the moment its own
 * explanation stopped being needed and cover what it explained.
 */
function pointerHovers() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(hover: hover) and (pointer: fine)").matches
  );
}

/**
 * Below and to the right of the pointer, which is where a tooltip belongs.
 *
 * Centring one over its target is a web convention and reads as a popover —
 * a thing the page put there — rather than as the pointer's own label. Every
 * desktop platform trails the cursor instead, and this is drawn in place of
 * the platform's, so it goes where the platform's would have.
 *
 * Flipped to the other side of the cursor rather than clamped when there is no
 * room, so it never ends up sitting under the pointer that summoned it, and
 * measured after the text is in because the height depends on the wrap.
 */
export function tooltipPosition(
  cursor: { x: number; y: number },
  bubble: { width: number; height: number },
  view: { width: number; height: number },
) {
  let left = cursor.x + CURSOR_X;
  let top = cursor.y + CURSOR_Y;
  if (left + bubble.width + MARGIN > view.width)
    left = cursor.x - bubble.width - CURSOR_X;
  if (top + bubble.height + MARGIN > view.height)
    top = cursor.y - bubble.height - GAP;
  return {
    left: Math.max(MARGIN, Math.min(left, view.width - bubble.width - MARGIN)),
    top: Math.max(MARGIN, Math.min(top, view.height - bubble.height - MARGIN)),
  };
}

export function installTooltips(): () => void {
  if (typeof document === "undefined") return () => undefined;

  const bubble = document.createElement("div");
  bubble.className = "app-tooltip";
  bubble.setAttribute("role", "tooltip");
  bubble.hidden = true;

  /** The element whose `title` is currently held, and the text taken from it. */
  let host: Element | null = null;
  let held = "";
  let openTimer: number | undefined;
  /**
   * Where the bubble is drawn from.
   *
   * Kept from the last pointer event rather than read from the element, and
   * updated while the pointer rests on the same control, so the tooltip
   * appears where the cursor actually is at the moment it opens.
   */
  let cursor = { x: 0, y: 0 };

  const restore = () => {
    // Put it back exactly as found. React may have re-rendered and written its
    // own `title` in the meantime, in which case leave that one alone.
    if (host && held && !host.getAttribute("title")) host.setAttribute("title", held);
    host = null;
    held = "";
  };

  const hide = () => {
    window.clearTimeout(openTimer);
    openTimer = undefined;
    bubble.hidden = true;
    restore();
  };

  const show = (text: string) => {
    bubble.textContent = text;
    bubble.hidden = false;
    // Placed off-screen first so the measurement is of the real wrapped size
    // rather than of whatever it happened to be for the last target.
    bubble.style.top = "-9999px";
    bubble.style.left = "-9999px";
    const size = bubble.getBoundingClientRect();
    const { top, left } = tooltipPosition(cursor, size, {
      width: window.innerWidth,
      height: window.innerHeight,
    });
    bubble.style.top = `${Math.round(top)}px`;
    bubble.style.left = `${Math.round(left)}px`;
  };

  const open = (element: Element) => {
    if (!pointerHovers()) return;
    const text = element.getAttribute("title")?.trim();
    if (!text) return;
    hide();
    host = element;
    held = text;
    // Off the element for as long as ours is up, or both are drawn.
    element.removeAttribute("title");
    openTimer = window.setTimeout(() => show(text), OPEN_DELAY_MS);
  };

  const trackCursor = (event: Event) => {
    if (event instanceof MouseEvent) cursor = { x: event.clientX, y: event.clientY };
  };

  const onOver = (event: Event) => {
    trackCursor(event);
    const target = event.target;
    if (!(target instanceof Element)) return;
    const next = target.closest("[title]");
    if (!next || next === host) return;
    // Focus arrives with no pointer behind it, so the corner of the control
    // stands in for a cursor that is not there.
    if (!(event instanceof MouseEvent)) {
      const box = next.getBoundingClientRect();
      cursor = { x: box.left, y: box.bottom };
    }
    open(next);
  };

  // The bubble is placed from the cursor, so until it is up the cursor's
  // position has to keep up with it. Once shown it stays put, as the
  // platform's does, rather than sliding around under the pointer.
  const onMove = (event: Event) => {
    if (openTimer !== undefined) trackCursor(event);
  };

  const onOut = (event: Event) => {
    const target = event.target;
    if (!(target instanceof Element) || !host) return;
    // Moving between an element and its own children is not leaving it.
    const related = (event as PointerEvent).relatedTarget;
    if (related instanceof Node && host.contains(related)) return;
    hide();
  };

  // A press means the thing was understood; the explanation can go. Scrolling
  // moves the target out from under a bubble that is positioned in the
  // viewport, so that dismisses it too.
  const onDismiss = () => hide();
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") hide();
  };

  document.body.appendChild(bubble);
  document.addEventListener("pointerover", onOver, true);
  document.addEventListener("pointermove", onMove, true);
  document.addEventListener("pointerout", onOut, true);
  document.addEventListener("pointerdown", onDismiss, true);
  document.addEventListener("focusin", onOver, true);
  document.addEventListener("focusout", onDismiss, true);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("scroll", onDismiss, true);
  window.addEventListener("blur", onDismiss);

  return () => {
    hide();
    document.removeEventListener("pointerover", onOver, true);
    document.removeEventListener("pointermove", onMove, true);
    document.removeEventListener("pointerout", onOut, true);
    document.removeEventListener("pointerdown", onDismiss, true);
    document.removeEventListener("focusin", onOver, true);
    document.removeEventListener("focusout", onDismiss, true);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("scroll", onDismiss, true);
    window.removeEventListener("blur", onDismiss);
    bubble.remove();
  };
}
