import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * Unit-test config. Kept separate from `vite.config.ts` so Vitest does not
 * boot the full TanStack Start plugin chain, and — importantly — so the
 * Playwright specs under `e2e/` are never collected by Vitest (they throw
 * "Playwright Test needs to be invoked via 'npx playwright test'" on import).
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["e2e/**", "node_modules/**", "dist/**", ".nitro/**", ".output/**"],
    environment: "node",
  },
});
