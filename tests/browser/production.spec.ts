import { expect, test } from "@playwright/test";
import { networkInterfaces } from "node:os";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";

test("built PWA installs an offline shell without caching private playback", async ({ page, context }) => {
  test.skip(!process.env.NUVIO_PRODUCTION_URL, "Set NUVIO_PRODUCTION_URL to a running production preview.");
  await page.goto(process.env.NUVIO_PRODUCTION_URL!);
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  const precache = await page.evaluate(async () => {
    const keys = await caches.keys();
    return (await Promise.all(keys.map(async (name) => (await (await caches.open(name)).keys()).map((request) => request.url)))).flat();
  });
  expect(precache.some((url) => /\/index\.html/.test(url))).toBe(true);
  expect(precache.some((url) => /\/api\/companion\/|\/mediabunny-ac3-|\/hls-/.test(url))).toBe(false);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  expect(await page.evaluate(async () => {
    try { await fetch("/api/companion/healthz"); return "unexpected cached response"; } catch { return "network only"; }
  })).toBe("network only");
  await context.setOffline(false);
});

test("plain LAN HTTP keeps the real sign-in worker responsive", async ({ page, context }) => {
  test.skip(!process.env.NUVIO_PRODUCTION_URL, "Set NUVIO_PRODUCTION_URL to a running production preview.");
  const address = Object.values(networkInterfaces()).flat().find((item) => item?.family === "IPv4" && !item.internal)?.address;
  expect(address, "A non-loopback address is required: localhost hides secure-context bugs.").toBeTruthy();
  const url = new URL(process.env.NUVIO_PRODUCTION_URL!); url.hostname = address!;
  // Exercise the real compiled auth worker with synthetic rejected credentials;
  // no live account, password, or successful cloud sign-in is claimed here.
  await context.route("https://api.nuvio.tv/**", (route) => route.fulfill({ status: 401,
    contentType: "application/json", headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify({ msg: "LAN authentication fixture reached" }) }));
  await page.goto(url.toString());
  expect(await page.evaluate(() => isSecureContext)).toBe(false);
  await page.getByLabel("Email", { exact: true }).fill("fixture@example.invalid");
  await page.locator('input[autocomplete="current-password"]').fill("generated-test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("LAN authentication fixture reached", { exact: true })).toBeVisible({ timeout: 8000 });
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
});

test("a real waiting PWA update preserves old chunks until playback closes in every tab", async ({ page, context }) => {
  test.skip(!process.env.NUVIO_PRODUCTION_URL, "Build the app and set NUVIO_PRODUCTION_URL for production checks.");
  const directory = resolve("dist");
  let revision = 1;
  const server = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? "/", "http://update-fixture").pathname;
      if (path.startsWith("/api/")) { response.writeHead(404, { "content-type": "application/json" }); response.end("{}"); return; }
      const file = resolve(directory, path === "/" ? "index.html" : `.${path}`);
      if (!file.startsWith(directory + "/")) { response.writeHead(403); response.end(); return; }
      let body = await readFile(file);
      if (path === "/sw.js") body = Buffer.concat([body, Buffer.from(`\n// update-test-revision=${revision}\n`)]);
      const types: Record<string, string> = { ".js": "application/javascript", ".html": "text/html", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml" };
      response.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream", "cache-control": "no-store" }); response.end(body);
    })().catch(() => { response.writeHead(404); response.end(); });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const second = await context.newPage();
  try {
    for (const tab of [page, second]) {
      await tab.goto(base);
      await expect(tab.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
      await tab.evaluate(async () => { await navigator.serviceWorker.ready; });
      await expect.poll(() => tab.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
      await tab.evaluate(() => { document.documentElement.dataset.updateSentinel = "old-build"; });
    }
    // The lifecycle guard watches the player view, not playback content. A DOM
    // fixture lets this check run without a live account or copyrighted media.
    await second.evaluate(() => { const player = document.createElement("div"); player.className = "player-view"; document.body.append(player); });
    const cacheName = await page.evaluate(async () => (await caches.keys()).find((key) => key.includes("precache"))!);
    expect(cacheName).toBeTruthy();
    await page.evaluate(() => navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data?.type === "NUVIO_UPDATE_DEFERRED") document.documentElement.dataset.updateDeferred = "true";
    }));
    await page.evaluate(async (name) => { await (await caches.open(name)).put("/assets/old-lazy-chunk-for-update-check.js", new Response("old build decoder")); }, cacheName);
    revision = 2;
    await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())!.update(); });
    await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.waiting?.state)).toBe("installed");
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.updateDeferred)).toBe("true");
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.updateSentinel)).toBe("old-build");
    expect(await page.evaluate(async (name) => !!(await (await caches.open(name)).match("/assets/old-lazy-chunk-for-update-check.js")), cacheName)).toBe(true);
    expect(await second.evaluate(() => document.documentElement.dataset.updateSentinel)).toBe("old-build");
    await second.evaluate(() => document.querySelector(".player-view")!.remove());
    for (const tab of [page, second]) {
      await expect(tab.locator("html")).not.toHaveAttribute("data-update-sentinel", "old-build");
      await expect(tab.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
    }
    expect(await page.evaluate(async (name) => !!(await (await caches.open(name)).match("/assets/old-lazy-chunk-for-update-check.js")), cacheName)).toBe(false);
  } finally {
    await second.close(); server.close(); server.closeAllConnections();
  }
});
