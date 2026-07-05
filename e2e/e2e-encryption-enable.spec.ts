import { test, expect } from "@playwright/test";

/**
 * End-to-end coverage for automatic end-to-end-encryption enablement.
 *
 * What this exercises (all in one flow, one browser context):
 *   1. Password sign-in via /auth — the app should auto-issue a recipient
 *      keypair AND unwrap it into the in-memory session using that password
 *      (see `ensureRecipientKey` in src/lib/e2e-auto-bootstrap.ts).
 *   2. /profile should render the "issued and unlocked" state without any
 *      "Enable encryption" / "Unlock now" CTA, and expose a public-key
 *      fingerprint — proof that wrap succeeded server-side and unwrap
 *      succeeded client-side.
 *   3. sessionStorage should hold the unwrapped private key blob keyed by
 *      `e2e.session.v1` — the tab-scoped cache the session hook writes.
 *   4. A full page reload must keep encryption unlocked (sessionStorage
 *      rehydration), i.e. the user is not asked for their password again.
 *   5. Clearing sessionStorage and reloading must drop back to the "locked"
 *      state — negative control that proves the ready state in step 4 was
 *      genuinely produced by the unwrapped key, not stale UI.
 *
 * We deliberately do NOT reuse the shared storage state from
 * `e2e/global.setup.ts`: that context signs in once and shares cookies with
 * every other spec, and we need to drive the /auth form ourselves so the
 * post-sign-in bootstrap actually runs against a fresh session.
 */

test.describe.configure({ mode: "serial" });
test.use({ storageState: undefined });

const DEFAULT_TIMEOUT_MS = 20_000;
const SESSION_KEY = "e2e.session.v1";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} must be set for this spec`);
  return v;
}

test("Password sign-in auto-issues + unwraps the recipient keypair, and the unlock survives a full reload", async ({
  page,
}) => {
  const email = requireEnv("E2E_EMAIL");
  const password = requireEnv("E2E_PASSWORD");

  // --- 1. Password sign-in ------------------------------------------------
  await page.goto("/auth");
  await expect(page.getByLabel(/email/i)).toBeVisible({ timeout: DEFAULT_TIMEOUT_MS });
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole("button", { name: /^sign in$/i }).click();

  // App lands on "/" after a successful sign-in.
  await expect(page).toHaveURL(/\/$/, { timeout: DEFAULT_TIMEOUT_MS });

  // --- 2. Profile shows "ready" without any enablement CTA ----------------
  await page.goto("/profile");
  await expect(
    page.getByText(/your keypair is issued and unlocked/i),
  ).toBeVisible({ timeout: DEFAULT_TIMEOUT_MS });
  await expect(page.getByText(/public key fingerprint/i)).toBeVisible({
    timeout: DEFAULT_TIMEOUT_MS,
  });
  // The two CTAs that would indicate encryption is NOT ready must be absent.
  await expect(page.getByRole("button", { name: /enable encryption/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /unlock now/i })).toHaveCount(0);

  // --- 3. sessionStorage holds the unwrapped private key blob -------------
  const persistedBefore = await page.evaluate(
    (key) => window.sessionStorage.getItem(key),
    SESSION_KEY,
  );
  expect(persistedBefore, "sessionStorage should hold the unwrapped keypair").toBeTruthy();
  const parsed = JSON.parse(persistedBefore as string) as {
    publicKey?: string;
    privateKeyB64?: string;
  };
  expect(parsed.publicKey, "publicKey persisted").toBeTruthy();
  expect(parsed.privateKeyB64, "unwrapped private key persisted").toBeTruthy();
  expect((parsed.privateKeyB64 ?? "").length).toBeGreaterThan(20);

  // --- 4. Full reload keeps encryption unlocked ---------------------------
  await page.reload();
  await expect(
    page.getByText(/your keypair is issued and unlocked/i),
  ).toBeVisible({ timeout: DEFAULT_TIMEOUT_MS });
  await expect(page.getByRole("button", { name: /unlock now/i })).toHaveCount(0);

  const persistedAfterReload = await page.evaluate(
    (key) => window.sessionStorage.getItem(key),
    SESSION_KEY,
  );
  expect(persistedAfterReload).toBe(persistedBefore);

  // --- 5. Negative control: clearing the session cache re-locks the key --
  await page.evaluate((key) => window.sessionStorage.removeItem(key), SESSION_KEY);
  await page.reload();
  await expect(
    page.getByRole("button", { name: /unlock now/i }),
  ).toBeVisible({ timeout: DEFAULT_TIMEOUT_MS });
  await expect(
    page.getByText(/your keypair is issued and unlocked/i),
  ).toHaveCount(0);
});
