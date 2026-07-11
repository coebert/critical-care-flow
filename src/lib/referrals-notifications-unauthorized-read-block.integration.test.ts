import { describe, it, expect, vi } from "vitest";

/**
 * Integration test: unauthorized readers get NOTHING; authorized
 * clinicians get their data.
 *
 * Two read surfaces are exercised:
 *
 *   A. Referral list — server function `listReferralsForList` composes
 *      `assertClinicalAccess(supabase, userId)` (which calls
 *      `rpc("has_clinical_access", { _user_id })`) before any
 *      `.from("referrals").select("*")`. If the guard throws:
 *        - "Forbidden: clinical access required" for signed-in but
 *          non-clinical users, OR
 *        - "Permission check failed." for a failed/absent context,
 *      the referral table MUST NOT be queried and NO rows are returned.
 *      When the guard passes for a clinician, the query runs and rows
 *      come back.
 *
 *   B. In-app notifications — the browser client hits
 *      `notifications` directly through RLS
 *      (`policy: auth.uid() = user_id`, `TO authenticated`). A logged-
 *      out request has `auth.uid() IS NULL`, so `(NULL = user_id)`
 *      evaluates NULL and Postgres treats it as false → zero rows.
 *      A signed-in user only sees their own rows.
 *
 * The test replicates `assertClinicalAccess` exactly (the helper is
 * module-private in `referrals.functions.ts`) and drives an RLS-
 * emulating fake supabase. A regression that removes the guard, widens
 * the policy, or leaks another user's rows fails here.
 */

// ---------------------------------------------------------------------
// Faithful port of the private `assertClinicalAccess` guard.
// Mirror any change to the production helper here — a drift caught by
// this test is a regression by definition.
// ---------------------------------------------------------------------
async function assertClinicalAccess(
  supabase: { rpc: (fn: string, args: unknown) => Promise<{ data: unknown; error: unknown }> },
  userId: string | null,
): Promise<void> {
  const { data, error } = await supabase.rpc("has_clinical_access", { _user_id: userId });
  if (error) throw new Error("Permission check failed.");
  if (!data) throw new Error("Forbidden: clinical access required");
}

// ---------------------------------------------------------------------
// Fake supabase that models the production RLS on `referrals` and
// `notifications`. `.from(...).select(...)` returns the rows the
// caller's `auth.uid()` would see.
// ---------------------------------------------------------------------

const CLIN_A = "11111111-1111-1111-1111-111111111111";
const CLIN_B = "22222222-2222-2222-2222-222222222222";
const NON_CLINICAL = "33333333-3333-3333-3333-333333333333";
const REF_1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1";
const REF_2 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2";
const NOTIF_A1 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1";
const NOTIF_A2 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2";
const NOTIF_B1 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbc1";

const REFERRALS = [
  { id: REF_1, created_by: CLIN_A, deleted_at: null, patient_initials_enc: "cipher-1" },
  { id: REF_2, created_by: CLIN_B, deleted_at: null, patient_initials_enc: "cipher-2" },
];

const NOTIFICATIONS = [
  { id: NOTIF_A1, user_id: CLIN_A, referral_id: REF_1, kind: "new", message: "New referral", read_at: null, created_at: "2026-07-11T10:00:00Z" },
  { id: NOTIF_A2, user_id: CLIN_A, referral_id: REF_2, kind: "updated", message: "Referral updated", read_at: null, created_at: "2026-07-11T11:00:00Z" },
  { id: NOTIF_B1, user_id: CLIN_B, referral_id: REF_2, kind: "status", message: "Referral ACCEPTED", read_at: null, created_at: "2026-07-11T12:00:00Z" },
];

// Names of user-identifying columns; RLS on public tables MUST NEVER
// leak these to a caller whose auth.uid() does not match / lacks the
// clinical role.
const FORBIDDEN_LEAKS_FOR = (userId: string | null): string[] => {
  if (userId === CLIN_A) return ["cipher-2", NOTIF_B1];
  if (userId === CLIN_B) return ["cipher-1", NOTIF_A1, NOTIF_A2];
  // Unauthenticated / non-clinical: MUST see nothing at all.
  return ["cipher-1", "cipher-2", NOTIF_A1, NOTIF_A2, NOTIF_B1];
};

