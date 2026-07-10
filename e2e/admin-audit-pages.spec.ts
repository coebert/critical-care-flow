import { test, expect, type Page } from "@playwright/test";

/**
 * Admin can open /permissions and /notifications-audit and view recent
 * audit entries.
 *
 * Signs in as an admin (E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD), navigates
 * directly to each admin page, and asserts:
 *   - /permissions renders the "Role & Permission Matrix" heading and at
 *     least one policy table (referrals).
 *   - /notifications-audit renders the "Notification delivery audit"
 *     heading and either a data row in the table OR the explicit empty
 *     state — both are acceptable "the page loaded, RBAC passed, and the
 *     delivery-audit query returned" outcomes.
 *
 * Both routes have `beforeLoad` gates that redirect non-admins to `/`,
 * so reaching them under the admin session also implicitly verifies
 * `has_role(uid, 'admin')` succeeds for this user.
 */

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

test("admin can open /permissions and /notifications-audit and see recent entries", async ({
  browser,
}) => {
  const adminEmail = requireEnv("E2E_ADMIN_EMAIL");
  const adminPassword = requireEnv("E2E_ADMIN_PASSWORD");

  const ctx = await browser.newContext({ storageState: undefined });
  const page = await ctx.newPage();

  await signIn(page, adminEmail, adminPassword);

  // ------------------------------------------------------------------
  // /permissions
  // ------------------------------------------------------------------
  await page.goto("/permissions");
  await expect(page).toHaveURL(/\/permissions$/, {
    timeout: DEFAULT_TIMEOUT_MS,
  });
  await expect(
    page.getByRole("heading", { name: /role\s*&?\s*permission matrix/i }),
  ).toBeVisible({ timeout: DEFAULT_TIMEOUT_MS });
  // At least the `referrals` policy table renders.
  await expect(page.getByText(/^referrals$/).first()).toBeVisible();
  // Sanity: an Allow or Deny badge appears somewhere in the matrix.
  await expect(
    page.getByText(/^(Allow|Deny)$/).first(),
  ).toBeVisible();

  // ------------------------------------------------------------------
  // /notifications-audit
  // ------------------------------------------------------------------
  await page.goto("/notifications-audit");
  await expect(page).toHaveURL(/\/notifications-audit$/, {
    timeout: DEFAULT_TIMEOUT_MS,
  });
  await expect(
    page.getByRole("heading", { name: /notification delivery audit/i }),
  ).toBeVisible({ timeout: DEFAULT_TIMEOUT_MS });

  // Wait for the initial fetch to settle: either at least one data row
  // in the audit table, OR the explicit empty state. Both prove the
  // server function returned successfully under the admin session.
  const emptyState = page.getByText(
    /no delivery records match the current filters/i,
  );
  const dataRow = page
    .getByRole("row")
    .filter({ has: page.locator("td") })
    .first();

  await expect(async () => {
    const hasEmpty = await emptyState.isVisible().catch(() => false);
    const hasRow = await dataRow.isVisible().catch(() => false);
    expect(hasEmpty || hasRow).toBe(true);
  }).toPass({ timeout: DEFAULT_TIMEOUT_MS });

  await ctx.close();
});
