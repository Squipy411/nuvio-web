import { expect, test } from "@playwright/test";
import { networkInterfaces } from "node:os";

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
