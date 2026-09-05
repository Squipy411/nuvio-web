import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser", testMatch: "*.spec.ts", fullyParallel: false, workers: 1,
  timeout: 60_000, expect: { timeout: 25_000 }, reporter: "list",
  use: { baseURL: process.env.NUVIO_BROWSER_URL || "http://localhost:4175", browserName: "chromium",
    launchOptions: { ...(process.env.NUVIO_CHROME_PATH ? { executablePath: process.env.NUVIO_CHROME_PATH } : {}), args: ["--autoplay-policy=no-user-gesture-required"] },
    screenshot: "only-on-failure", trace: "retain-on-failure" },
});
