/** Bridges service-worker updates to Settings and safe application reloads. */
let registration: ServiceWorkerRegistration | null = null;
let reloadObserver: MutationObserver | null = null;

export function setRegistration(value: ServiceWorkerRegistration | null): void {
  registration = value;
}

export type UpdateCheck = "pending" | "current" | "unsupported";

/**
 * Asks the browser to re-fetch the worker script now, rather than waiting for
 * its own periodic check. A pending worker can still exist briefly while an
 * automatically installed build is taking control.
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
 * The auto-update worker already owns the newest cache when this is called.
 * Reload immediately during ordinary browsing, but leave a playing video
 * alone and reload as soon as its player view is actually removed.
 */
export function reloadForUpdateWhenSafe(): void {
  const playerOpen = () => document.querySelector(".player-view") !== null;
  if (!playerOpen()) {
    window.location.reload();
    return;
  }
  if (reloadObserver) return;
  reloadObserver = new MutationObserver(() => {
    if (playerOpen()) return;
    reloadObserver?.disconnect();
    reloadObserver = null;
    window.location.reload();
  });
  reloadObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

/**
 * Activates a waiting worker and reloads. This remains available to the
 * Settings check as a recovery path for an older prompt-style registration.
 *
 * Driven directly rather than left to the plugin's helper: that helper is a
 * no-op when it cannot find a waiting worker, which left the Reload button
 * doing nothing at all. This posts SKIP_WAITING itself, reloads on
 * `controllerchange`, and force-reloads shortly after regardless — a reload is
 * always the correct outcome of pressing Reload.
 */
export async function applyUpdate(): Promise<void> {
  const reload = () => window.location.reload();
  try {
    const active =
      registration ??
      (await navigator.serviceWorker?.getRegistration().catch(() => null)) ??
      null;
    navigator.serviceWorker?.addEventListener("controllerchange", reload, {
      once: true,
    });
    active?.waiting?.postMessage({ type: "SKIP_WAITING" });
  } catch {
    // Ignored: the timer below still reloads.
  }
  window.setTimeout(reload, 1200);
}
