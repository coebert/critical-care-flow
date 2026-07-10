import { test, expect, type Page } from "@playwright/test";

/**
 * Notification-audit RBAC coverage.
 *
 * Two-user flow (single spec, two browser contexts):
 *
 *   1. A clinician (E2E_EMAIL / E2E_PASSWORD) creates a referral, then
 *      updates its status. That fires two notification-fanout events:
 *      kind="new" on create, kind="updated" on the status change.
 *      Both are recorded in `notification_deliveries`.
 *
 *   2. The same clinician navigates to `/notifications-audit`. The
 *      route's `beforeLoad` calls `has_role('admin')`; a non-admin is
 *      redirected back to `/`. We assert the URL AND the absence of the
 *      "Notification delivery audit" heading — a redirect alone can be
 *      masked by a coincidental client-side match.
 *
 *   3. An admin (E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD) opens
 *      `/notifications-audit` in a fresh context and confirms the audit
 *      table renders AND contains a row for kind="new" and one for
 *      kind="updated" tied to the referral we just created.
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
  `E2E-AUDIT-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

test("clinicians are blocked from /notifications-audit; admins see new + updated events", async ({
  browser,
}) => {
  const clinicianEmail = requireEnv("E2E_EMAIL");
  const clinicianPassword = requireEnv("E2E_PASSWORD");
  const adminEmail = requireEnv("E2E_ADMIN_EMAIL");
  const adminPassword = requireEnv("E2E_ADMIN_PASSWORD");

  const hospitalNumber = uniqueHospitalNumber();
  const reason = `Playwright audit RBAC ${hospitalNumber}`;

  // ---------------------------------------------------------------------
  // 1. Clinician: create + status-update the referral → fanout two events.
  // ---------------------------------------------------------------------
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
  const referralId = clinician.url().split("/").pop()!;
  const referralIdShort = referralId.slice(0, 8);

  // Change status → produces a kind="updated" delivery row.
  const statusPicker = clinician.getByRole("combobox").first();
  await statusPicker.click();
  // Any transition off "pending" works — accepted is always reachable.
  await clinician
    .getByRole("option", { name: /accepted/i })
    .first()
    .click();
  await clinician
    .getByRole("button", { name: /^save/i })
    .first()
    .click();

  // Wait for the save toast so the fanout has definitely enqueued
  // before we tab over to the admin view.
  await expect(
    clinician.getByText(/saved|updated/i).first(),
  ).toBeVisible({ timeout: DEFAULT_TIMEOUT_MS });

  // -------------------------------------------------------------------
  // 2. Clinician cannot reach the notification-audit page.
  // -------------------------------------------------------------------
  await clinician.goto("/notifications-audit");
  await expect(clinician).toHaveURL(/\/$/, { timeout: DEFAULT_TIMEOUT_MS });
  await expect(
    clinician.getByRole("heading", { name: /notification delivery audit/i }),
  ).toHaveCount(0);

  await clinicianCtx.close();

  // -------------------------------------------------------------------
  // 3. Admin sees the audit page AND both event rows.
  // -------------------------------------------------------------------
  const adminCtx = await browser.newContext({ storageState: undefined });
  const admin = await adminCtx.newPage();

  await signIn(admin, adminEmail, adminPassword);

  await admin.goto("/notifications-audit");
  await expect(admin).toHaveURL(/\/notifications-audit$/, {
    timeout: DEFAULT_TIMEOUT_MS,
  });
  await expect(
    admin.getByRole("heading", { name: /notification delivery audit/i }),
  ).toBeVisible({ timeout: DEFAULT_TIMEOUT_MS });

  // Load more pages until our referral's rows show up, or bail after a
  // reasonable number of pages. Rows are newest-first, so the ones we
  // just created should surface on the first page in practice.
  const findRowsFor = async (kindLabel: RegExp) => {
    for (let i = 0; i < 6; i += 1) {
      const link = admin
        .getByRole("link", { name: new RegExp(referralIdShort, "i") })
        .first();
      if (await link.count()) {
        const row = link.locator("xpath=ancestor::tr[1]");
        const matching = row.filter({ has: admin.getByText(kindLabel) });
        if (await matching.count()) return matching.first();
      }
      const more = admin.getByRole("button", { name: /load more/i });
      if (!(await more.isVisible().catch(() => false))) break;
      await more.click();
      await admin.waitForTimeout(400);
    }
    return null;
  };

  const newRow = await findRowsFor(/^new$/i);
  expect(newRow, "expected a kind=new row for the referral").not.toBeNull();
  await expect(newRow!).toBeVisible();

  const updatedRow = await findRowsFor(/^updated$/i);
  expect(
    updatedRow,
    "expected a kind=updated row for the referral",
  ).not.toBeNull();
  await expect(updatedRow!).toBeVisible();

  await adminCtx.close();
});
