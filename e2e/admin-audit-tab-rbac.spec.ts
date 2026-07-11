import { test, expect, type Page } from "@playwright/test";

/**
 * Admin > Audit tab RBAC.
 *
 * The Audit log tab in /admin exposes privileged information (who did
 * what to which entity). It must be reachable only by authenticated
 * critical-care team members with the admin role. We assert three
 * personas from the same starting point:
 *
 *   1. Unauthenticated visitor: hitting `/admin` (or the tab deep-link)
 *      redirects to `/auth` and no admin UI renders.
 *   2. Signed-in clinician (non-admin): `/admin` bounces to `/` and the
 *      "Audit log" tab is never mounted.
 *   3. Signed-in admin: `/admin` loads, the "Audit log" tab is present,
 *      selecting it reveals the audit table headings (When / Action /
 *      Entity / ID / User) and either at least one row or an empty
 *      loading-complete state — both prove `getAuditLog` returned under
 *      the admin session.
 *
 * Requires E2E_EMAIL / E2E_PASSWORD (clinician) and E2E_ADMIN_EMAIL /
 * E2E_ADMIN_PASSWORD (admin).
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

test("audit tab is gated to authenticated admins only", async ({ browser }) => {
  const clinicianEmail = requireEnv("E2E_EMAIL");
  const clinicianPassword = requireEnv("E2E_PASSWORD");
  const adminEmail = requireEnv("E2E_ADMIN_EMAIL");
  const adminPassword = requireEnv("E2E_ADMIN_PASSWORD");

  // ------------------------------------------------------------------
  // 1. Unauthenticated visitor is redirected to /auth.
  // ------------------------------------------------------------------
  const anonCtx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const anon = await anonCtx.newPage();

  await anon.goto("/admin");
  await expect(anon).toHaveURL(/\/auth(\?|$)/, { timeout: DEFAULT_TIMEOUT_MS });
  // Sign-in affordance is visible; admin chrome is not.
  await expect(
    anon.getByRole("button", { name: /^sign in$/i }),
  ).toBeVisible();
  await expect(anon.getByRole("tab", { name: /^audit log$/i })).toHaveCount(0);
  await expect(anon.getByRole("heading", { name: /^audit log$/i })).toHaveCount(0);
  await anonCtx.close();

  // ------------------------------------------------------------------
  // 2. Clinician (signed in, no admin role) is bounced from /admin.
  // ------------------------------------------------------------------
  const clinicianCtx = await browser.newContext({ storageState: undefined });
  const clinician = await clinicianCtx.newPage();

  await signIn(clinician, clinicianEmail, clinicianPassword);
  await clinician.goto("/admin");

  // Route beforeLoad redirects non-admins to "/".
  await expect(clinician).toHaveURL(/\/$/, { timeout: DEFAULT_TIMEOUT_MS });
  await expect(clinician.getByRole("tab", { name: /^audit log$/i })).toHaveCount(0);
  await expect(
    clinician.getByRole("heading", { name: /^audit log$/i }),
  ).toHaveCount(0);
  await clinicianCtx.close();

  // ------------------------------------------------------------------
  // 3. Admin can open /admin, select the Audit tab, and read rows.
  // ------------------------------------------------------------------
  const adminCtx = await browser.newContext({ storageState: undefined });
  const admin = await adminCtx.newPage();

  await signIn(admin, adminEmail, adminPassword);
  await admin.goto("/admin");
  await expect(admin).toHaveURL(/\/admin$/, { timeout: DEFAULT_TIMEOUT_MS });

  const auditTab = admin.getByRole("tab", { name: /^audit log$/i });
  await expect(auditTab).toBeVisible({ timeout: DEFAULT_TIMEOUT_MS });
  await auditTab.click();

  // Panel heading is scoped to the audit TabsContent to avoid matching
  // the tab trigger itself.
  const auditPanel = admin
    .locator('[role="tabpanel"]')
    .filter({ has: admin.getByRole("heading", { name: /^audit log$/i }) })
    .first();
  await expect(auditPanel).toBeVisible({ timeout: DEFAULT_TIMEOUT_MS });

  // Column headings prove getAuditLog resolved and the table rendered.
  for (const heading of ["When", "Action", "Entity", "ID", "User"]) {
    await expect(
      auditPanel.locator("th", { hasText: new RegExp(`^${heading}$`) }),
    ).toBeVisible({ timeout: DEFAULT_TIMEOUT_MS });
  }

  // Wait for initial fetch to settle: either at least one data row, or
  // an empty tbody. Both prove the admin-only server fn returned OK
  // (a 403 would leave the "Loading…" placeholder in place).
  await expect(async () => {
    const stillLoading = await auditPanel
      .getByText(/^loading…$/i)
      .isVisible()
      .catch(() => false);
    expect(stillLoading).toBe(false);
  }).toPass({ timeout: DEFAULT_TIMEOUT_MS });

  await adminCtx.close();
});
