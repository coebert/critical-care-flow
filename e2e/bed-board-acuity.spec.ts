import { test, expect, type Page } from "@playwright/test";

/**
 * Bed board acuity round-trip.
 *
 * Opens the partner-bridge bed board, picks an occupied bed, cycles through
 * L0 → L1 → L2 → L3 in its "Edit patient" dialog, and verifies after each
 * change that:
 *
 *   1. The per-bed card shows the new `L{n}` badge with the correct
 *      accessible label.
 *   2. The unit "Acuity" strip's per-level count for that level goes up
 *      by 1 vs the baseline snapshot taken before the test started.
 *   3. The Mean value in the strip matches the running mean recomputed
 *      from those live counts.
 *
 * At the end the test clears the override so the run leaves no residue.
 * If the partner bridge is offline or the unit has no occupied beds in
 * this environment, the test skips rather than fails — a stale partner is
 * not an app-layer regression.
 */

type Counts = { 0: number; 1: number; 2: number; 3: number };

const LEVEL_LABEL: Record<0 | 1 | 2 | 3, RegExp> = {
  0: /^Level 0 —/,
  1: /^Level 1 —/,
  2: /^Level 2 —/,
  3: /^Level 3 —/,
};

async function readStrip(page: Page): Promise<{ counts: Counts; mean: number }> {
  const strip = page.getByRole("status", { name: /unit acuity/i });
  await expect(strip).toBeVisible({ timeout: 10_000 });
  const text = await strip.innerText();
  const readOne = (l: 0 | 1 | 2 | 3): number => {
    // Each level chip renders "L{n}\n{count}" (or with a separator).
    const m = new RegExp(`\\bL${l}\\b[^0-9-]*(\\d+)`).exec(text);
    if (!m) throw new Error(`Could not parse L${l} count from acuity strip:\n${text}`);
    return Number(m[1]);
  };
  const meanMatch = /Mean[^0-9-]*(-?\d+(?:\.\d+)?)/.exec(text);
  if (!meanMatch) throw new Error(`Could not parse Mean from acuity strip:\n${text}`);
  return {
    counts: { 0: readOne(0), 1: readOne(1), 2: readOne(2), 3: readOne(3) },
    mean: Number(meanMatch[1]),
  };
}

function computeMean(counts: Counts): number {
  const scored = counts[0] + counts[1] + counts[2] + counts[3];
  if (scored === 0) return 0;
  const sum = counts[1] + 2 * counts[2] + 3 * counts[3];
  return sum / scored;
}

test.describe("bed board acuity", () => {
  test("per-bed badge and unit strip update as L0–L3 are selected", async ({
    page,
  }) => {
    await page.goto("/bed-board");

    // If the partner bridge is unhealthy in this env, there's nothing to
    // score — skip rather than fail on infra we don't own.
    const anyOccupied = page
      .locator('[role="button"][aria-label^="Bed "]')
      .filter({ hasNot: page.locator("text=Empty") })
      .first();
    if (!(await anyOccupied.isVisible({ timeout: 15_000 }).catch(() => false))) {
      test.skip(true, "No occupied beds visible — partner bridge likely offline.");
    }

    const bedLabel = (await anyOccupied.getAttribute("aria-label")) ?? "";
    const bedCode = bedLabel.match(/^Bed (\S+) — /)?.[1];
    expect(bedCode, "extract bed code from card").toBeTruthy();
    const cardSel = page.getByRole("button", {
      name: new RegExp(`^Bed ${bedCode} — `),
    });

    // Baseline: read the strip BEFORE we touch anything. All later
    // assertions compare against this snapshot so the test does not care
    // whether the unit already has other scored patients.
    const baseline = await readStrip(page);

    for (const level of [0, 1, 2, 3] as const) {
      await cardSel.click();
      const dialog = page.getByRole("dialog", { name: /edit patient/i });
      await expect(dialog).toBeVisible();

      const btn = dialog.getByRole("button", { name: LEVEL_LABEL[level] });
      await btn.click();

      // Wait for the mutation to settle: the button becomes aria-pressed.
      await expect(btn).toHaveAttribute("aria-pressed", "true", { timeout: 10_000 });

      // Close the dialog to check the bed card + strip without overlay noise.
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden({ timeout: 5_000 });

      // Per-bed badge: card exposes an L{n} Badge with the level label.
      const badge = cardSel.getByLabel(LEVEL_LABEL[level]);
      await expect(badge, `card should show L${level} badge`).toBeVisible({
        timeout: 10_000,
      });
      await expect(badge).toHaveText(new RegExp(`^L${level}$`));

      // Unit acuity strip: the count for the newly-selected level should
      // read exactly baseline+1 (assuming the same patient is being
      // rescored each iteration, which cancels out any previous +1).
      await expect
        .poll(async () => (await readStrip(page)).counts, {
          timeout: 10_000,
          message: `L${level} count should equal baseline+1 after selecting L${level}`,
        })
        .toEqual({
          0: baseline.counts[0] + (level === 0 ? 1 : 0),
          1: baseline.counts[1] + (level === 1 ? 1 : 0),
          2: baseline.counts[2] + (level === 2 ? 1 : 0),
          3: baseline.counts[3] + (level === 3 ? 1 : 0),
        });

      // Mean must match the mean derived from the live per-level counts,
      // rounded the same way the header displays (.toFixed(2)).
      const live = await readStrip(page);
      const expectedMean = Number(computeMean(live.counts).toFixed(2));
      expect(
        live.mean,
        `strip Mean should equal recomputed mean for counts ${JSON.stringify(live.counts)}`,
      ).toBeCloseTo(expectedMean, 2);
    }

    // Cleanup: clear the override we added so re-runs and other tests
    // see the same baseline.
    await cardSel.click();
    const dialog = page.getByRole("dialog", { name: /edit patient/i });
    await expect(dialog).toBeVisible();
    const clear = dialog.getByRole("button", { name: /^Clear$/ });
    if (await clear.isVisible().catch(() => false)) {
      await clear.click();
      // Once cleared, the L{n} badge on the card disappears.
      for (const l of [0, 1, 2, 3] as const) {
        await expect(cardSel.getByLabel(LEVEL_LABEL[l])).toHaveCount(0, {
          timeout: 10_000,
        });
      }
    }
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden({ timeout: 5_000 });

    // Final strip must be back to baseline.
    await expect
      .poll(async () => (await readStrip(page)).counts, {
        timeout: 10_000,
        message: "acuity strip should return to baseline after clearing",
      })
      .toEqual(baseline.counts);
  });
});
