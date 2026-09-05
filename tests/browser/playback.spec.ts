import { expect, test, type Page } from "@playwright/test";

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
for (const [file, mode] of [["direct.mp4", "direct"], ["hls/index.m3u8", "hls"], ["headers/direct.mp4", "relay"], ["headers/remux.mkv", "remux"], ["headers/audio.mkv", "audio-transcode"], ["hevc.mkv&compatibility=1", "transcode"]]) {
  test(`${file} renders real video frames via ${mode}`, async ({ page }) => {
    const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`/tests/browser/player.html?file=${file}`);
    await moving(page);
    if (mode === "hls") expect(["native-hls", "hls-js"]).toContain((await diagnostics(page)).mode);
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
  await page.getByRole("button", { name: "Audio track", exact: true }).click({ force: true });
  const switched = page.waitForResponse((response) => response.url().endsWith("/change") && response.request().postDataJSON()?.audioIndex === 2);
  await page.getByRole("button", { name: /fra.*AAC/i }).click();
  expect((await (await switched).json()).audioIndex).toBe(2);
  await page.getByRole("button", { name: "Subtitles", exact: true }).click({ force: true });
  await page.getByRole("button", { name: /English.*generated test/ }).click();
  await expect.poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => Array.from(v.textTracks).some((track) => track.mode === "showing" && (track.cues?.length ?? 0) === 2))).toBe(true);
  await page.keyboard.press("f"); await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Back", exact: true }).click({ force: true });
  await expect.poll(() => page.evaluate(() => JSON.parse(document.documentElement.dataset.progress || "{}").position)).toBeGreaterThan(10_000);
});
test("broken media reaches a useful error and retains external handoff", async ({ page }) => {
  await page.goto("/tests/browser/player.html?file=broken");
  await expect(page.getByText(/source could not be inspected/i)).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy stream URL", exact: true })).toBeVisible();
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
