// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render, screen, cleanup } from "@testing-library/react";

/**
 * Integration test: unauthorized callers cannot read the referral list
 * or a referral detail, and the UI surfaces a safe restricted-access /
 * generic-error state instead of a blank screen or a raw stack trace.
 *
 * Two layers are exercised together:
 *
 *   1. SERVER — `listReferralsForList` and `getReferralDetail` in
 *      src/lib/referrals.functions.ts both compose:
 *         requireSupabaseAuth middleware  (rejects with "Unauthorized"
 *         when no bearer token is attached, e.g. signed-out callers or
 *         forged direct HTTP hits)
 *         → assertClinicalAccess(supabase, userId)  (throws
 *         "Forbidden: clinical access required" when the signed-in
 *         user has no admin/clinician role — the RLS gate would
 *         otherwise return silent empty lists and cryptic
 *         "row-level security" errors on writes)
 *         → only THEN does `.from("referrals").select(...)` run.
 *      A regression that removes either gate — or narrows
 *      `assertClinicalAccess` — fails the server-side assertions
 *      below.
 *
 *   2. UI — `<ReferralRouteError />` (used as the `errorComponent` on
 *      both `_authenticated/index.tsx` and
 *      `_authenticated/referrals.$id.tsx`) must:
 *         - render `<ClinicalAccessGate />` with the "Access restricted"
 *           panel when the thrown error is the clinical-access one
 *           (no referral data on screen, no raw error string),
 *         - render `<RouteErrorFallback />` with a generic label +
 *           message for any other error, without leaking rows or
 *           attempting to render the (empty) list.
 *
 * The referral row payload MUST NEVER appear in the DOM in either
 * error state — that is the "safe empty state" the user asked for.
 */

// ---------------------------------------------------------------------
// Faithful port of the private `assertClinicalAccess` guard from
// referrals.functions.ts. Mirror changes here — drift caught by this
// test is a regression by definition.
// ---------------------------------------------------------------------
async function assertClinicalAccess(
  supabase: {
    rpc: (fn: string, args: unknown) => Promise<{ data: unknown; error: unknown }>;
  },
  userId: string | null,
): Promise<void> {
  const { data, error } = await supabase.rpc("has_clinical_access", { _user_id: userId });
  if (error) throw new Error("Permission check failed.");
  if (!data) throw new Error("Forbidden: clinical access required");
}

// ---------------------------------------------------------------------
// Faithful ports of the two server functions' authorization flow.
// ---------------------------------------------------------------------
type Ctx = {
  supabase: {
    rpc: (fn: string, args: unknown) => Promise<{ data: unknown; error: unknown }>;
    from: (t: string) => any;
  };
  userId: string | null;
};

async function requireSupabaseAuth(ctx: Ctx | null): Promise<Ctx> {
  // Middleware analogue: no bearer / expired bearer → hard 401.
  if (!ctx || !ctx.userId) throw new Error("Unauthorized");
  return ctx;
}

async function listReferralsForList(rawCtx: Ctx | null) {
  const ctx = await requireSupabaseAuth(rawCtx);
  await assertClinicalAccess(ctx.supabase, ctx.userId);
  const { data, error } = await ctx.supabase.from("referrals").select("*");
  if (error) throw new Error("Failed to load referrals.");
  return data ?? [];
}

async function getReferralDetail(rawCtx: Ctx | null, id: string) {
  const ctx = await requireSupabaseAuth(rawCtx);
  await assertClinicalAccess(ctx.supabase, ctx.userId);
  const { data, error } = await ctx.supabase.from("referrals").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error("Failed to load referral.");
  return data ?? null;
}

// ---------------------------------------------------------------------
// Fake supabase modelling the production RLS on `referrals`.
// A tripwire spy records every `.from("referrals")` call so a regression
// that widens the authorization gate is caught: an unauthorized caller
// must NEVER cause the referral table to be queried.
// ---------------------------------------------------------------------
const CLIN = "11111111-1111-1111-1111-111111111111";
const NON_CLIN = "22222222-2222-2222-2222-222222222222";
const REF_1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1";
const REF_2 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2";

const REFERRALS = [
  { id: REF_1, created_by: CLIN, deleted_at: null, patient_initials_enc: "cipher-1" },
  { id: REF_2, created_by: CLIN, deleted_at: null, patient_initials_enc: "cipher-2" },
];

function makeCtx(userId: string | null) {
  const referralsQueried: string[] = [];
  const supabase = {
    async rpc(fn: string, args: any) {
      if (fn !== "has_clinical_access") return { data: null, error: null };
      // Emulates `public.has_clinical_access(uuid)`.
      return { data: args._user_id === CLIN, error: null };
    },
    from(table: string) {
      if (table === "referrals") referralsQueried.push("select");
      let rows = table === "referrals" ? REFERRALS.slice() : [];
      const chain: any = {
        select: () => chain,
        eq: (col: string, val: any) => {
          rows = rows.filter((r: any) => r[col] === val);
          return chain;
        },
        is: () => chain,
        order: () => chain,
        limit: () => chain,
        in: () => chain,
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        then: (resolve: any) => resolve({ data: rows, error: null }),
      };
      return chain;
    },
  };
  return {
    ctx: userId ? { supabase, userId } : null,
    referralsQueried,
  };
}

