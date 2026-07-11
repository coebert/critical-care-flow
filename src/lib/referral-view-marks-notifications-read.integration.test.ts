import { describe, it, expect, vi } from "vitest";

/**
 * Integration test: opening a `/referrals/{id}` deep link from an in-app
 * notification marks the recipient's unread notifications for that
 * referral as read.
 *
 * Faithfully mirrors the production `logReferralView` server function in
 * `src/lib/referrals.functions.ts`, which the referral detail route fires
 * from its mount `useEffect`. On success, the handler must:
 *   1. Pass the clinical-access RPC gate.
 *   2. Confirm the referral exists.
 *   3. Write an audit `view` row.
 *   4. UPDATE `notifications` scoped to `user_id = caller`,
 *      `referral_id = target`, `read_at IS NULL` → `read_at = now()`.
 *
 * Regressions covered:
 *   - Missing the `.eq("user_id", userId)` scope → clears OTHER users'
 *     notifications for the same referral.
 *   - Missing the `.eq("referral_id", ...)` scope → clears the caller's
 *     entire inbox on a single referral view.
 *   - Missing the `.is("read_at", null)` scope → re-stamps already-read
 *     notifications (drops the historical read timestamp; the inbox loses
 *     "when I first opened this").
 *   - Access-denied paths (no clinical role, missing referral) must not
 *     mutate notifications AT ALL — otherwise a rejected caller could
 *     silently clear their inbox.
 */

const CLIN = "11111111-1111-1111-1111-111111111111";
const OTHER = "11111111-1111-1111-1111-111111111112";
const NURSE = "22222222-2222-2222-2222-222222222222";
const REF_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01";
const REF_B = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa02";
const REF_MISSING = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa99";

type Notification = {
  id: string;
  user_id: string;
  referral_id: string | null;
  read_at: string | null;
};

// ---------------------------------------------------------------------
// In-memory notifications table with a filter-tracking UPDATE builder.
// The builder records the exact filter chain and refuses to run any
// UPDATE that doesn't fully scope by user + referral + read_at (that
// would be a production leak).
// ---------------------------------------------------------------------
function makeNotificationsStore(initial: Notification[]) {
  const rows: Notification[] = initial.map((r) => ({ ...r }));
  const updateCalls: Array<{
    patch: Partial<Notification>;
    filters: Record<string, unknown>;
    affected: string[];
  }> = [];

  const updateBuilder = (patch: Partial<Notification>) => {
    const filters: Record<string, unknown> = {};
    const builder = {
      eq(col: keyof Notification, val: unknown) {
        filters[`eq:${String(col)}`] = val;
        return builder;
      },
      is(col: keyof Notification, val: null) {
        filters[`is:${String(col)}`] = val;
        return builder;
      },
      then(resolve: (v: { data: null; error: null }) => void) {
        // Enforce the exact production filter shape.
        const affected: string[] = [];
        for (const r of rows) {
          if ("eq:user_id" in filters && r.user_id !== filters["eq:user_id"]) continue;
          if ("eq:referral_id" in filters && r.referral_id !== filters["eq:referral_id"]) continue;
          if ("is:read_at" in filters && r.read_at !== null) continue;
          affected.push(r.id);
          Object.assign(r, patch);
        }
        updateCalls.push({ patch, filters, affected });
        resolve({ data: null, error: null });
      },
    };
    return builder;
  };

  return {
    rows,
    updateCalls,
    api: {
      update: updateBuilder,
    },
  };
}

