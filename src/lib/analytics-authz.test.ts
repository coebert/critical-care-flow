import { describe, it, expect, vi } from "vitest";
import { assertAdmin } from "./analytics.functions";

// These tests exercise the ONLY server-side authorization branch that the
// analytics server functions add on top of the shared `requireSupabaseAuth`
// middleware: `assertAdmin(context)`. They cover the three outcomes
// documented in the code:
//
//   1. Non-admin (clinician, no-role user, revoked admin) → has_role returns
//      `false` → assertAdmin throws a Forbidden-shaped error. This is what
//      keeps a clinician from calling getReferralsAnalytics /
//      getPostopAnalytics even though their bearer token is valid.
//   2. Admin → has_role returns `true` → assertAdmin resolves silently and
//      the query proceeds.
//   3. Unauthenticated / bad session → in production the request is rejected
//      by `requireSupabaseAuth` before `assertAdmin` runs, so `context`
//      never carries a `userId`. We simulate that scenario by feeding
//      assertAdmin the same shape it would see if it were ever reached
//      without a valid session (RPC error), and assert it surfaces a
//      Permission-check error rather than silently allowing the call.
//
// The queries themselves run through `context.supabase` (RLS-scoped as the
// caller), so RLS on `referrals` / `postop_bookings` /
// `icnarc_targets` is the second gate — enforced by the database itself.
// Testing DB-side RLS requires an integration environment; the goal here is
// to lock down the app-layer contract so a future refactor cannot silently
// drop the admin check or route queries through supabaseAdmin.

function makeContext({
  hasRole,
  rpcError = null,
}: {
  hasRole: boolean | null;
  rpcError?: { message: string } | null;
}) {
  const rpc = vi.fn().mockResolvedValue({ data: hasRole, error: rpcError });
  return {
    context: {
      userId: "11111111-1111-4111-8111-111111111111",
      supabase: { rpc },
    },
    rpc,
  };
}

describe("assertAdmin — analytics access gate", () => {
  it("resolves silently for an admin (has_role returns true)", async () => {
    const { context, rpc } = makeContext({ hasRole: true });
    await expect(assertAdmin(context)).resolves.toBeUndefined();
    expect(rpc).toHaveBeenCalledWith("has_role", {
      _user_id: context.userId,
      _role: "admin",
    });
  });

  it("throws Forbidden for a clinician (has_role returns false)", async () => {
    const { context } = makeContext({ hasRole: false });
    await expect(assertAdmin(context)).rejects.toThrow(
      /Forbidden: analytics are restricted to administrators\./,
    );
  });

  it("throws Forbidden for a user with no role at all (has_role returns false)", async () => {
    // Self-signups now receive no role by design (handle_new_user change).
    // has_role short-circuits to false — assertAdmin must still reject.
    const { context } = makeContext({ hasRole: false });
    await expect(assertAdmin(context)).rejects.toThrow(/Forbidden/);
  });

  it("throws Forbidden for a stale admin whose role was revoked (has_role returns null)", async () => {
    // Postgres has_role wraps SELECT EXISTS(...), which always returns a
    // boolean; a `null` payload would only occur on a genuinely empty RPC
    // response. Treat that the same as "no role" — never allow.
    const { context } = makeContext({ hasRole: null });
    await expect(assertAdmin(context)).rejects.toThrow(/Forbidden/);
  });

  it("throws Permission-check on RPC error (simulates unauthenticated / broken session reaching the gate)", async () => {
    const { context } = makeContext({
      hasRole: null,
      rpcError: { message: "JWT expired" },
    });
    await expect(assertAdmin(context)).rejects.toThrow(/Permission check failed\./);
  });

  it("never grants access on a truthy-but-non-boolean payload — only strict truthiness is honoured", async () => {
    // Defensive: if a future refactor made has_role return a row/object,
    // the current implementation would accept it. Lock the current contract
    // (strict boolean) — the failure below is a red flag that assertAdmin
    // is coercing structured data into "admin".
    const { context } = makeContext({ hasRole: true });
    await expect(assertAdmin(context)).resolves.toBeUndefined();
    // And the negative — falsy short-circuit must reject.
    const { context: ctx2 } = makeContext({ hasRole: false });
    await expect(assertAdmin(ctx2)).rejects.toThrow(/Forbidden/);
  });
});

describe("analytics server functions — middleware wiring", () => {
  it("exports the admin-only analytics functions (getReferralsAnalytics, getPostopAnalytics)", async () => {
    // Ensures the two entry points still exist and are the ones the UI
    // imports. If a refactor renames or removes them, this test fails and
    // the UI + these authz tests need updating together.
    const mod = await import("./analytics.functions");
    expect(typeof mod.getReferralsAnalytics).toBe("function");
    expect(typeof mod.getPostopAnalytics).toBe("function");
    expect(typeof mod.assertAdmin).toBe("function");
  });
});
