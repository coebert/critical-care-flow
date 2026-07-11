import { test, expect, type Page } from "@playwright/test";

/**
 * Admin > Audit tab: pagination + sortable headers work for admins,
 * and non-admins can neither reach nor read audit results.
 *
 * Assertions:
 *   1. Admin loads /admin, opens Audit log, and:
 *      - sees "Showing X–Y of Z — page 1 of N" summary (or empty state
 *        if the environment has zero rows — recorded and skipped);
 *      - changing "Rows per page" resets to page 1 and updates the
 *        summary's page-size math;
 *      - clicking Next advances to page 2 when N > 1, with First/Prev
 *        enabled and offsets updating; Prev returns to page 1;
 *      - clicking the "When" sortable header toggles aria-sort between
 *        "ascending" and "descending"; clicking "Action" moves the
 *        aria-sort marker onto that header and leaves "When" as "none".
 *   2. Clinician (non-admin) hitting /admin is bounced to `/` and never
 *      sees the Audit tab, table headings, or pagination controls.
 *
 * Requires E2E_EMAIL / E2E_PASSWORD (clinician) and
 * E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD (admin).
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

async function openAuditPanel(page: Page) {
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin$/, { timeout: DEFAULT_TIMEOUT_MS });
  const tab = page.getByRole("tab", { name: /^audit log$/i });
  await expect(tab).toBeVisible({ timeout: DEFAULT_TIMEOUT_MS });
  await tab.click();
  const panel = page
    .locator('[role="tabpanel"]')
    .filter({ has: page.getByRole("heading", { name: /^audit log$/i }) })
    .first();
  await expect(panel).toBeVisible({ timeout: DEFAULT_TIMEOUT_MS });
  // Wait for initial fetch to settle (no more "Loading…").
  await expect(async () => {
    const stillLoading = await panel
      .getByText(/^loading…$/i)
      .isVisible()
      .catch(() => false);
    expect(stillLoading).toBe(false);
  }).toPass({ timeout: DEFAULT_TIMEOUT_MS });
  return panel;
}

test("admin audit tab: pagination summary, page-size reset, and Next/Prev navigation", async ({
  browser,
}) => {
  const adminEmail = requireEnv("E2E_ADMIN_EMAIL");
  const adminPassword = requireEnv("E2E_ADMIN_PASSWORD");

  const ctx = await browser.newContext({ storageState: undefined });
  const page = await ctx.newPage();

  await signIn(page, adminEmail, adminPassword);
  const panel = await openAuditPanel(page);

  const summary = panel.locator('[aria-live="polite"]').first();
  await expect(summary).toBeVisible();
  const initialSummary = (await summary.innerText()).trim();

  // Empty environments legitimately show "0 entries" — record and skip
  // pagination flow assertions that require rows.
  if (/^0 entries$/i.test(initialSummary)) {
    test.info().annotations.push({
      type: "note",
      description: "Audit log empty in this environment — skipping paging flow.",
    });
  } else {
    // "Showing 1–N of TOTAL — page 1 of PAGES"
    const match = initialSummary.match(
      /Showing\s+(\d+)–(\d+)\s+of\s+(\d+)\s+—\s+page\s+(\d+)\s+of\s+(\d+)/i,
    );
    expect(match, `unexpected summary format: "${initialSummary}"`).not.toBeNull();
    const total = Number(match![3]);
    const currentPage = Number(match![4]);
    const totalPages = Number(match![5]);
    expect(currentPage).toBe(1);
    expect(totalPages).toBeGreaterThanOrEqual(1);

    // ---- Rows-per-page control resets offset and re-renders summary. ----
    const pageSize = panel.getByLabel(/rows per page/i);
    await expect(pageSize).toBeVisible();
    // Pick the smallest option available to maximise chance of multi-page.
    const options = await pageSize.locator("option").allTextContents();
    const numericOptions = options
      .map((o) => Number(o.trim()))
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);
    expect(numericOptions.length).toBeGreaterThan(0);
    const smallest = numericOptions[0];
    await pageSize.selectOption(String(smallest));

    // After changing page size we should be back on page 1 and the
    // upper bound should be <= smallest.
    await expect(async () => {
      const txt = (await summary.innerText()).trim();
      if (/^0 entries$/i.test(txt)) return; // nothing to assert
      const m = txt.match(
        /Showing\s+(\d+)–(\d+)\s+of\s+(\d+)\s+—\s+page\s+(\d+)\s+of\s+(\d+)/i,
      );
      expect(m, `summary after resize: "${txt}"`).not.toBeNull();
      expect(Number(m![1])).toBe(1);
      expect(Number(m![2])).toBeLessThanOrEqual(smallest);
      expect(Number(m![4])).toBe(1);
    }).toPass({ timeout: DEFAULT_TIMEOUT_MS });

    // ---- Next / Prev only when there is more than one page. ----
    const afterResize = (await summary.innerText()).trim();
    const m2 = afterResize.match(/of\s+(\d+)$/);
    const pagesNow = m2 ? Number(m2[1]) : 1;

    const nextBtn = panel.getByRole("button", { name: /next page/i });
    const prevBtn = panel.getByRole("button", { name: /previous page/i });
    const firstBtn = panel.getByRole("button", { name: /first page/i });

    if (pagesNow > 1) {
      await expect(prevBtn).toBeDisabled();
      await expect(firstBtn).toBeDisabled();
      await expect(nextBtn).toBeEnabled();
      await nextBtn.click();

      await expect(async () => {
        const t = (await summary.innerText()).trim();
        const m = t.match(/page\s+(\d+)\s+of/i);
        expect(m).not.toBeNull();
        expect(Number(m![1])).toBe(2);
      }).toPass({ timeout: DEFAULT_TIMEOUT_MS });

      await expect(prevBtn).toBeEnabled();
      await prevBtn.click();

      await expect(async () => {
        const t = (await summary.innerText()).trim();
        const m = t.match(/page\s+(\d+)\s+of/i);
        expect(m).not.toBeNull();
        expect(Number(m![1])).toBe(1);
      }).toPass({ timeout: DEFAULT_TIMEOUT_MS });
    } else {
      // Single-page result set: Next must be disabled at rest.
      await expect(nextBtn).toBeDisabled();
      expect(total).toBeGreaterThanOrEqual(1);
    }
  }

  // ---- Sortable headers: aria-sort toggles and moves between columns. ----
  const whenHeader = panel.getByRole("button", { name: /^when/i });
  const actionHeader = panel.getByRole("button", { name: /^action/i });

  // "When" starts as the active sort (default created_at desc).
  await expect(whenHeader).toHaveAttribute("aria-sort", "descending");
  await whenHeader.click();
  await expect(whenHeader).toHaveAttribute("aria-sort", "ascending", {
    timeout: DEFAULT_TIMEOUT_MS,
  });

  await actionHeader.click();
  // aria-sort now moves to Action; When goes back to "none".
  await expect(actionHeader).toHaveAttribute("aria-sort", /(ascending|descending)/, {
    timeout: DEFAULT_TIMEOUT_MS,
  });
  await expect(whenHeader).toHaveAttribute("aria-sort", "none");

  await ctx.close();
});

test("non-admin cannot access audit results", async ({ browser }) => {
  const clinicianEmail = requireEnv("E2E_EMAIL");
  const clinicianPassword = requireEnv("E2E_PASSWORD");

  const ctx = await browser.newContext({ storageState: undefined });
  const page = await ctx.newPage();

  // Capture any getAuditLog response the browser sees — should be none,
  // or only 401/403. A 200 with rows would prove the gate is broken.
  const auditStatuses: Array<{ url: string; status: number }> = [];
  page.on("response", (res) => {
    const url = res.url();
    if (/getAuditLog|_serverFn.*audit/i.test(url)) {
      auditStatuses.push({ url, status: res.status() });
    }
  });

  await signIn(page, clinicianEmail, clinicianPassword);

  // Direct navigation to /admin bounces to /.
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/$/, { timeout: DEFAULT_TIMEOUT_MS });

  // No Audit tab, no audit table headings, no pagination controls.
  await expect(page.getByRole("tab", { name: /^audit log$/i })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /^audit log$/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /next page/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /previous page/i })).toHaveCount(0);
  await expect(page.getByLabel(/rows per page/i)).toHaveCount(0);

  // Any getAuditLog request that did fire under the clinician session
  // must have been rejected by the server (never 2xx).
  for (const r of auditStatuses) {
    expect(
      r.status,
      `getAuditLog returned ${r.status} for non-admin (${r.url})`,
    ).toBeGreaterThanOrEqual(400);
  }

  await ctx.close();
});
