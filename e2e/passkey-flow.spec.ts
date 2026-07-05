import {
  test,
  expect,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
  type TestInfo,
} from "@playwright/test";

/**
 * End-to-end coverage for the passkey lifecycle:
 *   1. Sign in with password.
 *   2. Enrol a passkey via the post-login prompt (Face ID / Touch ID style).
 *   3. Sign out.
 *   4. Sign back in with just the passkey — no password.
 *   5. Clean up: remove the enrolled passkey via the profile page.
 *
 * We use Chrome's WebAuthn Virtual Authenticator via a CDP session so the
 * biometric UI does not need real hardware. The authenticator persists as
 * long as we reuse the same browser context, which is why every step in
 * this file runs against a single context created up front.
 *
 * This spec deliberately does NOT use the shared storage state from
 * `e2e/global.setup.ts`: we need to start from a signed-out state and drive
 * the sign-in form ourselves so the enrol prompt fires and the passkey
 * sign-in branch is exercised.
 *
 * Reliability techniques applied here:
 *   - Every CDP step goes through `withRetry`; Chrome's WebAuthn domain
 *     occasionally rejects the very first call while the page is still
 *     bootstrapping ("Target closed", "Not attached to an active page").
 *   - Every navigation is followed by a targeted wait for a hydration marker
 *     (the email input) so we never race against React mounting the form.
 *   - Every assertion has an explicit, generous timeout so a slow Argon2
 *     unwrap or Supabase round-trip does not fail the whole run.
 *   - After enrolment we poll the virtual authenticator's credential store
 *     directly, which is the ground truth about whether the passkey was
 *     saved — much more reliable than watching for a toast.
 *   - After sign-out we wait for Supabase's persisted session to be gone
 *     before the next navigation, otherwise the app can bounce us straight
 *     back into the authenticated shell and skip the auth page entirely.
 */

test.describe.configure({ mode: "serial" });

/** Generous default so a slow CI runner + Argon2 unwrap don't false-fail. */
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Diagnostic log buffers captured for every test. On failure we flush them
 * to `testInfo.attach(...)` alongside a final screenshot + DOM snapshot so
 * the HTML report links every artifact needed to diagnose the run without
 * re-running:
 *   - console.log — every browser console entry + page/uncaught errors.
 *   - network.log — request/response lines with status + timing.
 *   - cdp.log     — every CDP command we sent and every event we received
 *                   from WebAuthn (which is the domain most likely to be
 *                   the culprit in this spec).
 * Playwright's own trace / video are already captured via playwright.config.
 */
type DiagnosticLogs = {
  console: string[];
  network: string[];
  cdp: string[];
};

type VirtualAuthenticator = {
  context: BrowserContext;
  page: Page;
  client: CDPSession;
  authenticatorId: string;
  logs: DiagnosticLogs;
  /** How many resident credentials the virtual authenticator currently holds. */
  credentialCount: () => Promise<number>;
  detach: () => Promise<void>;
};

/**
 * Retry a flaky async step with exponential-ish backoff. Chrome's DevTools
 * protocol occasionally throws transient errors during page bootstrap
 * ("Target closed", "Session closed", "Not attached to an active page",
 * "WebAuthn is not enabled"). These are cleared by a short wait + retry —
 * this helper is where every CDP interaction should go through.
 */
async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  opts: { retries?: number; baseDelayMs?: number } = {},
): Promise<T> {
  const retries = opts.retries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 250;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
      const msg = err instanceof Error ? err.message : String(err);
      // Only retry the shapes of failure we've actually seen in flakes; a
      // genuine assertion failure or logic bug should surface immediately.
      const transient =
        /Target closed|Session closed|Not attached|WebAuthn|Protocol error|Connection closed|Execution context was destroyed/i.test(
          msg,
        );
      if (!transient) break;
      // eslint-disable-next-line no-console
      console.warn(
        `[passkey-flow] retry ${label} (attempt ${attempt + 1}/${retries}): ${msg}`,
      );
      await new Promise((r) => setTimeout(r, baseDelayMs * (attempt + 1)));
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`withRetry(${label}) failed: ${String(lastErr)}`);
}

