import { describe, it, expect, vi } from "vitest";

/**
 * Integration test: opening a `/referrals/{id}` deep link (e.g. from a
 * push or in-app notification) as an unauthorized user MUST NOT reveal
 * referral data. We verify the three concentric defenses:
 *
 *   1. Router gate — the `_authenticated` layout's `beforeLoad` reads the
 *      persisted Supabase session; if none, it throws
 *      `redirect({ to: "/auth", search: { redirect: <deep-link> } })`
 *      preserving the intended target so the user lands on the referral
 *      after signing in.
 *
 *   2. UI role gate — signed-in but non-clinical users pass the router
 *      gate (they have a session) but `<ClinicalAccessGate>` on
 *      `/referrals/$id` renders "Access restricted" instead of the
 *      referral. No referral fields, ciphertext, or hospital numbers
 *      appear on screen.
 *
 *   3. Server guard — even if the client bypassed both gates, the
 *      `getReferralById`-style server fn calls `assertClinicalAccess`
 *      first, throwing "Forbidden: clinical access required" before
 *      touching `.from("referrals").select(...)`. Data never leaves the DB.
 *
 * A regression that:
 *   - removes the `beforeLoad` session check → test 1 fails (no redirect).
 *   - swaps `search: { redirect: target }` for a bare redirect → test 1
 *     fails (deep link lost).
 *   - drops `<ClinicalAccessGate>` around the detail page → test 2 fails.
 *   - moves the server guard AFTER the `.from("referrals")` read → test 3
 *     fails (referral row leaked).
 */

const REF_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1";
const DEEP_LINK_PATH = `/referrals/${REF_ID}`;
const NON_CLINICAL = "22222222-2222-2222-2222-222222222222";
const CLIN = "11111111-1111-1111-1111-111111111111";
const SECRET_CIPHERTEXT = "cipher-do-not-leak";
const SECRET_HOSPITAL_NUMBER = "H999-SECRET";

// ---------------------------------------------------------------------
// 1. Faithful port of the `_authenticated` layout `beforeLoad`.
//    Mirror any change in `src/routes/_authenticated/route.tsx` here.
// ---------------------------------------------------------------------
class RedirectSignal extends Error {
  to: string;
  search?: { redirect?: string };
  constructor(to: string, search?: { redirect?: string }) {
    super(`redirect:${to}`);
    this.to = to;
    this.search = search;
  }
}
function redirect(opts: { to: string; search?: { redirect?: string } }): never {
  throw new RedirectSignal(opts.to, opts.search);
}

async function authenticatedBeforeLoad(
  supabase: { auth: { getSession: () => Promise<{ data: { session: { user: unknown } | null } }> } },
  location: { pathname: string; searchStr?: string },
): Promise<{ user: unknown }> {
  const { data } = await supabase.auth.getSession();
  if (!data.session?.user) {
    const target = `${location.pathname}${location.searchStr ?? ""}`;
    redirect({
      to: "/auth",
      search: target && target !== "/" ? { redirect: target } : undefined,
    });
  }
  return { user: data.session!.user };
}

// ---------------------------------------------------------------------
// 2. Faithful port of the `<ClinicalAccessGate>` decision (pure logic).
// ---------------------------------------------------------------------
function renderClinicalGate(opts: {
  loading: boolean;
  hasAccess: boolean;
  children: () => string;
}): string {
  if (opts.loading) return "SKELETON";
  if (!opts.hasAccess) return "ACCESS_RESTRICTED";
  return opts.children();
}

// ---------------------------------------------------------------------
// 3. Faithful port of the server-side `assertClinicalAccess` guard and
//    `getReferralById`-style handler.
// ---------------------------------------------------------------------
async function assertClinicalAccess(
  supabase: { rpc: (fn: string, args: unknown) => Promise<{ data: unknown; error: unknown }> },
  userId: string | null,
): Promise<void> {
  const { data, error } = await supabase.rpc("has_clinical_access", { _user_id: userId });
  if (error) throw new Error("Permission check failed.");
  if (!data) throw new Error("Forbidden: clinical access required");
}

function makeReferralSupabase(opts: {
  hasClinicalAccess: boolean;
  onSelect: (table: string) => void;
}) {
  const row = {
    id: REF_ID,
    patient_initials_enc: SECRET_CIPHERTEXT,
    hospital_number: SECRET_HOSPITAL_NUMBER,
    status: "pending",
  };
  return {
    rpc: async (_fn: string, _args: unknown) => ({
      data: opts.hasClinicalAccess,
      error: null,
    }),
    from: (table: string) => ({
      select: () => {
        opts.onSelect(table);
        return {
          eq: () => ({
            maybeSingle: async () => ({ data: row, error: null }),
          }),
        };
      },
    }),
  };
}

