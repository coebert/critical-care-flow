import { test, expect, type Page, type Locator } from "@playwright/test";

/**
 * Admin > Audit tab: pagination + sortable headers work AND every rendered
 * row on every page/sort combination stays fully redacted.
 *
 * The server (`getAuditLog`) already funnels every row through
 * `redactAuditDiff`. Sibling specs pin the payload cleanliness on the
 * initial page. This spec walks the admin through the interactive
 * surface — resize page → click Next → click Prev → toggle "When" sort
 * → switch to "Action" sort — and after EACH interaction re-scans the
 * rendered rows AND every captured `getAuditLog` response body for
 * `_enc` / `_ciphertext` / `_nonce` / `_hash` tokens or long
 * base64/hex blobs. A regression in redaction on any non-initial page
 * or sort direction fails this test even if the first page looks clean.
 *
 * Requires E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD.
 */

const DEFAULT_TIMEOUT_MS = 20_000;

const FORBIDDEN_SUBSTRINGS = [
  "_ciphertext",
  "_nonce",
  "_hash",
  '_enc"',
  "_enc:",
];

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

async function openAuditPanel(page: Page): Promise<Locator> {
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
  await waitForLoaded(panel);
  return panel;
}

async function waitForLoaded(panel: Locator) {
  await expect(async () => {
    const stillLoading = await panel
      .getByText(/^loading…$/i)
      .isVisible()
      .catch(() => false);
    expect(stillLoading).toBe(false);
  }).toPass({ timeout: DEFAULT_TIMEOUT_MS });
}

async function assertPanelClean(panel: Locator, where: string) {
  const text = (await panel.innerText()).toLowerCase();
  const html = (await panel.innerHTML()).toLowerCase();
  for (const needle of FORBIDDEN_SUBSTRINGS) {
    expect(text, `[${where}] panel text contained "${needle}"`).not.toContain(needle);
    expect(html, `[${where}] panel HTML contained "${needle}"`).not.toContain(needle);
  }
  const rawText = await panel.innerText();
  const blob = /[A-Za-z0-9+/=]{40,}/.exec(rawText);
  expect(
    blob,
    `[${where}] rendered a long base64-like blob (possible ciphertext): ${blob?.[0]?.slice(0, 60)}`,
  ).toBeNull();
}

function assertResponsesClean(bodies: string[], where: string) {
  for (const body of bodies) {
    const lower = body.toLowerCase();
    for (const needle of FORBIDDEN_SUBSTRINGS) {
      expect(
        lower,
        `[${where}] getAuditLog response body contained "${needle}"`,
      ).not.toContain(needle);
    }
  }
}

