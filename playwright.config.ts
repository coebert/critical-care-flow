import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for end-to-end tests.
 *
 * Required env vars (set locally or in CI):
 *   E2E_BASE_URL   — URL of a running preview, e.g. http://localhost:5173
 *                    or the lovable preview URL.
 *   E2E_EMAIL      — email of a test user that exists in Lovable Cloud auth.
 *   E2E_PASSWORD   — password for that user.
 *
 * Run with:
 *   bunx playwright install chromium      # one-off, downloads the browser
 *   bunx playwright test                  # runs all e2e tests
 *   bunx playwright test --ui             # interactive mode
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // "list" prints per-test progress; "html" writes a browsable report at
  // playwright-report/ that links every failed test to its trace,
  // screenshots, video, and any custom attachments (see e2e/passkey-flow).
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  outputDir: "test-results",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:5173",
    // Capture everything needed to diagnose a failing run without re-running:
    //   trace       — full DOM+network+source snapshots on failure or retry.
    //   screenshot  — final screenshot at the point of failure.
    //   video       — recorded frames from the failing attempt.
    // "retain-on-failure" keeps artifacts only when a test actually fails,
    // so green runs don't fill the disk.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    storageState: "e2e/.auth/user.json",
  },
  projects: [
    {
      name: "setup",
      testMatch: /global\.setup\.ts/,
      use: { storageState: undefined },
    },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
    },
  ],
});
