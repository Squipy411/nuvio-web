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
/** Space between the target and the bubble. */
const GAP = 8;
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
 * Anchors a tooltip above its target, or below when there is no room.
 *
 * Measured after the text is in, because the height depends on how far it
 * wrapped, and clamped to the window so a control in a corner does not push
 * its own tooltip off the screen.
 */
export function tooltipPosition(
  target: { top: number; bottom: number; left: number; width: number },
  bubble: { width: number; height: number },
  view: { width: number; height: number },
) {
  const above = target.top - bubble.height - GAP;
  const below = target.bottom + GAP;
  const top = above >= MARGIN ? above : Math.min(below, view.height - bubble.height - MARGIN);
  const centred = target.left + target.width / 2 - bubble.width / 2;
  const left = Math.max(
    MARGIN,
    Math.min(centred, view.width - bubble.width - MARGIN),
  );
  return { top, left, placement: above >= MARGIN ? "above" : "below" } as const;
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
    bubble.classList.remove("is-below");
    restore();
  };

  const show = (element: Element, text: string) => {
    bubble.textContent = text;
    bubble.hidden = false;
    // Placed off-screen first so the measurement is of the real wrapped size
    // rather than of whatever it happened to be for the last target.
    bubble.style.top = "-9999px";
    bubble.style.left = "-9999px";
    const box = element.getBoundingClientRect();
    const size = bubble.getBoundingClientRect();
    const { top, left, placement } = tooltipPosition(box, size, {
      width: window.innerWidth,
      height: window.innerHeight,
    });
    bubble.style.top = `${Math.round(top)}px`;
    bubble.style.left = `${Math.round(left)}px`;
    bubble.classList.toggle("is-below", placement === "below");
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
    openTimer = window.setTimeout(() => show(element, text), OPEN_DELAY_MS);
  };

  const onOver = (event: Event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const next = target.closest("[title]");
    if (!next || next === host) return;
    open(next);
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