async function attachVirtualAuthenticator(
  page: Page,
): Promise<{ client: CDPSession; authenticatorId: string }> {
  return withRetry("attachVirtualAuthenticator", async () => {
    const client = await page.context().newCDPSession(page);
    await client.send("WebAuthn.enable");
    const { authenticatorId } = await client.send(
      "WebAuthn.addVirtualAuthenticator",
      {
        options: {
          protocol: "ctap2",
          transport: "internal",
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      },
    );
    return { client, authenticatorId };
  });
}

async function setup(browser: Browser): Promise<VirtualAuthenticator> {
  const context = await browser.newContext({ storageState: undefined });
  const page = await context.newPage();

  const logs: DiagnosticLogs = { console: [], network: [], cdp: [] };
  const ts = () => new Date().toISOString();

  // Browser console + uncaught errors.
  page.on("console", (msg) => {
    logs.console.push(`[${ts()}] ${msg.type().toUpperCase()} ${msg.text()}`);
  });
  page.on("pageerror", (err) => {
    logs.console.push(`[${ts()}] PAGEERROR ${err.stack ?? err.message}`);
  });
  page.on("requestfailed", (req) => {
    logs.network.push(
      `[${ts()}] REQUEST_FAILED ${req.method()} ${req.url()} — ${req.failure()?.errorText ?? "unknown"}`,
    );
  });
  page.on("response", (res) => {
    logs.network.push(
      `[${ts()}] ${res.status()} ${res.request().method()} ${res.url()}`,
    );
  });

  const { client, authenticatorId } = await attachVirtualAuthenticator(page);

  // Wrap CDP send so every command we issue is logged with args + result.
  // WebAuthn is the domain most likely to be the source of a flake here.
  const rawSend = client.send.bind(client) as CDPSession["send"];
  (client as unknown as { send: CDPSession["send"] }).send = (async (
    method: any,
    params?: any,
  ) => {
    const argSummary = params ? ` ${safeJson(params)}` : "";
    logs.cdp.push(`[${ts()}] SEND ${method}${argSummary}`);
    try {
      const result = await rawSend(method, params);
      logs.cdp.push(`[${ts()}] RESULT ${method} ${safeJson(result)}`);
      return result as any;
    } catch (err) {
      logs.cdp.push(
        `[${ts()}] ERROR ${method} ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }) as CDPSession["send"];

  // WebAuthn events fired by the browser (credentialAdded, assertion, etc).
  for (const evt of [
    "WebAuthn.credentialAdded",
    "WebAuthn.credentialAsserted",
    "WebAuthn.credentialUpdated",
    "WebAuthn.credentialDeleted",
  ] as const) {
    client.on(evt as any, (payload: unknown) => {
      logs.cdp.push(`[${ts()}] EVENT ${evt} ${safeJson(payload)}`);
    });
  }

  return {
    context,
    page,
    client,
    authenticatorId,
    logs,
    credentialCount: async () =>
      withRetry("WebAuthn.getCredentials", async () => {
        const { credentials } = await client.send("WebAuthn.getCredentials", {
          authenticatorId,
        });
        return credentials.length;
      }),
    detach: async () => {
      // Best-effort teardown — a closed context makes both calls throw and
      // that's fine, we're on the way out.
      try {
        await client.send("WebAuthn.removeVirtualAuthenticator", {
          authenticatorId,
        });
      } catch {
        /* context already closing */
      }
      try {
        await context.close();
      } catch {
        /* already closed */
      }
    },
  };
}

function safeJson(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s.length > 2000 ? `${s.slice(0, 2000)}…(truncated)` : s;
  } catch {
    return "[unserialisable]";
  }
}

/**
 * On failure, attach the collected console/network/CDP logs plus a final
 * screenshot and DOM snapshot to the test report. Safe to call from a
 * `finally` block — every attach is wrapped so a torn-down page can't hide
 * the underlying test failure.
 */
async function attachDiagnosticsIfFailed(
  testInfo: TestInfo,
  env: VirtualAuthenticator,
) {
  if (testInfo.status === testInfo.expectedStatus) return;
  const attach = async (
    name: string,
    body: string | Buffer,
    contentType: string,
  ) => {
    try {
      await testInfo.attach(name, { body, contentType });
    } catch {
      /* attaching must never mask the real failure */
    }
  };

  await attach("browser-console.log", env.logs.console.join("\n"), "text/plain");
  await attach("network.log", env.logs.network.join("\n"), "text/plain");
  await attach("cdp.log", env.logs.cdp.join("\n"), "text/plain");

  try {
    const png = await env.page.screenshot({ fullPage: true });
    await attach("final-screenshot.png", png, "image/png");
  } catch {
    /* page may already be gone */
  }
  try {
    const html = await env.page.content();
    await attach("final-dom.html", html, "text/html");
  } catch {
    /* page may already be gone */
  }
  try {
    const url = env.page.url();
    await attach("final-url.txt", url, "text/plain");
  } catch {
    /* ignore */
  }
}


/** Wait until the auth page is interactive (email field mounted). */
async function waitForAuthPageReady(page: Page) {
  await expect(page.getByLabel(/email/i)).toBeVisible({
    timeout: DEFAULT_TIMEOUT_MS,
  });
}

async function signInWithPassword(page: Page, email: string, password: string) {
  await page.goto("/auth");
  await waitForAuthPageReady(page);
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole("button", { name: /^sign in$/i }).click();
}

/**
 * Sign out by clearing Supabase's persisted session, then poll until it's
 * actually gone. The app's auth-state listener needs a tick to react, so a
 * navigation issued immediately after `signOut` can otherwise still see a
 * live session and redirect us back into the app.
 */
async function signOut(page: Page) {
  await page.evaluate(async () => {
    const g = window as unknown as {
      supabase?: { auth: { signOut: () => Promise<unknown> } };
    };
    if (g.supabase?.auth?.signOut) {
      await g.supabase.auth.signOut();
    }
    for (const storage of [window.localStorage, window.sessionStorage]) {
      for (let i = storage.length - 1; i >= 0; i--) {
        const key = storage.key(i);
        if (key && key.startsWith("sb-") && key.endsWith("-auth-token")) {
          storage.removeItem(key);
        }
      }
    }
  });
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          for (let i = 0; i < window.localStorage.length; i++) {
            const key = window.localStorage.key(i);
            if (key && key.startsWith("sb-") && key.endsWith("-auth-token")) {
              return true;
            }
          }
          return false;
        }),
      { timeout: 5_000, message: "Supabase session token should be cleared" },
    )
    .toBe(false);
}

test.describe("passkey enrolment and sign-in", () => {
  const email = process.env.E2E_EMAIL;
  const password = process.env.E2E_PASSWORD;

  test.skip(
    !email || !password,
    "E2E_EMAIL and E2E_PASSWORD must be set to run the passkey flow.",
  );

  test("enrol a passkey after password sign-in, then sign in biometrically", async ({
    browser,
  }, testInfo) => {
    const env = await setup(browser);
    try {
      // Starting state — the virtual authenticator holds nothing.
      await expect
        .poll(env.credentialCount, {
          timeout: 5_000,
          message: "virtual authenticator should start empty",
        })
        .toBe(0);

      // --- 1. Password sign-in surfaces the enrolment prompt on capable devices.
      await signInWithPassword(env.page, email!, password!);

      const enrolDialog = env.page.getByRole("dialog", {
        name: /sign in faster with a passkey/i,
      });
      await expect(enrolDialog).toBeVisible({ timeout: DEFAULT_TIMEOUT_MS });

      // --- 2. Set up the passkey — the virtual authenticator answers silently.
      await enrolDialog
        .getByRole("button", { name: /set up passkey/i })
        .click();

      // Ground truth: the credential exists in the authenticator's store.
      // Polling this is far more reliable than waiting for the toast alone,
      // because the toast can be dismissed by a follow-up navigation.
      await expect
        .poll(env.credentialCount, {
          timeout: DEFAULT_TIMEOUT_MS,
          message: "a credential should be saved to the virtual authenticator",
        })
        .toBe(1);

      // Success toast + we land on the home route.
      await expect(
        env.page.getByText(/passkey set up/i).first(),
      ).toBeVisible({ timeout: DEFAULT_TIMEOUT_MS });
      await expect(env.page).toHaveURL(/\/$/, { timeout: DEFAULT_TIMEOUT_MS });

      // --- 3. Sign out and reload the auth page.
      await signOut(env.page);
      await env.page.goto("/auth");
      await waitForAuthPageReady(env.page);

      // --- 4. Biometric sign-in with just the email.
      await env.page.getByLabel(/email/i).fill(email!);
      await env.page
        .getByRole("button", { name: /sign in with a passkey/i })
        .click();

      await expect(
        env.page.getByText(/signed in with passkey/i).first(),
      ).toBeVisible({ timeout: DEFAULT_TIMEOUT_MS });
      await expect(env.page).toHaveURL(/\/$/, { timeout: DEFAULT_TIMEOUT_MS });

      // Sanity: the credential is still present on the authenticator after
      // sign-in (WebAuthn assertions must not consume resident keys).
      expect(await env.credentialCount()).toBe(1);

      // --- 5. Clean up: remove the passkey through the profile UI so the
      // test can be re-run without leaving dead credentials behind.
      await env.page.goto("/profile");
      const removeButton = env.page
        .getByRole("button", { name: /^remove /i })
        .first();
      await expect(removeButton).toBeVisible({ timeout: DEFAULT_TIMEOUT_MS });
      await removeButton.click();
      await env.page
        .getByRole("button", { name: /^remove passkey$/i })
        .click();
      await expect(
        env.page.getByText(/no passkeys registered/i),
      ).toBeVisible({ timeout: DEFAULT_TIMEOUT_MS });
    } finally {
      await env.detach();
    }
  });

  test("biometric sign-in with no registered passkey routes into enrolment", async ({
    browser,
  }) => {
    const env = await setup(browser);
    try {
      // Precondition: the cleanup step in the previous test leaves the
      // account with zero credentials. The virtual authenticator is a fresh
      // one on this context, so the server's `no_credentials` branch fires.
      expect(await env.credentialCount()).toBe(0);

      await env.page.goto("/auth");
      await waitForAuthPageReady(env.page);
      await env.page.getByLabel(/email/i).fill(email!);
      await env.page
        .getByRole("button", { name: /sign in with a passkey/i })
        .click();

      // The client swaps to password mode with an informational toast and
      // focuses the password field — the exact contract that the enrolment
      // redirect relies on.
      await expect(
        env.page.getByText(/no passkey found/i).first(),
      ).toBeVisible({ timeout: DEFAULT_TIMEOUT_MS });
      await expect(env.page.getByLabel(/password/i)).toBeFocused({
        timeout: DEFAULT_TIMEOUT_MS,
      });

      // And the authenticator was never asked to write anything.
      expect(await env.credentialCount()).toBe(0);
    } finally {
      await env.detach();
    }
  });
});
