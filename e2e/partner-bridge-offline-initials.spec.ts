import { test, expect, type Route } from "@playwright/test";

/**
 * Partner-bridge offline behaviour for patient-initials updates.
 *
 * Simulates the partner bridge being unreachable while the user tries to
 * change a patient's initials on the bed board, and verifies:
 *
 *   1. The app surfaces a clear error toast instead of silently swallowing
 *      the failure or optimistically closing the dialog.
 *   2. The edit dialog stays open so the user's typed value is not lost.
 *   3. Once the bridge is available again, retrying the same save succeeds
 *      and the change round-trips: the bed card and the re-opened dialog
 *      both show the normalised initials after a full-page reload.
 *
 * TanStack Start dispatches server functions over the `/n/*` prefix. We
 * intercept only the `updatePartnerPatient` call (identified by the
 * `full_name` field in its POST body) so unrelated server-fn traffic —
 * getPatientAcuity, getPartnerBedBoard refreshes, etc. — still flows.
 *
 * Skips when the partner bridge is offline in this environment (no
 * occupied beds visible) — a stale partner is not an app-layer regression.
 */

const NEW_FULL_NAME = "Priya S Ramanathan";
const NEW_INITIALS = "PSR";

test.describe("partner bridge offline during initials update", () => {
  test("shows error, keeps dialog open, and round-trips on retry", async ({
    page,
  }) => {
    await page.goto("/bed-board");

    const anyOccupied = page
      .locator('[role="button"][aria-label^="Bed "]')
      .filter({ hasNot: page.locator("text=Empty") })
      .first();

    if (!(await anyOccupied.isVisible({ timeout: 15_000 }).catch(() => false))) {
      test.skip(
        true,
        "No occupied beds visible — partner bridge likely offline in this env.",
      );
    }

    const bedLabel = (await anyOccupied.getAttribute("aria-label")) ?? "";
    const bedCode = bedLabel.match(/^Bed (\S+) — /)?.[1];
    expect(bedCode, "extract bed code from card").toBeTruthy();
    const cardSel = () =>
      page.getByRole("button", { name: new RegExp(`^Bed ${bedCode} — `) });

    // --- Arm the "partner offline" interceptor ---
    //
    // Only the updatePartnerPatient RPC carries `full_name` in its body,
    // so this filter leaves other server-fn traffic alone.
    let simulatingOffline = true;
    let interceptedCount = 0;
    const handler = async (route: Route) => {
      const req = route.request();
      const body = req.postData() ?? "";
      const isUpdate = req.method() === "POST" && body.includes("full_name");
      if (simulatingOffline && isUpdate) {
        interceptedCount += 1;
        // Mirror the shape a real bridge outage would produce: HTTP 503,
        // JSON body carrying the same "partner unreachable" phrasing the
        // server fn uses when its own fetch throws.
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: "partner unreachable: simulated offline in e2e test",
          }),
        });
        return;
      }
      await route.continue();
    };
    await page.route("**/n/**", handler);

    // --- Open dialog, type a full name, blur → normalised ---
    await cardSel().click();
    let dialog = page.getByRole("dialog", { name: /edit patient/i });
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    const initialsInput = dialog.getByLabel(/patient initials/i);
    await initialsInput.fill(NEW_FULL_NAME);
    await initialsInput.blur();
    await expect(initialsInput).toHaveValue(NEW_INITIALS);

    // --- Save while bridge is "offline" ---
    await dialog.getByRole("button", { name: /save changes/i }).click();

    // Error toast surfaces. Message wording tolerates both the server-fn
    // "partner unreachable" phrasing and TanStack's generic RPC failure.
    await expect(
      page
        .locator('[data-sonner-toast]')
        .filter({ hasText: /partner|unreachable|failed|error|503/i })
        .first(),
    ).toBeVisible({ timeout: 10_000 });

    // Dialog must stay open with the user's typed value preserved.
    await expect(dialog).toBeVisible();
    await expect(initialsInput).toHaveValue(NEW_INITIALS);
    expect(interceptedCount, "offline interceptor fired at least once").toBeGreaterThan(0);

    // --- Bring the bridge back and retry the same save ---
    simulatingOffline = false;
    await dialog.getByRole("button", { name: /save changes/i }).click();

    // Dialog closes on success.
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    // Clean up the interceptor before the reload so we do not accidentally
    // leak the filter into other requests.
    await page.unroute("**/n/**", handler);

    // --- Round-trip on reload ---
    await page.reload();
    const reloadedCard = cardSel();
    await expect(reloadedCard).toBeVisible({ timeout: 15_000 });
    await expect(reloadedCard).toHaveAttribute(
      "aria-label",
      new RegExp(`^Bed ${bedCode} — .*${NEW_INITIALS}`),
      { timeout: 15_000 },
    );

    await reloadedCard.click();
    dialog = page.getByRole("dialog", { name: /edit patient/i });
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(dialog.getByLabel(/patient initials/i)).toHaveValue(
      NEW_INITIALS,
      { timeout: 10_000 },
    );
  });
});
