import { test, expect } from "@playwright/test";

/**
 * Simulates the Lovable preview iframe scenario where the browser's
 * Permissions Policy blocks `publickey-credentials-create`. In that state
 * `registerPasskey()` throws with `code: PASSKEY_BLOCKED_BY_FRAME`, and the
 * UI must surface the "Passkey setup blocked in preview" toast with an
 * "Open in new tab" action — never the generic "setup cancelled" message.
 *
 * We reproduce the block deterministically by monkey-patching
 * `document.featurePolicy.allowsFeature` before any app code runs, so
 * `passkeyCreateAllowed()` returns false and the guard in `registerPasskey`
 * fires without ever touching the WebAuthn API. This is the same code path
 * a real cross-origin preview iframe hits.
 */
test.describe("passkey setup blocked by preview iframe", () => {
  test.skip(
    !process.env.E2E_EMAIL || !process.env.E2E_PASSWORD,
    "requires signed-in storage state from global.setup.ts",
  );

  test("shows blocked-in-preview toast with Open in new tab action", async ({
    page,
    context,
  }) => {
    // Force the Permissions Policy check to report the feature as denied,
    // exactly as a cross-origin preview iframe would.
    await context.addInitScript(() => {
      const denyForPasskeyCreate = (feature: string) =>
        feature !== "publickey-credentials-create";
      const install = () => {
        const doc = document as unknown as {
          featurePolicy?: { allowsFeature: (n: string) => boolean };
          permissionsPolicy?: { allowsFeature: (n: string) => boolean };
        };
        const stub = { allowsFeature: denyForPasskeyCreate };
        try {
          Object.defineProperty(document, "featurePolicy", {
            configurable: true,
            get: () => stub,
          });
        } catch {
          doc.featurePolicy = stub;
        }
        try {
          Object.defineProperty(document, "permissionsPolicy", {
            configurable: true,
            get: () => stub,
          });
        } catch {
          doc.permissionsPolicy = stub;
        }
      };
      install();
    });

    await page.goto("/profile");
    await expect(
      page.getByRole("heading", { name: /passkeys/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Track window.open — the toast action opens the app in a new tab.
    await page.evaluate(() => {
      (window as unknown as { __openCalls: string[] }).__openCalls = [];
      const orig = window.open;
      window.open = ((url?: string | URL) => {
        (window as unknown as { __openCalls: string[] }).__openCalls.push(
          String(url ?? ""),
        );
        return null;
      }) as typeof orig;
    });

    await page.getByRole("button", { name: /add passkey/i }).click();

    // The blocked-in-preview toast, not the generic "cancelled" message.
    await expect(
      page.getByText(/passkey setup blocked in preview/i),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByText(/passkey setup cancelled/i),
    ).toHaveCount(0);

    // Toast action button should open the current URL in a new tab.
    const openBtn = page.getByRole("button", { name: /open in new tab/i });
    await expect(openBtn).toBeVisible();
    await openBtn.click();

    const opened = await page.evaluate(
      () => (window as unknown as { __openCalls: string[] }).__openCalls,
    );
    expect(opened.length).toBe(1);
    expect(opened[0]).toContain("/profile");
  });
});
