/* Imported by the generated service worker. No credentials or playback data. */
(() => {
  let probe = null;
  let activation = null;

  async function allTabsIdle() {
    const windows = (await self.clients.matchAll({ type: "window", includeUncontrolled: true }))
      .filter((client) => client.url.startsWith(self.registration.scope));
    if (!windows.length) return true;
    return new Promise((resolve) => {
      const id = `${Date.now()}-${Math.random()}`;
      const pending = new Set(windows.map((client) => client.id));
      const finish = (safe) => {
        clearTimeout(timeout);
        probe = null;
        resolve(safe);
      };
      const timeout = setTimeout(() => finish(false), 2000);
      probe = { id, pending, finish };
      for (const client of windows) {
        try { client.postMessage({ type: "NUVIO_UPDATE_STATUS_REQUEST", id }); }
        catch { finish(false); break; }
      }
    });
  }

  self.addEventListener("message", (event) => {
    const message = event.data;
    if (message?.type === "NUVIO_UPDATE_STATUS" && probe && message.id === probe.id && probe.pending.has(event.source?.id)) {
      if (message.safe !== true) { probe.finish(false); return; }
      probe.pending.delete(event.source.id);
      if (!probe.pending.size) probe.finish(true);
      return;
    }
    if (message?.type !== "NUVIO_ACTIVATE_WHEN_SAFE") return;
    activation ??= allTabsIdle().catch(() => false).then(async (safe) => {
      if (safe) await self.skipWaiting();
      return safe;
    }).finally(() => { activation = null; });
    event.waitUntil(activation.then((safe) => {
      if (!safe) {
        try { event.source?.postMessage({ type: "NUVIO_UPDATE_DEFERRED" }); } catch { /* Tab closed. */ }
      }
    }));
  });
})();
