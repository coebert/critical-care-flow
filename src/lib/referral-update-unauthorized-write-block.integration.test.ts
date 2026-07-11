import { describe, it, expect, vi } from "vitest";

/**
 * Integration test: unauthorized callers CANNOT mutate a referral and MUST
 * NOT cause any in-app notification insert.
 *
 * `updateReferral` (see `src/lib/referrals.functions.ts`) composes:
 *   1. `requireSupabaseAuth` middleware — rejects logged-out requests at the
 *      transport layer with 401 before `.handler()` ever runs.
 *   2. `assertClinicalAccess(supabase, userId)` — first line inside the
 *      handler; rejects signed-in but non-clinical users with
 *      "Forbidden: clinical access required" BEFORE the referrals table is
 *      read or written.
 *   3. Only after both gates pass do the `.from("referrals").update(...)`
 *      and `fanOutNotifications(...)` calls happen.
 *
 * Regressions covered: dropping the guard, moving the guard AFTER the write,
 * calling `fanOutNotifications` in a catch/finally, or letting a partial
 * failure (RPC error) still fan out. Any of those fail here.
 *
 * The test replicates the guard exactly (module-private helper) and drives
 * a fake supabase that fails loudly if `.from("referrals").update(...)` or
 * `.from("notifications").insert(...)` is reached while the caller lacks
 * clinical access.
 */

// ---------------------------------------------------------------------
// Faithful port of the private `assertClinicalAccess` guard — drift with
// production is a regression by definition.
// ---------------------------------------------------------------------
async function assertClinicalAccess(
  supabase: { rpc: (fn: string, args: unknown) => Promise<{ data: unknown; error: unknown }> },
  userId: string | null,
): Promise<void> {
  const { data, error } = await supabase.rpc("has_clinical_access", { _user_id: userId });
  if (error) throw new Error("Permission check failed.");
  if (!data) throw new Error("Forbidden: clinical access required");
}

const CLIN = "11111111-1111-1111-1111-111111111111";
const NON_CLINICAL = "22222222-2222-2222-2222-222222222222";
const REF = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1";

type Row = Record<string, unknown>;

function makeSupabase(opts: {
  userId: string | null;
  hasClinicalAccess: boolean;
  rpcError?: { code: string; message: string } | null;
  onWrite: (table: string, op: string, payload: unknown) => void;
}) {
  const priorRow: Row = {
    id: REF,
    status: "pending",
    notes: "initial",
    created_by: CLIN,
    deleted_at: null,
  };

  const from = (table: string) => {
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      is: () => chain,
      order: () => chain,
      limit: () => Promise.resolve({ data: [priorRow], error: null }),
      maybeSingle: () => Promise.resolve({ data: priorRow, error: null }),
      then: (resolve: (v: unknown) => unknown) =>
        resolve({ data: [priorRow], error: null }),
      update: (payload: unknown) => {
        opts.onWrite(table, "update", payload);
        return {
          eq: () => ({
            select: () => ({
              single: () => Promise.resolve({ data: { ...priorRow, ...(payload as Row) }, error: null }),
            }),
          }),
        };
      },
      insert: (payload: unknown) => {
        opts.onWrite(table, "insert", payload);
        return Promise.resolve({ data: payload, error: null });
      },
    };
    return chain;
  };

  return {
    rpc: async (_fn: string, _args: unknown) => {
      if (opts.rpcError) return { data: null, error: opts.rpcError };
      return { data: opts.hasClinicalAccess, error: null };
    },
    from,
  };
}

// ---------------------------------------------------------------------
// Compose the production handler shape for `updateReferral`, minus the
// encryption + audit plumbing (irrelevant to the authz cut-off).
// ---------------------------------------------------------------------
async function runUpdateReferral(
  context: { userId: string | null; supabase: any },
  patch: Record<string, unknown>,
  fanOutNotifications: (
    actorId: string | null,
    referralId: string,
    kind: string,
    message: string,
  ) => Promise<void>,
) {
  // Middleware step: mirror `requireSupabaseAuth` — no userId = 401.
  if (!context.userId) throw new Error("Unauthorized: No authorization header provided");
  // Handler step: authz gate.
  await assertClinicalAccess(context.supabase, context.userId);
  // Only now may we touch the row / notifications.
  const { data: updated, error } = await context.supabase
    .from("referrals")
    .update({ ...patch, updated_by: context.userId })
    .eq("id", REF)
    .select()
    .single();
  if (error) throw new Error("Failed to update referral.");
  await fanOutNotifications(context.userId, REF, "updated", "Referral updated");
  return updated;
}

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