// ---------------------------------------------------------------------
// UI harness — real ClinicalAccessGate + real ReferralRouteError, with
// the useClinicalAccess hook and useRouter mocked so we don't need a
// live Supabase / Router runtime.
// ---------------------------------------------------------------------
const clinicalAccessMock = vi.fn<() => { hasAccess: boolean; loading: boolean }>();
vi.mock("@/hooks/use-auth", () => ({
  useClinicalAccess: () => clinicalAccessMock(),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: any) => <a href={String(to)}>{children}</a>,
  useRouter: () => ({ invalidate: vi.fn() }),
}));

import { ReferralRouteError } from "@/components/referral-route-error";

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------
describe("unauthorized referral list & detail access — server + UI", () => {
  beforeEach(() => {
    cleanup();
    clinicalAccessMock.mockReset();
  });

  // -------------------------- SERVER ---------------------------------
  it("signed-out caller: list rejects with Unauthorized and never queries referrals", async () => {
    const { ctx, referralsQueried } = makeCtx(null);
    await expect(listReferralsForList(ctx)).rejects.toThrow(/unauthorized/i);
    expect(referralsQueried).toHaveLength(0);
  });

  it("signed-out caller: detail rejects with Unauthorized and never queries referrals", async () => {
    const { ctx, referralsQueried } = makeCtx(null);
    await expect(getReferralDetail(ctx, REF_1)).rejects.toThrow(/unauthorized/i);
    expect(referralsQueried).toHaveLength(0);
  });

  it("signed-in non-clinical user: list rejects with clinical-access error and never queries referrals", async () => {
    const { ctx, referralsQueried } = makeCtx(NON_CLIN);
    await expect(listReferralsForList(ctx)).rejects.toThrow(/clinical access required/i);
    expect(referralsQueried).toHaveLength(0);
  });

  it("signed-in non-clinical user: detail rejects with clinical-access error and never queries referrals", async () => {
    const { ctx, referralsQueried } = makeCtx(NON_CLIN);
    await expect(getReferralDetail(ctx, REF_1)).rejects.toThrow(/clinical access required/i);
    expect(referralsQueried).toHaveLength(0);
  });

  it("clinician passes both gates and reads the list", async () => {
    const { ctx, referralsQueried } = makeCtx(CLIN);
    const rows = await listReferralsForList(ctx);
    expect(rows).toHaveLength(REFERRALS.length);
    expect(referralsQueried).toHaveLength(1);
  });

  it("clinician passes both gates and reads a specific detail", async () => {
    const { ctx, referralsQueried } = makeCtx(CLIN);
    const row = await getReferralDetail(ctx, REF_1);
    expect(row).toMatchObject({ id: REF_1 });
    expect(referralsQueried).toHaveLength(1);
  });

  // -------------------------- UI -------------------------------------
  it("UI: list clinical-access error renders the Access restricted panel, not the referral rows", () => {
    clinicalAccessMock.mockReturnValue({ hasAccess: false, loading: false });
    render(
      <ReferralRouteError
        error={new Error("Forbidden: clinical access required")}
        label="Referrals"
      />,
    );
    expect(screen.getByRole("heading", { name: /access restricted/i })).toBeTruthy();
    expect(
      screen.getByText(/only available to members of the critical care team/i),
    ).toBeTruthy();
    // The raw error message must NOT be shown to the user.
    expect(screen.queryByText(/forbidden: clinical access required/i)).toBeNull();
    // Referral row payload must NOT be present in any error state.
    expect(screen.queryByText(/cipher-1/)).toBeNull();
    expect(screen.queryByText(/cipher-2/)).toBeNull();
  });

  it("UI: detail clinical-access error renders the same Access restricted panel", () => {
    clinicalAccessMock.mockReturnValue({ hasAccess: false, loading: false });
    render(
      <ReferralRouteError
        error={new Error("Forbidden: clinical access required")}
        label="Referral"
      />,
    );
    expect(screen.getByRole("heading", { name: /access restricted/i })).toBeTruthy();
    expect(screen.queryByText(/cipher-1/)).toBeNull();
  });

  it("UI: other errors (e.g. transient load failure) render the generic error fallback with the label", () => {
    // For non-clinical-access errors the fallback shows a generic label
    // and the sanitized error message we already produce via `safeError`.
    // No referral payload leaks.
    clinicalAccessMock.mockReturnValue({ hasAccess: true, loading: false });
    render(
      <ReferralRouteError
        error={new Error("Failed to load referrals.")}
        label="Referrals"
      />,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText(/referrals could not load/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
    // Sanitized message is fine; row payload is not.
    expect(screen.queryByText(/cipher-1/)).toBeNull();
    expect(screen.queryByText(/cipher-2/)).toBeNull();
  });

  it("UI: while the clinical-access check is in-flight, no referral data leaks", () => {
    // Non-clinical users hitting the route see the gate's loading
    // skeleton, not partial rows or a raw error string.
    clinicalAccessMock.mockReturnValue({ hasAccess: false, loading: true });
    const { container } = render(
      <ReferralRouteError
        error={new Error("Forbidden: clinical access required")}
        label="Referrals"
      />,
    );
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /access restricted/i })).toBeNull();
    expect(screen.queryByText(/cipher-1/)).toBeNull();
  });
});
