import { test, expect } from "@playwright/test";

/**
 * Referral → note lifecycle + note history + admin-audit block.
 *
 * Flow (single browser context):
 *   1. Fresh /auth sign-in so the E2E-encryption bootstrap auto-issues
 *      + unlocks the recipient keypair for this tab. Shared storage state
 *      from global.setup.ts is NOT enough because it doesn't guarantee
 *      the session-scoped private key blob exists in sessionStorage, and
 *      posting an E2E note requires an unlocked key.
 *   2. Create a referral via /referrals/new.
 *   3. On the referral detail page, post a note via the NoteComposer.
 *   4. Edit that note, confirm the "(edited)" marker + new body.
 *   5. Open the note History dialog and verify BOTH the create and
 *      update entries are present, with the before/after bodies.
 *   6. Navigate to /notifications-audit — a non-admin clinician must
 *      be redirected back to `/` (the admin-only loader gate).
 */

test.describe.configure({ mode: "serial" });
test.use({ storageState: undefined });

const DEFAULT_TIMEOUT_MS = 20_000;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} must be set for this spec`);
  return v;
}

const uniqueHospitalNumber = () =>
  `E2E-NOTE-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

test("create referral, add + edit a note, inspect note history, and stay blocked from admin audit", async ({
  page,
}) => {
  const email = requireEnv("E2E_EMAIL");
  const password = requireEnv("E2E_PASSWORD");
  const hospitalNumber = uniqueHospitalNumber();
  const reason = `Playwright note-history ${hospitalNumber}`;
  const originalBody = `Initial clinical note ${hospitalNumber}`;
  const updatedBody = `Updated clinical note ${hospitalNumber}`;

  // --- 1. Sign in fresh so E2E keys auto-unlock in this tab -------------
  await page.goto("/auth");
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: DEFAULT_TIMEOUT_MS });

  // --- 2. Create a referral --------------------------------------------
  await page.goto("/referrals/new");
  await page.getByLabel(/hospital number/i).fill(hospitalNumber);
  await page.getByLabel(/reason for referral/i).fill(reason);

  const isTest = page.getByLabel(/test|demonstration/i);
  if (await isTest.count()) {
    await isTest.first().check().catch(() => {});
  }

  await page.getByRole("button", { name: /save referral/i }).click();
  await expect(page).toHaveURL(/\/referrals\/[0-9a-f-]{36}$/i, {
    timeout: DEFAULT_TIMEOUT_MS,
  });
  await expect(page.getByText(reason)).toBeVisible();

  // --- 3. Post a note ---------------------------------------------------
  const composer = page.getByPlaceholder(
    /seen in ED resus|awaiting bloods|re-review/i,
  );
  await expect(composer).toBeVisible({ timeout: DEFAULT_TIMEOUT_MS });
  await composer.fill(originalBody);

  const postBtn = page
    .getByRole("button", { name: /post( encrypted)? note/i })
    .first();
  await postBtn.click();

  // If the pending-action unlock modal pops (session key not yet unlocked
  // in this fresh tab), satisfy it with the same account password.
  const unlockPw = page.getByLabel(/^password$/i);
  if (
    await unlockPw.first().isVisible({ timeout: 2000 }).catch(() => false)
  ) {
    await unlockPw.first().fill(password);
    const confirmPw = page.getByLabel(/confirm password/i);
    if (await confirmPw.count()) await confirmPw.fill(password);
    await page
      .getByRole("button", { name: /^(unlock|enable encryption|continue)/i })
      .first()
      .click();
  }

  const noteLocator = page.getByText(originalBody, { exact: true });
  await expect(noteLocator).toBeVisible({ timeout: DEFAULT_TIMEOUT_MS });

  // --- 4. Edit the note -------------------------------------------------
  // Edit/Delete/History live in a hover-revealed row on each NoteItem.
  const noteBlock = noteLocator.locator(
    'xpath=ancestor::*[contains(@class,"group")][1]',
  );
  await noteBlock.hover();
  await noteBlock.getByRole("button", { name: /^edit$/i }).click();

  const editArea = noteBlock.locator("textarea");
  await editArea.fill(updatedBody);
  await noteBlock.getByRole("button", { name: /^save$/i }).click();

  await expect(page.getByText(updatedBody, { exact: true })).toBeVisible({
    timeout: DEFAULT_TIMEOUT_MS,
  });
  await expect(page.getByText(/\(edited\)/i).first()).toBeVisible();

  // --- 5. Note history dialog contains create + update entries ---------
  const updatedNoteBlock = page
    .getByText(updatedBody, { exact: true })
    .locator('xpath=ancestor::*[contains(@class,"group")][1]');
  await updatedNoteBlock.hover();
  await updatedNoteBlock.getByRole("button", { name: /^history$/i }).click();

  const dialog = page.getByRole("dialog", { name: /note audit trail/i });
  await expect(dialog).toBeVisible({ timeout: DEFAULT_TIMEOUT_MS });

  // The create entry — body captured at post time.
  await expect(dialog.getByText(/create/i).first()).toBeVisible();
  await expect(dialog.getByText(originalBody).first()).toBeVisible();

  // The update entry — before/after captured in the diff.
  await expect(dialog.getByText(/update/i).first()).toBeVisible();
  await expect(dialog.getByText(/^before:?$/i).first()).toBeVisible();
  await expect(dialog.getByText(/^after:?$/i).first()).toBeVisible();
  await expect(dialog.getByText(updatedBody).first()).toBeVisible();

  // Close the dialog.
  await page.keyboard.press("Escape");

  // --- 6. Admin-only audit page redirects a non-admin clinician --------
  await page.goto("/notifications-audit");
  await expect(page).toHaveURL(/\/$/, { timeout: DEFAULT_TIMEOUT_MS });
  await expect(
    page.getByRole("heading", { name: /notifications? audit/i }),
  ).toHaveCount(0);
});