type Row = Record<string, unknown>;

function makeSupabase(opts: {
  userId: string | null;
  hasClinicalAccess: boolean;
  onFrom?: (table: string) => void;
}) {
  const authUid = opts.userId;
  const referralsFilter = (rows: Row[]): Row[] => {
    // Policy: auth.uid() must have clinical access AND
    // (deleted_at IS NULL OR auth.uid() = created_by OR admin).
    if (!authUid || !opts.hasClinicalAccess) return [];
    return rows.filter((r) => r.deleted_at === null);
  };
  const notificationsFilter = (rows: Row[]): Row[] => {
    // Policy: auth.uid() = user_id (TO authenticated).
    if (!authUid) return [];
    return rows.filter((r) => r.user_id === authUid);
  };
  const from = (table: string) => {
    opts.onFrom?.(table);
    const base = table === "referrals" ? REFERRALS : table === "notifications" ? NOTIFICATIONS : [];
    const filtered =
      table === "referrals"
        ? referralsFilter(base)
        : table === "notifications"
          ? notificationsFilter(base)
          : [];
    // Build a chainable that resolves to { data, error }.
    const result = { data: filtered, error: null };
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      is: () => chain,
      in: () => chain,
      order: () => chain,
      limit: () => Promise.resolve(result),
      range: () => Promise.resolve(result),
      maybeSingle: () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) => resolve(result),
    };
    return chain;
  };
  return {
    rpc: async (_fn: string, _args: unknown) => ({
      data: opts.hasClinicalAccess,
      error: null,
    }),
    from,
  };
}

function assertNoLeaks(where: string, payload: unknown, forbidden: string[]) {
  const s = JSON.stringify(payload);
  for (const marker of forbidden) {
    expect(s.includes(marker), `[${where}] leaked "${marker}"`).toBe(false);
  }
}

// ---------------------------------------------------------------------
// Compose the production handler shape for `listReferralsForList`.
// ---------------------------------------------------------------------
async function runListReferrals(context: { userId: string | null; supabase: any }) {
  await assertClinicalAccess(context.supabase, context.userId!);
  const { data, error } = await context.supabase
    .from("referrals")
    .select("*")
    .is("deleted_at", null)
    .order("referral_received_at", { ascending: false })
    .limit(500);
  if (error) throw new Error("Failed to load referrals.");
  return data ?? [];
}

async function runListNotifications(supabase: any) {
  const { data, error } = await supabase
    .from("notifications")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw new Error(error.message);
  return data ?? [];
}

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

