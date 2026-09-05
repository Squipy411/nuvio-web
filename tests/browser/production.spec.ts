import { expect, test } from "@playwright/test";

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