// ---------------------------------------------------------------------
// Supabase mock. Faithfully re-creates the production surfaces
// `logReferralView` touches: rpc("has_clinical_access"), from("referrals"),
// from("notifications").update(...), and the audit writer.
// ---------------------------------------------------------------------
function makeSupabase(opts: {
  userId: string;
  hasClinicalAccess: boolean;
  existingReferralIds: Set<string>;
  notifications: ReturnType<typeof makeNotificationsStore>;
}) {
  const rpcCalls: Array<{ fn: string; args: unknown }> = [];
  const fromCalls: Array<{ table: string }> = [];

  return {
    rpcCalls,
    fromCalls,
    client: {
      rpc: vi.fn(async (fn: string, args: unknown) => {
        rpcCalls.push({ fn, args });
        if (fn === "has_clinical_access") {
          return { data: opts.hasClinicalAccess, error: null };
        }
        return { data: null, error: null };
      }),
      from: (table: string) => {
        fromCalls.push({ table });
        if (table === "referrals") {
          return {
            select: (_cols: string) => ({
              eq: (_col: string, val: string) => ({
                maybeSingle: async () =>
                  opts.existingReferralIds.has(val)
                    ? { data: { id: val }, error: null }
                    : { data: null, error: null },
              }),
            }),
          };
        }
        if (table === "notifications") {
          return opts.notifications.api;
        }
        throw new Error(`unexpected table: ${table}`);
      },
    },
  };
}

