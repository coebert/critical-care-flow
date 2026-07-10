import { test, expect, type Page } from "@playwright/test";

/**
 * Audit-UI RBAC coverage.
 *
 * The referral audit trail card and every note's "History" button expose
 * privileged information (who read what, before/after diffs, delete
 * records). They are admin-only in the UI.
 *
 * Edit / Delete on referrals and notes are gated by ownership rather
 * than role — a clinician CAN edit and delete their own referrals and
 * notes. Only the read-only `viewer` role has those hidden, and it is
 * covered by its own spec. So this spec asserts, from the perspective
 * of the same referral in two browser contexts:
 *
 *   1. Clinician (E2E_EMAIL / E2E_PASSWORD): the "Referral audit trail"
 *      heading is absent, and hovering a note reveals Edit + Delete
 *      (creator affordances) but NO "History" button.
 *   2. Admin  (E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD): the audit trail
 *      heading is visible, and hovering the same note reveals a
 *      "History" button.
 *
 * Requires E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD in addition to the
 * shared clinician credentials.
 */

test.describe.configure({ mode: "serial" });

const DEFAULT_TIMEOUT_MS = 20_000;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} must be set for this spec`);
  return v;
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/auth");
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: DEFAULT_TIMEOUT_MS });
}

const uniqueHospitalNumber = () =>
  `E2E-AUDITUI-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

test("audit UI is admin-only; clinicians never see referral audit trail or note history", async ({
  browser,
}) => {
  const clinicianEmail = requireEnv("E2E_EMAIL");
  const clinicianPassword = requireEnv("E2E_PASSWORD");
  const adminEmail = requireEnv("E2E_ADMIN_EMAIL");
  const adminPassword = requireEnv("E2E_ADMIN_PASSWORD");

  const hospitalNumber = uniqueHospitalNumber();
  const reason = `Playwright audit-UI RBAC ${hospitalNumber}`;
  const noteBody = `Playwright audit-UI note ${hospitalNumber}`;

  // -------------------------------------------------------------------
  // 1. Clinician: create a referral + post one note. Assert no audit UI.
  // -------------------------------------------------------------------
  const clinicianCtx = await browser.newContext({ storageState: undefined });
  const clinician = await clinicianCtx.newPage();

  await signIn(clinician, clinicianEmail, clinicianPassword);

  await clinician.goto("/referrals/new");
  await clinician.getByLabel(/hospital number/i).fill(hospitalNumber);
  await clinician.getByLabel(/reason for referral/i).fill(reason);
  const isTest = clinician.getByLabel(/test|demonstration/i);
  if (await isTest.count()) {
    await isTest.first().check().catch(() => {});
  }
  await clinician.getByRole("button", { name: /save referral/i }).click();

  await expect(clinician).toHaveURL(/\/referrals\/[0-9a-f-]{36}$/i, {
    timeout: DEFAULT_TIMEOUT_MS,
  });
  const detailUrl = clinician.url();

  // Post a note so we have a NoteItem row to inspect for a History button.
  const composer = clinician
    .getByPlaceholder(/awaiting bloods|re-review|encrypted note/i)
    .first();
  await composer.fill(noteBody);
  const postButton = clinician
    .getByRole("button", { name: /post encrypted note|unlock & post/i })
    .first();
  await postButton.click();

  // If E2E encryption is locked, the unlock modal appears; reuse the
  // clinician password. If the modal isn't there, the note posted
  // straight away and we can just proceed.
  const unlockPassword = clinician.getByLabel(/password/i).first();
  if (await unlockPassword.isVisible().catch(() => false)) {
    await unlockPassword.fill(clinicianPassword);
    await clinician
      .getByRole("button", { name: /^(unlock|enable)/i })
      .first()
      .click();
  }
  await expect(clinician.getByText(noteBody)).toBeVisible({
    timeout: DEFAULT_TIMEOUT_MS,
  });

  // (a) Referral audit trail card is NOT rendered for clinicians.
  await expect(
    clinician.getByRole("heading", { name: /referral audit trail/i }),
  ).toHaveCount(0);

  // (b) Note History button is NOT rendered for clinicians. Hover the
  // note row to reveal the opacity-0 action strip; Edit / Delete
  // (creator affordances) must still appear, but "History" must not.
  const noteRow = clinician
    .locator("div.group", { hasText: noteBody })
    .first();
  await noteRow.hover();
  await expect(
    noteRow.getByRole("button", { name: /^history$/i }),
  ).toHaveCount(0);
  await expect(
    noteRow.getByRole("button", { name: /^edit$/i }),
  ).toBeVisible();
  await expect(
    noteRow.getByRole("button", { name: /^delete$/i }),
  ).toBeVisible();

  await clinicianCtx.close();

  // -------------------------------------------------------------------
  // 2. Admin: same referral shows audit trail card + note history.
  // -------------------------------------------------------------------
  const adminCtx = await browser.newContext({ storageState: undefined });
  const admin = await adminCtx.newPage();

  await signIn(admin, adminEmail, adminPassword);
  await admin.goto(detailUrl);
  await expect(admin.getByText(reason)).toBeVisible({
    timeout: DEFAULT_TIMEOUT_MS,
  });

  // (a) Referral audit trail card is rendered for admins.
  await expect(
    admin.getByRole("heading", { name: /referral audit trail/i }),
  ).toBeVisible({ timeout: DEFAULT_TIMEOUT_MS });

  // (b) Note History button is rendered for admins. The note body may
  // be encrypted for the admin, so match the row by author metadata /
  // recipient info rather than the plaintext body; the group class +
  // any note row is sufficient because there's only one note here.
  const adminNoteRow = admin.locator("div.group").filter({
    has: admin.getByRole("button", { name: /^history$/i }),
  }).first();
  await adminNoteRow.hover();
  await expect(
    adminNoteRow.getByRole("button", { name: /^history$/i }),
  ).toBeVisible();

  await adminCtx.close();
});
