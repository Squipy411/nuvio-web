import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  if (process.env.NUVIO_FORCE_MSE !== "1") return;
  await page.addInitScript(() => {
    const original = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function (type: string) {
      if (/^(?:application|audio)\/(?:vnd\.apple\.mpegurl|x-mpegurl|mpegurl)(?:\s*;|$)/i.test(type.trim())) return "";
      return original.call(this, type);
    };
  });
});

test.afterEach(async ({ page }, info) => {
  // Browser context teardown does not guarantee pagehide/keepalive delivery.
  // Close through the actual UI so one test cannot consume the next test's slots.
  // A body may already be closing its player: never wait a full test timeout for
  // a disappearing Back button, or replace the original failure with teardown.
  if (page.isClosed()) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cleanupError: unknown;
  const cleanup = async () => {
    try {
      const back = page.getByRole("button", { name: "Back", exact: true });
      if (await back.count()) {
        await back.click({ force: true, timeout: 1000 });
        await expect(page.getByText("Playback stopped", { exact: true })).toBeVisible({ timeout: 1000 });
        return;
      }
    } catch (error) { cleanupError = error; }
    if (!page.isClosed()) await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  };
  await Promise.race([
    cleanup().catch((error: unknown) => { cleanupError ??= error; }),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, 2800); }),
  ]);
  clearTimeout(timer);
  if (cleanupError) info.annotations.push({ type: "cleanup", description: "UI teardown raced with player close; used pagehide fallback. Body assertions are unchanged." });
});