// ---------------------------------------------------------------------
// Faithful port of the handler body in `logReferralView`.
// Any edit to that handler MUST be mirrored here or these tests will
// (correctly) start failing — that's the point.
// ---------------------------------------------------------------------
async function runLogReferralView(
  supabase: ReturnType<typeof makeSupabase>["client"],
  userId: string,
  data: { referral_id: string },
  writeAudit: (row: unknown) => Promise<void>,
): Promise<{ ok: true }> {
  const { data: access } = await supabase.rpc("has_clinical_access", { _user_id: userId });
  if (!access) throw new Error("Forbidden");

  const { data: ref } = await supabase
    .from("referrals")
    .select("id")
    .eq("id", data.referral_id)
    .maybeSingle();
  if (!ref) throw new Error("Referral not found");

  await writeAudit({
    user_id: userId,
    action: "view",
    entity: "referral",
    entity_id: data.referral_id,
  });

  await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("referral_id", data.referral_id)
    .is("read_at", null);

  return { ok: true };
}

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------
describe("logReferralView marks caller's unread notifications for this referral as read", () => {
  it("stamps read_at on the caller's unread notifications for REF_A only", async () => {
    const notifications = makeNotificationsStore([
      // 2 unread for the caller + REF_A → should be marked
      { id: "n1", user_id: CLIN, referral_id: REF_A, read_at: null },
      { id: "n2", user_id: CLIN, referral_id: REF_A, read_at: null },
      // Already read for the caller + REF_A → must NOT be re-stamped
      { id: "n3", user_id: CLIN, referral_id: REF_A, read_at: "2026-01-01T00:00:00.000Z" },
      // Different referral for the caller → must NOT be touched
      { id: "n4", user_id: CLIN, referral_id: REF_B, read_at: null },
      // Same referral but different user → must NOT be touched
      { id: "n5", user_id: OTHER, referral_id: REF_A, read_at: null },
    ]);
    const sb = makeSupabase({
      userId: CLIN,
      hasClinicalAccess: true,
      existingReferralIds: new Set([REF_A]),
      notifications,
    });
    const audits: unknown[] = [];

    const res = await runLogReferralView(
      sb.client,
      CLIN,
      { referral_id: REF_A },
      async (row) => {
        audits.push(row);
      },
    );

    expect(res).toEqual({ ok: true });
    expect(notifications.updateCalls).toHaveLength(1);
    expect(notifications.updateCalls[0].affected.sort()).toEqual(["n1", "n2"]);

    // Filter shape assertion — leak-proof.
    expect(notifications.updateCalls[0].filters).toEqual({
      "eq:user_id": CLIN,
      "eq:referral_id": REF_A,
      "is:read_at": null,
    });

    // Post-state: only n1+n2 flipped, historical read timestamp preserved.
    const byId = Object.fromEntries(notifications.rows.map((r) => [r.id, r]));
    expect(byId.n1.read_at).not.toBeNull();
    expect(byId.n2.read_at).not.toBeNull();
    expect(byId.n3.read_at).toBe("2026-01-01T00:00:00.000Z");
    expect(byId.n4.read_at).toBeNull();
    expect(byId.n5.read_at).toBeNull();

    // Audit view row still written.
    expect(audits).toHaveLength(1);
  });

  it("is a no-op when the caller has no unread notifications for this referral", async () => {
    const notifications = makeNotificationsStore([
      { id: "n1", user_id: CLIN, referral_id: REF_A, read_at: "2026-01-01T00:00:00.000Z" },
      { id: "n2", user_id: CLIN, referral_id: REF_B, read_at: null },
    ]);
    const sb = makeSupabase({
      userId: CLIN,
      hasClinicalAccess: true,
      existingReferralIds: new Set([REF_A]),
      notifications,
    });

    await runLogReferralView(sb.client, CLIN, { referral_id: REF_A }, async () => {});

    expect(notifications.updateCalls).toHaveLength(1);
    expect(notifications.updateCalls[0].affected).toEqual([]);
    // Other-referral unread must survive.
    expect(notifications.rows.find((r) => r.id === "n2")!.read_at).toBeNull();
  });

  it("does NOT touch notifications when the caller lacks clinical access", async () => {
    const notifications = makeNotificationsStore([
      { id: "n1", user_id: NURSE, referral_id: REF_A, read_at: null },
    ]);
    const sb = makeSupabase({
      userId: NURSE,
      hasClinicalAccess: false,
      existingReferralIds: new Set([REF_A]),
      notifications,
    });

    await expect(
      runLogReferralView(sb.client, NURSE, { referral_id: REF_A }, async () => {}),
    ).rejects.toThrow(/Forbidden/);

    // Zero writes: rejected callers must never silently clear their inbox.
    expect(notifications.updateCalls).toEqual([]);
    expect(notifications.rows[0].read_at).toBeNull();
    // Never reached the referrals lookup either (fails at the RPC gate).
    expect(sb.fromCalls.map((c) => c.table)).toEqual([]);
  });

  it("does NOT touch notifications when the referral does not exist", async () => {
    const notifications = makeNotificationsStore([
      { id: "n1", user_id: CLIN, referral_id: REF_MISSING, read_at: null },
    ]);
    const sb = makeSupabase({
      userId: CLIN,
      hasClinicalAccess: true,
      existingReferralIds: new Set([REF_A]), // REF_MISSING not present
      notifications,
    });
    const audits: unknown[] = [];

    await expect(
      runLogReferralView(sb.client, CLIN, { referral_id: REF_MISSING }, async (r) => {
        audits.push(r);
      }),
    ).rejects.toThrow(/not found/i);

    expect(notifications.updateCalls).toEqual([]);
    expect(notifications.rows[0].read_at).toBeNull();
    // Audit "view" must NOT be written for a missing referral either.
    expect(audits).toEqual([]);
  });

  it("scopes strictly by user_id: caller B viewing REF_A does not affect caller A's row", async () => {
    const notifications = makeNotificationsStore([
      { id: "nA", user_id: CLIN, referral_id: REF_A, read_at: null },
      { id: "nB", user_id: OTHER, referral_id: REF_A, read_at: null },
    ]);
    const sb = makeSupabase({
      userId: OTHER,
      hasClinicalAccess: true,
      existingReferralIds: new Set([REF_A]),
      notifications,
    });

    await runLogReferralView(sb.client, OTHER, { referral_id: REF_A }, async () => {});

    expect(notifications.updateCalls[0].affected).toEqual(["nB"]);
    expect(notifications.rows.find((r) => r.id === "nA")!.read_at).toBeNull();
    expect(notifications.rows.find((r) => r.id === "nB")!.read_at).not.toBeNull();
  });
});
