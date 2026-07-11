import { test, expect, type Page } from "@playwright/test";

/**
 * Admin > Audit tab: never renders ciphertext / hash / nonce columns.
 *
 * `getAuditLog` runs redactAuditDiff on every diff before returning it,
 * dropping any `*_enc`, `*_ciphertext`, `*_nonce`, `*_hash` keys and
 * replacing sensitive plaintext columns with the literal "[encrypted]".
 * This spec pins that promise at the UI layer: no matter what audit
 * rows the admin session pulls back, the rendered Audit panel must
 * never expose ciphertext, hashes, nonces, or the crypto suffix keys.
 *
 * We also assert the server payload itself is clean by inspecting the
 * `getAuditLog` XHR — a defence-in-depth check that catches redaction
 * regressions even if the UI never displays diff bodies.
 *
 * Requires E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD.
 */

const DEFAULT_TIMEOUT_MS = 20_000;

const FORBIDDEN_SUBSTRINGS = [
  "_ciphertext",
  "_nonce",
  "_hash",
  "_enc\"", // JSON key ending in _enc followed by closing quote
  "_enc:",  // rendered/serialised form
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

test("audit tab UI never exposes ciphertext, hashes or nonces", async ({ browser }) => {
  const adminEmail = requireEnv("E2E_ADMIN_EMAIL");
  const adminPassword = requireEnv("E2E_ADMIN_PASSWORD");

  const ctx = await browser.newContext({ storageState: undefined });
  const page = await ctx.newPage();

  // Capture the server-fn response body for getAuditLog so we can assert
  // the wire payload is redacted, not just what happens to be painted.
  const auditResponses: string[] = [];
  page.on("response", async (res) => {
    const url = res.url();
    if (!/_serverFn|getAuditLog/i.test(url)) return;
    try {
      const body = await res.text();
      if (/"action"|"entity"|"diff"/.test(body)) auditResponses.push(body);
    } catch {
      // Some responses (redirects, empty bodies) can't be read; ignore.
    }
  });

  await signIn(page, adminEmail, adminPassword);
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin$/, { timeout: DEFAULT_TIMEOUT_MS });

  const auditTab = page.getByRole("tab", { name: /^audit log$/i });
  await expect(auditTab).toBeVisible({ timeout: DEFAULT_TIMEOUT_MS });
  await auditTab.click();

  const auditPanel = page
    .locator('[role="tabpanel"]')
    .filter({ has: page.getByRole("heading", { name: /^audit log$/i }) })
    .first();
  await expect(auditPanel).toBeVisible({ timeout: DEFAULT_TIMEOUT_MS });

  // Wait for the initial fetch to settle (Loading… gone).
  await expect(async () => {
    const stillLoading = await auditPanel
      .getByText(/^loading…$/i)
      .isVisible()
      .catch(() => false);
    expect(stillLoading).toBe(false);
  }).toPass({ timeout: DEFAULT_TIMEOUT_MS });

  // ---- 1. Rendered UI must not contain any forbidden token. ----
  // Check both text and raw HTML: text catches values, HTML catches
  // attribute payloads (data-* / title tooltips / hidden nodes).
  const panelText = (await auditPanel.innerText()).toLowerCase();
  const panelHtml = (await auditPanel.innerHTML()).toLowerCase();

  for (const needle of FORBIDDEN_SUBSTRINGS) {
    expect(panelText, `panel text contained forbidden token "${needle}"`).not.toContain(needle);
    expect(panelHtml, `panel HTML contained forbidden token "${needle}"`).not.toContain(needle);
  }
  // Long base64/hex blobs are a strong signal of ciphertext leaking.
  // Anything 40+ chars of continuous base64/hex in the rendered UI fails.
  const suspiciousBlob = /[A-Za-z0-9+/=]{40,}/.exec(await auditPanel.innerText());
  expect(
    suspiciousBlob,
    `panel rendered a long base64-like blob (possible ciphertext): ${suspiciousBlob?.[0]?.slice(0, 60)}`,
  ).toBeNull();

  // ---- 2. Server payload itself must be redacted. ----
  // We may or may not have captured a response depending on caching; only
  // assert cleanliness for the ones we did see.
  for (const body of auditResponses) {
    const lower = body.toLowerCase();
    for (const needle of FORBIDDEN_SUBSTRINGS) {
      expect(lower, `getAuditLog response body contained forbidden token "${needle}"`).not.toContain(
        needle,
      );
    }
  }

  await ctx.close();
});