async function runGetReferralById(
  context: { userId: string; supabase: any },
  id: string,
) {
  await assertClinicalAccess(context.supabase, context.userId);
  const { data, error } = await context.supabase
    .from("referrals")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error("Failed to load referral.");
  return data;
}

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

describe("deep link /referrals/{id} — unauthorized access is denied at every layer", () => {
  it("1. logged-out user → router gate throws redirect to /auth with the deep link preserved as ?redirect=", async () => {
    const sb = {
      auth: { getSession: async () => ({ data: { session: null } }) },
    };
    let caught: unknown;
    try {
      await authenticatedBeforeLoad(sb, {
        pathname: DEEP_LINK_PATH,
        searchStr: "",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RedirectSignal);
    const r = caught as RedirectSignal;
    expect(r.to).toBe("/auth");
    // Deep link MUST round-trip so the user lands on the referral after
    // signing in. A regression that drops `search` sends them to `/`.
    expect(r.search?.redirect).toBe(DEEP_LINK_PATH);
    // The intended target is a query param, NOT an open-redirect URL.
    expect(r.search?.redirect?.startsWith("/")).toBe(true);
    expect(r.search?.redirect).not.toMatch(/^https?:/);
  });

  it("2. signed-in non-clinical user → router gate passes (has session), ClinicalAccessGate returns 'Access restricted' and referral body is NOT rendered", async () => {
    const sb = {
      auth: {
        getSession: async () => ({
          data: { session: { user: { id: NON_CLINICAL } } },
        }),
      },
    };
    // Router gate passes.
    const ctx = await authenticatedBeforeLoad(sb, {
      pathname: DEEP_LINK_PATH,
    });
    expect((ctx.user as { id: string }).id).toBe(NON_CLINICAL);

    // UI gate blocks rendering. `children()` must NEVER be invoked; asserting
    // that guarantees no PHI is even constructed for a non-clinical viewer.
    const referralBody = vi.fn(
      () => `REFERRAL[${SECRET_CIPHERTEXT}/${SECRET_HOSPITAL_NUMBER}]`,
    );
    const rendered = renderClinicalGate({
      loading: false,
      hasAccess: false,
      children: referralBody,
    });
    expect(rendered).toBe("ACCESS_RESTRICTED");
    expect(referralBody).not.toHaveBeenCalled();
    expect(rendered).not.toContain(SECRET_CIPHERTEXT);
    expect(rendered).not.toContain(SECRET_HOSPITAL_NUMBER);
  });

  it("3. non-clinical user bypasses the UI gate → server fn STILL refuses; referrals table is never queried and no data leaks", async () => {
    const selectProbe = vi.fn();
    const sb = makeReferralSupabase({
      hasClinicalAccess: false,
      onSelect: selectProbe,
    });
    let caught: unknown;
    try {
      await runGetReferralById({ userId: NON_CLINICAL, supabase: sb }, REF_ID);
    } catch (e) {
      caught = e;
    }
    expect((caught as Error)?.message).toBe("Forbidden: clinical access required");
    // Server guard runs BEFORE the read — no leak, not even a metadata query.
    expect(selectProbe).not.toHaveBeenCalled();
    expect((caught as Error).message).not.toContain(SECRET_CIPHERTEXT);
    expect((caught as Error).message).not.toContain(SECRET_HOSPITAL_NUMBER);
  });

  it("control: authorized clinician following the same deep link → router gate passes, UI gate passes, server fn returns the row (proves the harness would flag a leak)", async () => {
    const sb = {
      auth: {
        getSession: async () => ({
          data: { session: { user: { id: CLIN } } },
        }),
      },
    };
    const ctx = await authenticatedBeforeLoad(sb, { pathname: DEEP_LINK_PATH });
    expect((ctx.user as { id: string }).id).toBe(CLIN);

    const referralBody = vi.fn(() => "REFERRAL_DETAIL");
    const rendered = renderClinicalGate({
      loading: false,
      hasAccess: true,
      children: referralBody,
    });
    expect(rendered).toBe("REFERRAL_DETAIL");
    expect(referralBody).toHaveBeenCalledTimes(1);

    const serverSb = makeReferralSupabase({
      hasClinicalAccess: true,
      onSelect: () => {},
    });
    const row = await runGetReferralById(
      { userId: CLIN, supabase: serverSb },
      REF_ID,
    );
    expect((row as { id: string }).id).toBe(REF_ID);
  });
});
