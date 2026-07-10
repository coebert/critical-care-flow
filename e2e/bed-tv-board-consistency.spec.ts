import { test, expect, type Page } from "@playwright/test";

/**
 * Bed board <-> TV board UI consistency check.
 *
 * Prevents a whole class of regressions where the two surfaces drift on
 * how they render occupancy state. Both boards must render the same
 * care-level pill (L0/L1/L2/L3) and the same wardable badge (WARDABLE
 * present or absent) for the same bed at the same time.
 *
 * Flow:
 *   1. Admit a patient to a free bed with { level: 1, wardable: true }.
 *   2. Read the state of that bed on /bed-board and /board.
 *   3. Assert both surfaces agree on level + wardable.
 *   4. Edit the same occupancy to { level: 2, wardable: false }.
 *   5. Re-read both surfaces and re-assert agreement.
 *   6. Discharge the patient so the run leaves no residue.
 *
 * This is a UI-level check on purpose: it exercises the exact tokens
 * (WardableBadge, LEVEL_PILL / LEVEL_TONE) that the two boards render,
 * so a component-level divergence trips the test even when the backend
 * data is identical.
 */

type CardState = { level: string | null; wardable: boolean };

const LEVEL_RE = /\bL([0-3])\b/;

async function readBedBoardCard(page: Page, code: string): Promise<CardState> {
  const card = page.getByRole("button", {
    name: new RegExp(`^Bed ${code} — click to edit$`),
  });
  await expect(card).toBeVisible({ timeout: 10_000 });
  const text = await card.innerText();
  return {
    level: text.match(LEVEL_RE)?.[1] ?? null,
    wardable: /\bWARDABLE\b/.test(text),
  };
}

async function readTvBoardCard(page: Page, code: string): Promise<CardState> {
  // The TV board renders the bed code inside a small uppercase eyebrow.
  // From that node we walk up to the card container to read the pill +
  // badge text together.
  const codeCell = page
    .locator("div.uppercase", { hasText: new RegExp(`^${code}$`) })
    .first();
  await expect(codeCell).toBeVisible({ timeout: 10_000 });
  const card = codeCell.locator(
    'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " rounded ") and contains(@class, "border") and contains(@class, "p-3")][1]',
  );
  const text = await card.innerText();
  return {
    level: text.match(LEVEL_RE)?.[1] ?? null,
    wardable: /\bWARDABLE\b/.test(text),
  };
}

async function setLevel(page: Page, level: "0" | "1" | "2" | "3") {
  // The dialog uses a Radix Select trigger labelled "Level of care".
  await page.getByLabel(/level of care/i).click();
  await page
    .getByRole("option", { name: new RegExp(`^Level ${level}\\b`) })
    .click();
}

async function setWardable(page: Page, wardable: boolean) {
  const box = page.getByRole("checkbox", { name: /wardable/i });
  const checked = await box.isChecked();
  if (checked !== wardable) await box.click();
}

test.describe("bed board / TV board consistency", () => {
  test("occupancy create + edit stays in sync across surfaces", async ({
    browser,
  }) => {
    // Two contexts share the same storageState (see playwright.config.ts),
    // so we can keep both boards open at once and re-read them without
    // fighting the SPA's own navigation.
    const bedCtx = await browser.newContext();
    const tvCtx = await browser.newContext();
    const bedPage = await bedCtx.newPage();
    const tvPage = await tvCtx.newPage();

    try {
      await bedPage.goto("/bed-board");

      // Grab the first genuinely empty bed. We match on the aria-label the
      // empty BedCard exposes; the code lives inside that label.
      const emptyCard = bedPage
        .getByRole("button", { name: /^Empty bed .+ — click to admit$/ })
        .first();
      await expect(emptyCard).toBeVisible({ timeout: 15_000 });
      const label = (await emptyCard.getAttribute("aria-label")) ?? "";
      const bedCode = label.match(/^Empty bed (.+) — click to admit$/)?.[1];
      expect(bedCode, "extracted bed code from empty card").toBeTruthy();
      const code = bedCode!;

      // --- CREATE: L1 + wardable ---
      await emptyCard.click();
      const admitDialog = bedPage.getByRole("dialog", {
        name: new RegExp(`Admit to ${code}`),
      });
      await expect(admitDialog).toBeVisible();
      const initials = `E2E-${Date.now().toString(36).slice(-4)}`;
      await admitDialog.getByLabel(/initials/i).fill(initials);
      await setLevel(bedPage, "1");
      await setWardable(bedPage, true);
      await admitDialog.getByRole("button", { name: /^Admit$/ }).click();
      await expect(admitDialog).toBeHidden({ timeout: 10_000 });

      // Give realtime + refetch a beat to converge on both surfaces.
      await tvPage.goto("/board");
      await expect(tvPage.locator("div.uppercase", { hasText: new RegExp(`^${code}$`) }).first())
        .toBeVisible({ timeout: 15_000 });

      const afterCreateBed = await readBedBoardCard(bedPage, code);
      const afterCreateTv = await readTvBoardCard(tvPage, code);

      expect(afterCreateBed).toEqual({ level: "1", wardable: true });
      expect(
        afterCreateTv,
        `TV board must match bed board after create for ${code}`,
      ).toEqual(afterCreateBed);

      // --- EDIT: L2, no longer wardable ---
      const occupiedCard = bedPage.getByRole("button", {
        name: new RegExp(`^Bed ${code} — click to edit$`),
      });
      await occupiedCard.click();
      const editDialog = bedPage.getByRole("dialog", {
        name: new RegExp(`^${code} —`),
      });
      await expect(editDialog).toBeVisible();
      await setLevel(bedPage, "2");
      await setWardable(bedPage, false);
      await editDialog.getByRole("button", { name: /^Save$/ }).click();
      await expect(editDialog).toBeHidden({ timeout: 10_000 });

      // Refetch TV board and give realtime a beat to converge.
      await tvPage.reload();
      await expect(tvPage.locator("div.uppercase", { hasText: new RegExp(`^${code}$`) }).first())
        .toBeVisible({ timeout: 15_000 });

      // The TV board pill text changes to `L2 · d…`; poll until it does
      // so we don't race the refetch.
      await expect
        .poll(async () => (await readTvBoardCard(tvPage, code)).level, {
          timeout: 15_000,
          message: "TV board level pill should update to L2 after edit",
        })
        .toBe("2");

      const afterEditBed = await readBedBoardCard(bedPage, code);
      const afterEditTv = await readTvBoardCard(tvPage, code);

      expect(afterEditBed).toEqual({ level: "2", wardable: false });
      expect(
        afterEditTv,
        `TV board must match bed board after edit for ${code}`,
      ).toEqual(afterEditBed);

      // --- CLEANUP: discharge so the bed returns to the pool ---
      await occupiedCard.click();
      const editDialog2 = bedPage.getByRole("dialog", {
        name: new RegExp(`^${code} —`),
      });
      await expect(editDialog2).toBeVisible();
      bedPage.once("dialog", (d) => d.accept());
      await editDialog2.getByRole("button", { name: /^Discharge$/ }).click();
      // Some builds use a shadcn AlertDialog instead of window.confirm;
      // click the confirm button if it appears.
      const confirm = bedPage.getByRole("button", {
        name: /^(discharge|confirm|yes)$/i,
      });
      if (await confirm.count()) {
        await confirm.last().click().catch(() => {});
      }
      await expect(editDialog2).toBeHidden({ timeout: 10_000 });
    } finally {
      await bedCtx.close();
      await tvCtx.close();
    }
  });
});
