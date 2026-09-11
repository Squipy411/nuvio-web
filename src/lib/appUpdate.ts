/** Bridges service-worker updates to Settings and safe application reloads. */
let registration: ServiceWorkerRegistration | null = null;
let initialized = false;
let writesAreIdle = () => true;
let reloadPending = false;
let checkTimer: number | undefined;
const playerOpen = () => document.querySelector(".player-view") !== null;
const editing = () => document.activeElement?.matches("input:not([type=button]):not([type=submit]), textarea, [contenteditable]:not([contenteditable=false])") === true;
const safeNow = () => !playerOpen() && !editing() && writesAreIdle();

/** Let React's player cleanup enqueue its final progress write before reloading. */
async function safelyIdle() {
  if (!safeNow()) return false;
  await new Promise<void>((resolve) => window.setTimeout(resolve, 200));
  return safeNow();
}

function scheduleCheck(delay = 0) {
  if (checkTimer !== undefined) window.clearTimeout(checkTimer);
  checkTimer = window.setTimeout(() => {
    checkTimer = undefined;
    void checkWhenSafe();
  }, delay);
}

async function checkWhenSafe() {
  if (!reloadPending && !registration?.waiting) return;
  if (!(await safelyIdle())) {
    if (!playerOpen() && !editing()) scheduleCheck(1000);
    return;
  }
  if (reloadPending) {
    window.location.reload();
    return;
  }
  // The waiting worker polls ALL open tabs before activating. It must not
  // retire the old chunk cache while a different tab is still playing.
  registration?.waiting?.postMessage({ type: "NUVIO_ACTIVATE_WHEN_SAFE" });
}

export function initializeUpdateHandling(accountWritesAreIdle: () => boolean): void {
  writesAreIdle = accountWritesAreIdle;
  if (initialized) return;
  initialized = true;
  let hadController = !!navigator.serviceWorker?.controller;
  // Another tab may have requested activation, which Workbox reports as an
  // external update without invoking this tab's onNeedReload callback.
  navigator.serviceWorker?.addEventListener("controllerchange", () => {
    if (hadController) reloadForUpdateWhenSafe();
    hadController = true;
  });
  navigator.serviceWorker?.addEventListener("message", (event: MessageEvent) => {
    if (event.data?.type === "NUVIO_UPDATE_STATUS_REQUEST" && typeof event.data.id === "string") {
      void safelyIdle().then((safe) => event.source?.postMessage({ type: "NUVIO_UPDATE_STATUS", id: event.data.id, safe }));
    } else if (event.data?.type === "NUVIO_UPDATE_DEFERRED") {
      scheduleCheck(30_000);
    }
  });
  new MutationObserver(() => {
    if ((reloadPending || registration?.waiting) && !playerOpen()) scheduleCheck(250);
  }).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) scheduleCheck(); });
  document.addEventListener("focusout", () => scheduleCheck(250));
  window.addEventListener("focus", () => scheduleCheck());
}

/** Install automatically, but keep the worker waiting until every tab is safe. */
export function requestAutomaticUpdate(): void {
  scheduleCheck();
}

export function setRegistration(value: ServiceWorkerRegistration | null): void {
  registration = value;
  if (value?.waiting) requestAutomaticUpdate();
}

export type UpdateCheck = "pending" | "current" | "unsupported";

/**
 * Asks the browser to re-fetch the worker script now, rather than waiting for
 * its own periodic check. A pending worker can still exist briefly while an
 * automatically installed build waits for open playback and writes to finish.
 */
async function waitForInstallation(active: ServiceWorkerRegistration) {
  const worker = active.installing;
  if (!worker || worker.state === "installed" || worker.state === "redundant")
    return;
  await new Promise<void>((resolve) => {
    const timeout = window.setTimeout(finish, 15_000);
    function finish() {
      window.clearTimeout(timeout);
      worker?.removeEventListener("statechange", onState);
      resolve();
    }
    function onState() {
      if (worker?.state === "installed" || worker?.state === "redundant")
        finish();
    }
    worker.addEventListener("statechange", onState);
  });
}

export async function checkForUpdate(): Promise<UpdateCheck> {
  const active =
    registration ??
    (await navigator.serviceWorker?.getRegistration().catch(() => null)) ??
    null;
  if (!active) return "unsupported";
  registration = active;
  try {
    await active.update();
    await waitForInstallation(active);
  } catch {
    return "unsupported";
  }
  return active.waiting ? "pending" : "current";
}

/**
 * Called after a safely activated worker takes control. Recheck this tab in
 * case playback or a final sync write started during the activation handshake.
 */
export function reloadForUpdateWhenSafe(): void {
  reloadPending = true;
  scheduleCheck();
}

/**
 * Settings recovery follows the same safe activation path. Never use a forced
 * reload timer that can interrupt a different tab's playback or a queued save.
 */
export async function applyUpdate(): Promise<void> {
  try {
    const active =
      registration ??
      (await navigator.serviceWorker?.getRegistration().catch(() => null)) ??
      null;
    setRegistration(active);
    if (active?.waiting) {
      requestAutomaticUpdate();
      return;
    }
  } catch {
    // Reloading the current page still follows the safe local path below.
  }
  reloadForUpdateWhenSafe();
}