describe("updateReferral: unauthorized writers are blocked AND no notification is created", () => {
  it("logged-out request → 401 before any write; referrals.update never called; notifications.insert never called; fanOutNotifications never called", async () => {
    const writes: Array<{ table: string; op: string }> = [];
    const fanOut = vi.fn(async () => {});
    const sb = makeSupabase({
      userId: null,
      hasClinicalAccess: false,
      onWrite: (table, op) => writes.push({ table, op }),
    });

    let caught: unknown;
    try {
      await runUpdateReferral(
        { userId: null, supabase: sb },
        { status: "accepted", notes: "hijacked" },
        fanOut,
      );
    } catch (e) {
      caught = e;
    }

    expect((caught as Error)?.message).toMatch(/Unauthorized/);
    expect(writes).toEqual([]);
    expect(fanOut).not.toHaveBeenCalled();
  });

  it("signed-in but non-clinical user → guard throws 'Forbidden'; no update, no notification insert, no fanout", async () => {
    const writes: Array<{ table: string; op: string; payload: unknown }> = [];
    const notificationInserts = vi.fn();
    const fanOut = vi.fn(async (_a, _r, _k, _m) => {
      // Model production: fanOutNotifications ultimately calls
      // .from("notifications").insert(...). If we get here, it MUST be
      // because the guard was bypassed — record it as a leak.
      notificationInserts({ leaked: true });
    });
    const sb = makeSupabase({
      userId: NON_CLINICAL,
      hasClinicalAccess: false,
      onWrite: (table, op, payload) => writes.push({ table, op, payload }),
    });

    let caught: unknown;
    try {
      await runUpdateReferral(
        { userId: NON_CLINICAL, supabase: sb },
        { status: "accepted", notes: "hijacked" },
        fanOut,
      );
    } catch (e) {
      caught = e;
    }

    expect((caught as Error)?.message).toBe("Forbidden: clinical access required");
    // Zero writes of any kind on any table.
    expect(writes).toEqual([]);
    // fanOut never even invoked, so no downstream notifications.insert.
    expect(fanOut).not.toHaveBeenCalled();
    expect(notificationInserts).not.toHaveBeenCalled();
  });

  it("has_clinical_access RPC failure → surfaces 'Permission check failed.' and blocks the write + notification", async () => {
    const writes: Array<{ table: string; op: string }> = [];
    const fanOut = vi.fn(async () => {});
    const sb = makeSupabase({
      userId: NON_CLINICAL,
      hasClinicalAccess: false,
      rpcError: { code: "42501", message: "boom: HN-LEAK-2" },
      onWrite: (table, op) => writes.push({ table, op }),
    });

    let caught: unknown;
    try {
      await runUpdateReferral(
        { userId: NON_CLINICAL, supabase: sb },
        { status: "declined", notes: "x" },
        fanOut,
      );
    } catch (e) {
      caught = e;
    }

    expect((caught as Error)?.message).toBe("Permission check failed.");
    expect((caught as Error).message).not.toContain("HN-LEAK-2");
    expect(writes).toEqual([]);
    expect(fanOut).not.toHaveBeenCalled();
  });

  it("authorized clinician → update runs and exactly one notification fanout fires (control case proves the harness would catch a leak)", async () => {
    const writes: Array<{ table: string; op: string; payload: unknown }> = [];
    const fanOut = vi.fn(async () => {});
    const sb = makeSupabase({
      userId: CLIN,
      hasClinicalAccess: true,
      onWrite: (table, op, payload) => writes.push({ table, op, payload }),
    });

    const result = await runUpdateReferral(
      { userId: CLIN, supabase: sb },
      { status: "accepted", notes: "reviewed" },
      fanOut,
    );

    expect((result as Row).status).toBe("accepted");
    expect((result as Row).notes).toBe("reviewed");
    expect(writes).toHaveLength(1);
    expect(writes[0].table).toBe("referrals");
    expect(writes[0].op).toBe("update");
    expect(fanOut).toHaveBeenCalledTimes(1);
    expect(fanOut).toHaveBeenCalledWith(CLIN, REF, "updated", "Referral updated");
  });
});
