import { test, expect, type Page } from "@playwright/test";

/**
 * Non-admin clinicians must have NO route to raw audit-log data.
 *
 * This spec pins two independent controls, so a regression in either
 * layer fails the build:
 *
 *   1. UI gate. Signed in as a clinician (non-admin), /admin bounces
 *      to `/`, the "Audit log" tab never mounts anywhere in the app,
 *      and none of the audit table headings/controls (When / Action /
 *      Entity / ID / User columns, Rows-per-page selector, Next/Prev
 *      buttons) are reachable.
 *
 *   2. Data-plane gate. Under the same clinician session we probe the
 *      only two paths a browser could use to read audit rows:
 *        a. The `getAuditLog` server function, invoked from the page
 *           using the same bearer-token middleware the app registers
 *           (`attachSupabaseAuth`) — must throw (assertAdmin rejects).
 *        b. The Supabase Data API for `public.audit_log`, called with
 *           the clinician's session — must return an error or an empty
 *           row set (RLS + missing GRANT for non-admin roles).
 *      A "success + rows" from either probe would prove a clinician
 *      can pull raw audit_log data despite the UI hiding it.
 *
 * Requires E2E_EMAIL / E2E_PASSWORD (clinician).
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

test("non-admin clinician cannot reach audit tab or read raw audit log", async ({
  browser,
}) => {
  const clinicianEmail = requireEnv("E2E_EMAIL");
  const clinicianPassword = requireEnv("E2E_PASSWORD");

  const ctx = await browser.newContext({ storageState: undefined });
  const page = await ctx.newPage();

  // Track every getAuditLog response the browser sees during the run.
  // A 2xx here would be a hard failure regardless of what the UI shows.
  const auditResponses: Array<{ url: string; status: number; body: string }> =
    [];
  page.on("response", async (res) => {
    const url = res.url();
    if (!/getAuditLog|_serverFn/i.test(url)) return;
    let body = "";
    try {
      body = await res.text();
    } catch {
      /* redirects/empty */
    }
    if (/getAuditLog/i.test(url) || /"entity"|"action"|"diff"/.test(body)) {
      auditResponses.push({ url, status: res.status(), body });
    }
  });

  await signIn(page, clinicianEmail, clinicianPassword);

  // ------------------------------------------------------------------
  // 1. UI gate — /admin bounces, no audit surface anywhere.
  // ------------------------------------------------------------------
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/$/, { timeout: DEFAULT_TIMEOUT_MS });
  await expect(page.getByRole("tab", { name: /^audit log$/i })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /^audit log$/i })).toHaveCount(
    0,
  );
  // No audit-tab controls leaked into any other page either.
  await expect(page.getByLabel(/rows per page/i)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /next page/i })).toHaveCount(0);
  for (const heading of ["When", "Action", "Entity"]) {
    // The Audit tab is the only place these three appear together as
    // table headings; count 0 on a public page proves it never mounted.
    await expect(
      page.locator("th", { hasText: new RegExp(`^${heading}$`) }),
    ).toHaveCount(0);
  }

  // ------------------------------------------------------------------
  // 2a. Data-plane probe — Supabase Data API for public.audit_log.
  //
  // With the clinician's bearer token in localStorage, ask PostgREST
  // for audit_log rows directly. RLS + the "authenticated" grants must
  // return either an error or an empty rowset. Anything else is a leak.
  // ------------------------------------------------------------------
  const dataApiProbe = await page.evaluate(async () => {
    // Reuse the app's already-configured browser client — same bearer
    // token, same URL, same schema wiring. Anything importable via the
    // Vite module graph is fine.
    const mod = await import("/src/integrations/supabase/client.ts");
    const supabase = (mod as any).supabase;
    const res = await supabase
      .from("audit_log")
      .select("id,action,entity,diff,created_at,user_id")
      .limit(5);
    return {
      hasError: !!res.error,
      errorMessage: res.error?.message ?? null,
      errorCode: (res.error as any)?.code ?? null,
      rowCount: Array.isArray(res.data) ? res.data.length : null,
    };
  });

  // Acceptable outcomes: an error (RLS / grant / permission), OR an
  // empty rowset. Both prove the clinician cannot read audit rows.
  const dataApiSafe =
    dataApiProbe.hasError === true ||
    (dataApiProbe.hasError === false && dataApiProbe.rowCount === 0);
  expect(
    dataApiSafe,
    `Data API returned ${dataApiProbe.rowCount} audit_log rows to clinician (error: ${dataApiProbe.errorMessage ?? "none"})`,
  ).toBe(true);

  // ------------------------------------------------------------------
  // 2b. Data-plane probe — the `getAuditLog` server function itself.
  //
  // Import the server-fn from the app bundle and invoke it directly
  // from the page under the clinician's session. TanStack Start wraps
  // it as an RPC stub in the browser; calling it exercises the exact
  // pipeline used by the (hidden) admin UI. `assertAdmin` inside the
  // handler must throw.
  // ------------------------------------------------------------------
  const serverFnProbe = await page.evaluate(async () => {
    try {
      const mod = await import("/src/lib/admin.functions.ts");
      const getAuditLog = (mod as any).getAuditLog;
      if (typeof getAuditLog !== "function") {
        return { ok: false, reason: "server fn not exported" };
      }
      const result = await getAuditLog({ data: {} });
      const rowCount = Array.isArray((result as any)?.rows)
        ? (result as any).rows.length
        : null;
      return { ok: true, rowCount, sample: JSON.stringify(result).slice(0, 200) };
    } catch (err: any) {
      return {
        ok: false,
        reason: String(err?.message ?? err),
        status: err?.status ?? err?.response?.status ?? null,
      };
    }
  });

  // The call MUST NOT resolve with rows. `ok: false` (thrown) is the
  // expected outcome; `ok: true` with 0 rows would also be acceptable
  // in a truly empty environment, but we still fail on any row read.
  if (serverFnProbe.ok === true) {
    expect(
      serverFnProbe.rowCount,
      `getAuditLog returned ${serverFnProbe.rowCount} rows to clinician: ${serverFnProbe.sample}`,
    ).toBe(0);
  } else {
    // Reject genuinely: server-side unauthorized, forbidden, or admin
    // gate error — never a client-side "module not found".
    expect(
      /module|not exported|failed to fetch/i.test(serverFnProbe.reason ?? ""),
      `getAuditLog probe failed for the wrong reason: ${serverFnProbe.reason}`,
    ).toBe(false);
  }

  // Sweep every getAuditLog response observed during the run. Any 2xx
  // to a clinician session is a leak, even if the body was empty.
  for (const r of auditResponses) {
    expect(
      r.status,
      `getAuditLog returned ${r.status} to clinician (${r.url}): ${r.body.slice(0, 200)}`,
    ).toBeGreaterThanOrEqual(400);
  }

  await ctx.close();
});