async function moving(page: Page) {
  await expect.poll(() => page.locator("video").evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(0.5);
  await expect.poll(() => page.locator("video").evaluate((video: HTMLVideoElement) => video.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(1);
}
async function diagnostics(page: Page) {
  return page.evaluate(async () => {
    // @ts-expect-error Vite-only module URL, not part of the production entry point.
    const client = await import("/src/lib/companionClient.ts");
    return client.playbackDiagnostics() as { mode: string; bufferSeconds?: number; lastError?: string };
  });
}
async function openSetting(page: Page, name: string) {
  await page.getByRole("button", { name: "Settings", exact: true }).click({ force: true });
  await page.locator(".settings-row").filter({ hasText: name }).click();
}
async function seekTo(page: Page, position: number) {
  const slider = page.getByRole("slider", { name: "Seek", exact: true });
  await slider.fill(String(position)); await slider.dispatchEvent("pointerup");
  return slider;
}
for (const [file, mode] of [["direct.mp4", "direct"], ["hls/index.m3u8", "hls"], ["hls-redirect", "hls"], ["hls-redirect-octet", "hls"], ["headers/direct.mp4", "relay"], ["headers/remux.mkv", "remux"], ["headers/audio.mkv", "audio-transcode"], ["hevc.mkv&compatibility=1", "transcode"]]) {
  test(`${file} renders real video frames via ${mode}`, async ({ page }) => {
    const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`/tests/browser/player.html?file=${file}`);
    await moving(page);
    if (mode === "hls") {
      // Some native implementations recognize a redirected playlist by MIME
      // without needing the explicit HLS adapter. Frames/time remain mandatory.
      const allowed = file === "hls-redirect" || file === "hls-redirect-octet" ? ["direct", "native-hls", "hls-js"] : ["native-hls", "hls-js"];
      expect(allowed).toContain((await diagnostics(page)).mode);
    }
    else expect((await diagnostics(page)).mode).toBe(mode);
    await page.getByRole("button", { name: "Back", exact: true }).click({ force: true });
    await expect(page.getByText("Playback stopped")).toBeVisible();
    expect(errors).toEqual([]);
  });
}
test("real player pause, resume, seeks, subtitle selection, audio switching, keyboard and progress", async ({ page }) => {
  await page.goto("/tests/browser/player.html?file=headers/remux.mkv&resume=4"); await moving(page);
  await expect(page.getByRole("slider", { name: "Seek", exact: true })).toHaveValue(/^[4-9]/);
  await page.keyboard.press("Space");
  await expect.poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  const time = await page.locator("video").evaluate((v: HTMLVideoElement) => v.currentTime);
  await page.waitForTimeout(500);
  expect(await page.locator("video").evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(time, 1);
  await page.keyboard.press("Space"); await moving(page);
  for (const position of [16, 5, 12]) {
    const slider = page.getByRole("slider", { name: "Seek", exact: true });
    await slider.fill(String(position)); await slider.dispatchEvent("pointerup");
    await expect.poll(async () => Number(await slider.inputValue())).toBeGreaterThanOrEqual(position);
    await expect.poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => !v.paused && v.readyState >= 2)).toBe(true);
  }
  await page.keyboard.press("Tab"); // Leave the seek input; its arrow keys belong to the slider.
  await page.keyboard.press("ArrowUp"); await page.keyboard.press("m");
  await expect.poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.muted)).toBe(true);
  await openSetting(page, "Audio track");
  const switched = page.waitForResponse((response) => response.url().endsWith("/change") && response.request().postDataJSON()?.audioIndex === 2);
  await page.getByRole("button", { name: /fra.*AAC/i }).click();
  expect((await (await switched).json()).audioIndex).toBe(2);
  await moving(page);
  await page.locator(".player-play").click({ force: true });
  await expect.poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  const subtitleSeek = page.waitForResponse((response) => response.url().endsWith("/change") && response.request().postDataJSON()?.position === 12);
  await seekTo(page, 12); expect((await subtitleSeek).ok()).toBe(true);
  await openSetting(page, "Subtitles");
  await page.getByRole("button", { name: /^English/ }).click();
  await expect(page.locator(".player-subtitle-overlay")).toHaveText("Seeking works");
  await page.locator(".player-play").click({ force: true }); await moving(page);
  await page.keyboard.press("f"); await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Back", exact: true }).click({ force: true });
  await expect(page.getByText("Playback stopped", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => JSON.parse(document.documentElement.dataset.progress || "{}").position)).toBeGreaterThan(10_000);
});
test("a paused companion seek keeps the picture paused and resumes at the requested original position", async ({ page }) => {
  await page.goto("/tests/browser/player.html?file=headers/remux.mkv&resume=4"); await moving(page);
  await page.locator(".player-play").click({ force: true });
  await expect.poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  const changed = page.waitForResponse((response) => response.url().endsWith("/change") && response.request().postDataJSON()?.position === 12);
  const slider = await seekTo(page, 12);
  expect((await changed).ok()).toBe(true);
  await expect.poll(async () => Number(await slider.inputValue())).toBeGreaterThanOrEqual(12);
  await page.waitForTimeout(700);
  expect(await page.locator("video").evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  await page.locator(".player-play").click({ force: true }); await moving(page);
  await expect.poll(async () => Number(await slider.inputValue())).toBeGreaterThan(12.4);
  expect((await diagnostics(page)).mode).toBe("remux");
});
test("one transient heartbeat failure keeps decoded playback and the same compatibility mode", async ({ page }) => {
  await page.goto("/tests/browser/player.html?file=headers/remux.mkv"); await moving(page);
  let rejected = 0;
  await page.route("**/api/companion/sessions/*/heartbeat", async (route) => {
    if (!rejected++) await route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "Synthetic brief gateway interruption" }) });
    else await route.continue();
  });
  const failed = page.waitForResponse((response) => response.url().endsWith("/heartbeat") && response.status() === 502);
  await page.locator(".player-play").click({ force: true }); await failed;
  const recovered = page.waitForResponse((response) => response.url().endsWith("/heartbeat") && response.ok());
  await page.locator(".player-play").click({ force: true }); await recovered;
  const prior = await page.locator("video").evaluate((v: HTMLVideoElement) => ({ time: v.currentTime, frames: v.getVideoPlaybackQuality().totalVideoFrames }));
  await expect.poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(prior.time + 0.5);
  await expect.poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(prior.frames);
  expect((await diagnostics(page)).mode).toBe("remux");
  await expect(page.getByText("Synthetic brief gateway interruption", { exact: true })).not.toBeVisible();
});
test("a rejected heartbeat renews authentication once and continues real playback", async ({ page }) => {
  let authExchanges = 0;
  page.on("request", (request) => { if (request.url().endsWith("/api/companion/auth")) authExchanges++; });
  await page.goto("/tests/browser/player.html?file=headers/remux.mkv"); await moving(page);
  const before = authExchanges;
  let rejected = false;
  await page.route("**/api/companion/sessions/*/heartbeat", async (route) => {
    if (!rejected) { rejected = true; await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Synthetic expired browser authentication" }) }); }
    else await route.continue();
  });
  const renewed = page.waitForResponse((response) => response.url().endsWith("/api/companion/auth") && response.ok());
  const retried = page.waitForResponse((response) => response.url().endsWith("/heartbeat") && response.ok());
  await page.locator(".player-play").click({ force: true }); await renewed; await retried;
  expect(authExchanges).toBe(before + 1);
  await page.locator(".player-play").click({ force: true });
  const prior = await page.locator("video").evaluate((v: HTMLVideoElement) => v.currentTime);
  await expect.poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(prior + 0.5);
  await moving(page); expect((await diagnostics(page)).mode).toBe("remux");
});
test("the official source picker swaps media without losing the saved playback position", async ({ page }) => {
  const created = page.waitForResponse((response) => response.url().endsWith("/api/companion/sessions") && response.status() === 201);
  await page.goto("/tests/browser/player.html?file=headers/remux.mkv&resume=5&sources=1"); await moving(page);
  const oldId = (await (await created).json()).id as string;
  await page.getByRole("button", { name: "Sources", exact: true }).click({ force: true });
  const stopped = page.waitForResponse((response) => response.url().includes(`/sessions/${oldId}/stop`) && response.ok());
  await page.getByRole("dialog", { name: "Sources", exact: true }).getByRole("button", { name: /Alternative generated media/ }).click();
  await stopped;
  await expect.poll(async () => (await diagnostics(page))?.mode).toBe("audio-transcode");
  await expect(page.locator("video")).toHaveCount(1);
  await expect(page.locator("canvas.player-canvas")).toHaveCount(1);
  await moving(page);
  const position = await page.evaluate(() => JSON.parse(document.documentElement.dataset.sourceChange || "{}").position);
  expect(position).toBeGreaterThan(5000);
  await expect.poll(async () => Number(await page.getByRole("slider", { name: "Seek", exact: true }).inputValue())).toBeGreaterThanOrEqual(position / 1000);
});
test("saved double speed stays normal during conversion and returns for direct playback", async ({ page }) => {
  // Match the actual persisted setting read by storedPlaybackRate().
  await page.addInitScript(() => localStorage.setItem("nuvio-web-playback-rate", "2"));
  await page.goto("/tests/browser/player.html?file=headers/remux.mkv"); await moving(page);
  expect((await diagnostics(page)).mode).toBe("remux");
  await expect.poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.playbackRate)).toBe(1);
  expect(await page.locator("video").evaluate((v: HTMLVideoElement) => v.defaultPlaybackRate)).toBe(1);
  expect(await page.evaluate(() => localStorage.getItem("nuvio-web-playback-rate"))).toBe("2");
  await page.getByRole("button", { name: "Settings", exact: true }).click({ force: true });
  await expect(page.locator(".settings-row").filter({ hasText: "Playback speed" })).toBeDisabled();
  await page.getByRole("button", { name: "Back", exact: true }).click({ force: true });
  await expect(page.getByText("Playback stopped", { exact: true })).toBeVisible();
  await page.goto("/tests/browser/player.html?file=direct.mp4"); await moving(page);
  expect((await diagnostics(page)).mode).toBe("direct");
  await expect.poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.playbackRate)).toBe(2);
  expect(await page.locator("video").evaluate((v: HTMLVideoElement) => v.defaultPlaybackRate)).toBe(2);
});
test("broken media reaches a useful error and retains external handoff", async ({ page }) => {
  await page.goto("/tests/browser/player.html?file=broken");
  await expect(page.getByText(/source could not be inspected/i)).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy stream URL", exact: true })).toBeVisible();
});
test("progress advances when an unavailable companion hands playback to the original player", async ({ page }) => {
  await page.goto("/tests/browser/player.html?file=direct.mp4&compatibility=1&noCompanion=1");
  await moving(page);
  await page.keyboard.press("Space");
  await expect.poll(() => page.evaluate(() => JSON.parse(document.documentElement.dataset.progress || "{}").position)).toBeGreaterThan(500);
  await page.keyboard.press("Space");
  await expect.poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(1.5);
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await expect.poll(() => page.evaluate(() => JSON.parse(document.documentElement.dataset.progress || "{}").position)).toBeGreaterThan(1500);
});
test("mobile player controls and desktop diagnostics stay within the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tests/browser/player.html?file=direct.mp4"); await moving(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/player-mobile.png" });
  await page.goto("/tests/browser/player.html?settings=1");
  await page.getByRole("button", { name: "Playback diagnostics", exact: true }).click();
  await expect(page.locator("pre")).toContainText("capabilities");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: "test-results/playback-settings-desktop.png" });
});
