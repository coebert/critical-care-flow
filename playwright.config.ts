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
  reporter: "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:5173",
    trace: "retain-on-failure",
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
