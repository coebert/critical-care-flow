import { test, expect } from "@playwright/test";

/**
 * /setup is a takeover-race-sensitive page: it can mint the first admin
 * account, so it must be fully disabled unless (a) a server-side
 * `SETUP_SECRET` (>=16 chars) is configured AND (b) no users exist yet.
 * The admin form must never render without a configured secret, and the
 * `setup_secret` input must be present whenever the form does render.
 *
 * We drive an unauthenticated context so we exercise the public route as
 * a random visitor would. The server-side state — whether SETUP_SECRET
 * is configured, and whether any users exist — is controlled by the
 * `E2E_SETUP_SECRET_CONFIGURED` env flag the operator sets to match
 * their deployment.
 */
test.describe("/setup one-time-secret gate", () => {
  // /setup is public — do not attach signed-in storage state.
  test.use({ storageState: { cookies: [], origins: [] } });

  const secretConfigured = process.env.E2E_SETUP_SECRET_CONFIGURED === "1";

  test("disabled message renders and no admin form is exposed when SETUP_SECRET is unset", async ({
    page,
  }) => {
    test.skip(
      secretConfigured,
      "SETUP_SECRET is configured on this deployment; the disabled branch cannot be observed.",
    );

    await page.goto("/setup");

    // The gated fallback card is shown; the admin form is not.
    await expect(
      page.getByRole("heading", { name: /setup is disabled/i }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByText(
        /first-admin setup is not currently enabled on this deployment/i,
      ),
    ).toBeVisible();

    // Zero form controls specific to the admin bootstrap flow.
    await expect(page.getByLabel(/setup secret/i)).toHaveCount(0);
    await expect(page.getByLabel(/full name/i)).toHaveCount(0);
    await expect(page.getByLabel(/^email$/i)).toHaveCount(0);
    await expect(page.getByLabel(/password \(min 8 chars\)/i)).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /create admin account/i }),
    ).toHaveCount(0);

    // The "Setup already complete" branch (which appears when the secret IS
    // configured but users exist) must NOT be shown here.
    await expect(
      page.getByRole("heading", { name: /setup already complete/i }),
    ).toHaveCount(0);
  });

  test("disabled fallback is not shown when SETUP_SECRET is configured; admin form only appears with no existing users", async ({
    page,
  }) => {
    test.skip(
      !secretConfigured,
      "Set E2E_SETUP_SECRET_CONFIGURED=1 when SETUP_SECRET is set on the target deployment.",
    );

    await page.goto("/setup");

    // Whichever branch renders, it must not be the "disabled" one.
    await expect(
      page.getByRole("heading", { name: /setup is disabled/i }),
    ).toHaveCount(0);

    // On a deployment that already has users (the normal case), the
    // "already complete" branch renders and the admin form stays hidden.
    // On a fresh deployment with no users, the admin form renders and
    // MUST include the setup_secret field — the shared password gate.
    const formButton = page.getByRole("button", {
      name: /create admin account/i,
    });
    const alreadyComplete = page.getByRole("heading", {
      name: /setup already complete/i,
    });

    await expect(alreadyComplete.or(formButton)).toBeVisible({
      timeout: 15_000,
    });

    if (await formButton.isVisible().catch(() => false)) {
      // If the form is rendered, the setup_secret input MUST exist —
      // otherwise the client could submit without the one-time secret.
      await expect(page.getByLabel(/setup secret/i)).toBeVisible();
      await expect(page.getByLabel(/full name/i)).toBeVisible();
      await expect(page.getByLabel(/^email$/i)).toBeVisible();
      await expect(page.getByLabel(/password \(min 8 chars\)/i)).toBeVisible();
    } else {
      // Users already exist — the admin form must stay hidden.
      await expect(formButton).toHaveCount(0);
      await expect(page.getByLabel(/setup secret/i)).toHaveCount(0);
    }
  });
});