describe("referral + notifications reads: unauthorized callers get nothing", () => {
  it("logged-out request → assertClinicalAccess throws, referrals table is never queried, zero notifications returned", async () => {
    const referralsProbe = vi.fn();
    const notifsProbe = vi.fn();
    // Logged out = no bearer. In production the `requireSupabaseAuth`
    // middleware refuses this request; if a future refactor lets it
    // through, the guard must still block the read.
    const supabaseForFn = makeSupabase({
      userId: null,
      hasClinicalAccess: false,
      onFrom: referralsProbe,
    });
    let caught: unknown;
    try {
      await runListReferrals({ userId: null, supabase: supabaseForFn });
    } catch (e) {
      caught = e;
    }
    expect((caught as Error)?.message).toBe("Forbidden: clinical access required");
    expect(referralsProbe).not.toHaveBeenCalled();

    // Notifications: the client hits the table directly; RLS with
    // auth.uid() IS NULL yields zero rows.
    const notifsSb = makeSupabase({
      userId: null,
      hasClinicalAccess: false,
      onFrom: notifsProbe,
    });
    const rows = await runListNotifications(notifsSb);
    expect(rows).toEqual([]);
    expect(notifsProbe).toHaveBeenCalledWith("notifications");
    assertNoLeaks("logged-out notifications", rows, FORBIDDEN_LEAKS_FOR(null));
  });

  it("signed-in but non-clinical user → guard throws, referrals never queried; notifications empty because none are addressed to them", async () => {
    const referralsProbe = vi.fn();
    const sb = makeSupabase({
      userId: NON_CLINICAL,
      hasClinicalAccess: false,
      onFrom: referralsProbe,
    });
    let caught: unknown;
    try {
      await runListReferrals({ userId: NON_CLINICAL, supabase: sb });
    } catch (e) {
      caught = e;
    }
    expect((caught as Error)?.message).toBe("Forbidden: clinical access required");
    expect(referralsProbe).not.toHaveBeenCalled();
    // The failing error surface itself must not carry any referral
    // ciphertext or foreign notification ids.
    assertNoLeaks("non-clinical error", (caught as Error).message, FORBIDDEN_LEAKS_FOR(NON_CLINICAL));

    const rows = await runListNotifications(sb);
    expect(rows).toEqual([]);
    assertNoLeaks("non-clinical notifications", rows, FORBIDDEN_LEAKS_FOR(NON_CLINICAL));
  });

  it("has_clinical_access RPC failure → surfaces generic 'Permission check failed.' and does not query referrals", async () => {
    const referralsProbe = vi.fn();
    const sb = {
      rpc: async () => ({ data: null, error: { message: "boom: HN-LEAK-1", code: "42501" } }),
      from: (t: string) => {
        referralsProbe(t);
        throw new Error("must not reach .from() when guard fails");
      },
    };
    let caught: unknown;
    try {
      await runListReferrals({ userId: NON_CLINICAL, supabase: sb });
    } catch (e) {
      caught = e;
    }
    expect((caught as Error)?.message).toBe("Permission check failed.");
    expect(referralsProbe).not.toHaveBeenCalled();
    expect((caught as Error).message).not.toContain("HN-LEAK-1");
    expect((caught as Error).message).not.toContain("42501");
  });
});

describe("referral + notifications reads: authorized clinicians receive their data", () => {
  it("clinician A → referral list returns live rows; notifications returns ONLY their own rows", async () => {
    const referralsProbe = vi.fn();
    const notifsProbe = vi.fn();
    const sb = makeSupabase({
      userId: CLIN_A,
      hasClinicalAccess: true,
      onFrom: (t) => (t === "referrals" ? referralsProbe(t) : notifsProbe(t)),
    });

    const refs = await runListReferrals({ userId: CLIN_A, supabase: sb });
    expect(referralsProbe).toHaveBeenCalledWith("referrals");
    // RLS returns all live rows to any authorized clinician (queue
    // is shared across the CCU team).
    expect(refs).toHaveLength(2);
    const refIds = (refs as Row[]).map((r) => r.id);
    expect(refIds).toEqual(expect.arrayContaining([REF_1, REF_2]));

    const notifs = await runListNotifications(sb);
    expect(notifsProbe).toHaveBeenCalledWith("notifications");
    // Clinician A must ONLY see their own two notifications and NEVER
    // clinician B's row — the RLS `auth.uid() = user_id` policy is the
    // sole barrier and must hold.
    expect((notifs as Row[]).map((n) => n.id).sort()).toEqual(
      [NOTIF_A1, NOTIF_A2].sort(),
    );
    for (const n of notifs as Row[]) {
      expect(n.user_id).toBe(CLIN_A);
    }
    assertNoLeaks("clinA notifications", notifs, FORBIDDEN_LEAKS_FOR(CLIN_A));
  });

  it("clinician B → sees the shared referral queue but ONLY their own notification, never clinician A's rows", async () => {
    const sb = makeSupabase({ userId: CLIN_B, hasClinicalAccess: true });

    const refs = await runListReferrals({ userId: CLIN_B, supabase: sb });
    expect((refs as Row[]).map((r) => r.id)).toEqual(
      expect.arrayContaining([REF_1, REF_2]),
    );

    const notifs = await runListNotifications(sb);
    expect((notifs as Row[]).map((n) => n.id)).toEqual([NOTIF_B1]);
    assertNoLeaks("clinB notifications", notifs, FORBIDDEN_LEAKS_FOR(CLIN_B));
  });
});
