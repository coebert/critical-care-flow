import { test, expect, type BrowserContext, type Page } from "@playwright/test";

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
 */

test.describe.configure({ mode: "serial" });

type VirtualAuthenticator = {
  context: BrowserContext;
  page: Page;
  authenticatorId: string;
  detach: () => Promise<void>;
};

async function attachVirtualAuthenticator(page: Page): Promise<string> {
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
  return authenticatorId;
}

async function setup(browser: import("@playwright/test").Browser): Promise<VirtualAuthenticator> {
  const context = await browser.newContext({ storageState: undefined });
  const page = await context.newPage();
  const authenticatorId = await attachVirtualAuthenticator(page);
  return {
    context,
    page,
    authenticatorId,
    detach: async () => {
      await context.close();
    },
  };
}

async function signInWithPassword(page: Page, email: string, password: string) {
  await page.goto("/auth");
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole("button", { name: /^sign in$/i }).click();
}

async function signOut(page: Page) {
  // Supabase client lives in the page; clear the session directly to keep
  // the test independent of whatever UI the app exposes for sign-out.
  await page.evaluate(async () => {
    const g = window as unknown as {
      // Defensive: not all builds expose this; we fall back to clearing storage.
      supabase?: { auth: { signOut: () => Promise<unknown> } };
    };
    if (g.supabase?.auth?.signOut) {
      await g.supabase.auth.signOut();
    }
    for (let i = window.localStorage.length - 1; i >= 0; i--) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith("sb-") && key.endsWith("-auth-token")) {
        window.localStorage.removeItem(key);
      }
    }
    for (let i = window.sessionStorage.length - 1; i >= 0; i--) {
      const key = window.sessionStorage.key(i);
      if (key && key.startsWith("sb-") && key.endsWith("-auth-token")) {
        window.sessionStorage.removeItem(key);
      }
    }
  });
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
  }) => {
    const env = await setup(browser);
    try {
      // --- 1. Password sign-in surfaces the enrolment prompt on capable devices.
      await signInWithPassword(env.page, email!, password!);

      const enrolDialog = env.page.getByRole("dialog", {
        name: /sign in faster with a passkey/i,
      });
      await expect(enrolDialog).toBeVisible({ timeout: 15_000 });

      // --- 2. Set up the passkey — the virtual authenticator answers silently.
      await enrolDialog
        .getByRole("button", { name: /set up passkey/i })
        .click();

      // Success toast + we land on the home route.
      await expect(
        env.page.getByText(/passkey set up/i).first(),
      ).toBeVisible({ timeout: 15_000 });
      await expect(env.page).toHaveURL(/\/$/, { timeout: 15_000 });

      // --- 3. Sign out and reload the auth page.
      await signOut(env.page);
      await env.page.goto("/auth");
      await expect(env.page.getByLabel(/email/i)).toBeVisible();

      // --- 4. Biometric sign-in with just the email.
      await env.page.getByLabel(/email/i).fill(email!);
      await env.page
        .getByRole("button", { name: /sign in with a passkey/i })
        .click();

      await expect(
        env.page.getByText(/signed in with passkey/i).first(),
      ).toBeVisible({ timeout: 15_000 });
      await expect(env.page).toHaveURL(/\/$/, { timeout: 15_000 });

      // --- 5. Clean up: remove the passkey through the profile UI so the
      // test can be re-run without leaving dead credentials behind.
      await env.page.goto("/profile");
      const removeButton = env.page
        .getByRole("button", { name: /^remove /i })
        .first();
      await expect(removeButton).toBeVisible({ timeout: 15_000 });
      await removeButton.click();
      await env.page
        .getByRole("button", { name: /^remove passkey$/i })
        .click();
      await expect(
        env.page.getByText(/no passkeys registered/i),
      ).toBeVisible({ timeout: 15_000 });
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
      await env.page.goto("/auth");
      await env.page.getByLabel(/email/i).fill(email!);
      await env.page
        .getByRole("button", { name: /sign in with a passkey/i })
        .click();

      // The client swaps to password mode with an informational toast and
      // focuses the password field — the exact contract that the enrolment
      // redirect relies on.
      await expect(
        env.page.getByText(/no passkey found/i).first(),
      ).toBeVisible({ timeout: 15_000 });
      await expect(env.page.getByLabel(/password/i)).toBeFocused();
    } finally {
      await env.detach();
    }
  });
});