test("admin can paginate and sort the Audit tab with every rendered row fully redacted", async ({
  browser,
}) => {
  const adminEmail = requireEnv("E2E_ADMIN_EMAIL");
  const adminPassword = requireEnv("E2E_ADMIN_PASSWORD");

  const ctx = await browser.newContext({ storageState: undefined });
  const page = await ctx.newPage();

  // Capture every getAuditLog response body observed during the run.
  const auditBodies: string[] = [];
  page.on("response", async (res) => {
    const url = res.url();
    if (!/_serverFn|getAuditLog/i.test(url)) return;
    try {
      const body = await res.text();
      if (/"action"|"entity"|"diff"/.test(body)) auditBodies.push(body);
    } catch {
      // ignore unreadable bodies
    }
  });

  await signIn(page, adminEmail, adminPassword);
  const panel = await openAuditPanel(page);

  const summary = panel.locator('[aria-live="polite"]').first();
  await expect(summary).toBeVisible();

  const initialSummary = (await summary.innerText()).trim();
  if (/^0 entries$/i.test(initialSummary)) {
    test.info().annotations.push({
      type: "note",
      description: "Audit log empty in this environment — skipping paging flow.",
    });
    await assertPanelClean(panel, "initial (empty)");
    assertResponsesClean(auditBodies, "initial (empty)");
    await ctx.close();
    return;
  }

  // Baseline: initial page is clean.
  await assertPanelClean(panel, "initial page (created_at desc)");
  assertResponsesClean(auditBodies, "initial page (created_at desc)");

  // Force smallest page size to maximise chance of multi-page traversal.
  const pageSize = panel.getByLabel(/rows per page/i);
  await expect(pageSize).toBeVisible();
  const options = await pageSize.locator("option").allTextContents();
  const numeric = options
    .map((o) => Number(o.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  expect(numeric.length).toBeGreaterThan(0);
  const smallest = numeric[0];
  await pageSize.selectOption(String(smallest));
  await waitForLoaded(panel);
  await assertPanelClean(panel, `page size = ${smallest}`);

  // ---- Walk forward across pages, redaction check on every page ----
  const nextBtn = panel.getByRole("button", { name: /next page/i });
  const prevBtn = panel.getByRole("button", { name: /previous page/i });

  const summaryText = (await summary.innerText()).trim();
  const pagesMatch = summaryText.match(/of\s+(\d+)$/);
  const totalPages = pagesMatch ? Number(pagesMatch[1]) : 1;

  const pagesToWalk = Math.min(totalPages, 4); // cap for CI runtime
  for (let p = 2; p <= pagesToWalk; p++) {
    await expect(nextBtn).toBeEnabled();
    await nextBtn.click();
    await waitForLoaded(panel);
    await expect(async () => {
      const t = (await summary.innerText()).trim();
      const m = t.match(/page\s+(\d+)\s+of/i);
      expect(m, `page N summary: "${t}"`).not.toBeNull();
      expect(Number(m![1])).toBe(p);
    }).toPass({ timeout: DEFAULT_TIMEOUT_MS });
    await assertPanelClean(panel, `forward page ${p}`);
    assertResponsesClean(auditBodies, `forward page ${p}`);
  }

  // Walk back to page 1, still redacted at every stop.
  for (let p = pagesToWalk - 1; p >= 1; p--) {
    if (p < 1) break;
    await expect(prevBtn).toBeEnabled();
    await prevBtn.click();
    await waitForLoaded(panel);
    await expect(async () => {
      const t = (await summary.innerText()).trim();
      if (/^0 entries$/i.test(t)) return;
      const m = t.match(/page\s+(\d+)\s+of/i);
      expect(m).not.toBeNull();
      expect(Number(m![1])).toBe(p);
    }).toPass({ timeout: DEFAULT_TIMEOUT_MS });
    await assertPanelClean(panel, `back page ${p}`);
    assertResponsesClean(auditBodies, `back page ${p}`);
  }

  // ---- Sort toggles: each one triggers a fresh fetch. Assert per-sort. ----
  const whenHeader = panel.getByRole("button", { name: /^when/i });
  const actionHeader = panel.getByRole("button", { name: /^action/i });
  const entityHeader = panel.getByRole("button", { name: /^entity/i });

  await expect(whenHeader).toHaveAttribute("aria-sort", "descending");

  // When → asc
  await whenHeader.click();
  await waitForLoaded(panel);
  await expect(whenHeader).toHaveAttribute("aria-sort", "ascending", {
    timeout: DEFAULT_TIMEOUT_MS,
  });
  await assertPanelClean(panel, "sort When asc");
  assertResponsesClean(auditBodies, "sort When asc");

  // Action sort takes over
  await actionHeader.click();
  await waitForLoaded(panel);
  await expect(actionHeader).toHaveAttribute("aria-sort", /(ascending|descending)/, {
    timeout: DEFAULT_TIMEOUT_MS,
  });
  await expect(whenHeader).toHaveAttribute("aria-sort", "none");
  await assertPanelClean(panel, "sort Action first click");
  assertResponsesClean(auditBodies, "sort Action first click");

  // Toggle Action direction (asc ↔ desc)
  await actionHeader.click();
  await waitForLoaded(panel);
  await assertPanelClean(panel, "sort Action toggled");
  assertResponsesClean(auditBodies, "sort Action toggled");

  // Entity sort (best-effort — header may be absent in very narrow layouts)
  if ((await entityHeader.count()) > 0) {
    await entityHeader.first().click();
    await waitForLoaded(panel);
    await assertPanelClean(panel, "sort Entity");
    assertResponsesClean(auditBodies, "sort Entity");
  }

  // Final belt-and-braces: after ALL interactions, no captured response
  // body ever contained a forbidden token.
  assertResponsesClean(auditBodies, "final aggregate sweep");

  await ctx.close();
});
