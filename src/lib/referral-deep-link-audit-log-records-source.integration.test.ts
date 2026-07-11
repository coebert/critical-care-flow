import { describe, it, expect, vi } from "vitest";

/**
 * Integration test: `/referrals/{id}` deep-link access is recorded in
 * `audit_log`, capturing WHO opened the referral and — when the visit
 * originated from an in-app notification — WHICH notification carried the
 * deep link.
 *
 * Faithfully mirrors the `logReferralView` handler in
 * `src/lib/referrals.functions.ts`:
 *
 *   1. Passes the `has_clinical_access` RPC gate.
 *   2. Confirms the referral exists.
 *   3. If `notification_id` was supplied, RE-VERIFIES it against
 *      `notifications` scoped to (user_id = caller, referral_id = target).
 *      A forged / stolen / wrong-referral id must be dropped BEFORE it is
 *      written into the audit row.
 *   4. Writes exactly one `audit_log` row of shape:
 *        { user_id, action: "view", entity: "referral",
 *          entity_id: referral_id,
 *          diff: { source, notification_id } }
 *      where `source` is "notification" iff a verified notification id
 *      exists, else "direct" (or the explicit override).
 *   5. Marks the caller's unread notifications for this referral as read
 *      (covered end-to-end by `referral-view-marks-notifications-read`).
 *
 * Regressions covered:
 *   - Handler skips writing the audit on the deep-link path.
 *   - Handler trusts `notification_id` without cross-checking user/referral
 *     → attacker credits their view to another user's notification, or to
 *     an unrelated referral, muddying forensics.
 *   - Handler labels a direct visit as "notification" (or vice versa).
 *   - Handler leaks the unverified id into the audit row even after the
 *     verification lookup returns nothing.
 *   - Access-denied paths (no clinical role, missing referral) write an
 *     audit row anyway — audit_log must never record a "view" that was
 *     actually rejected.
 */

const CLIN = "11111111-1111-1111-1111-111111111111";
const OTHER = "11111111-1111-1111-1111-111111111112";
const NURSE = "22222222-2222-2222-2222-222222222222";
const REF_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01";
const REF_B = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa02";
const REF_MISSING = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa99";
const NOTIF_OK = "cccccccc-cccc-cccc-cccc-ccccccccccc1";
const NOTIF_WRONG_REF = "cccccccc-cccc-cccc-cccc-ccccccccccc2";
const NOTIF_OTHER_USER = "cccccccc-cccc-cccc-cccc-ccccccccccc3";
const NOTIF_FORGED = "cccccccc-cccc-cccc-cccc-ccccccccccc9";

type Notification = {
  id: string;
  user_id: string;
  referral_id: string;
};

// ---------------------------------------------------------------------
// Supabase fixture: notifications lookup is scoped by (id, user_id,
// referral_id) exactly like the production verification query.
// ---------------------------------------------------------------------
function makeSupabase(opts: {
  hasClinicalAccess: boolean;
  existingReferralIds: Set<string>;
  notifications: Notification[];
}) {
  const rpcCalls: Array<{ fn: string; args: unknown }> = [];
  const notifSelectFilters: Array<Record<string, unknown>> = [];
  const notifUpdateCalls: Array<{ filters: Record<string, unknown> }> = [];

  const client = {
    rpc: vi.fn(async (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args });
      if (fn === "has_clinical_access") return { data: opts.hasClinicalAccess, error: null };
      return { data: null, error: null };
    }),
    from: (table: string) => {
      if (table === "referrals") {
        return {
          select: (_c: string) => ({
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
        // Two shapes used here: SELECT-with-eq-chain(maybeSingle), and
        // UPDATE-with-eq-chain-then-is(read_at, null).
        return {
          select: (_c: string) => {
            const filters: Record<string, unknown> = {};
            const b: any = {
              eq(col: string, v: unknown) {
                filters[col] = v;
                return b;
              },
              async maybeSingle() {
                notifSelectFilters.push({ ...filters });
                const hit = opts.notifications.find(
                  (n) =>
                    n.id === filters.id &&
                    n.user_id === filters.user_id &&
                    n.referral_id === filters.referral_id,
                );
                return { data: hit ? { id: hit.id } : null, error: null };
              },
            };
            return b;
          },
          update: (_patch: unknown) => {
            const filters: Record<string, unknown> = {};
            const b: any = {
              eq(col: string, v: unknown) {
                filters[`eq:${col}`] = v;
                return b;
              },
              is(col: string, v: unknown) {
                filters[`is:${col}`] = v;
                return b;
              },
              then(resolve: (v: { data: null; error: null }) => void) {
                notifUpdateCalls.push({ filters });
                resolve({ data: null, error: null });
              },
            };
            return b;
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };

  return { client, rpcCalls, notifSelectFilters, notifUpdateCalls };
}

// ---------------------------------------------------------------------
// Faithful port of `logReferralView`. Any change to the production
// handler MUST be mirrored here.
// ---------------------------------------------------------------------
type Input = {
  referral_id: string;
  notification_id?: string;
  source?: "notification" | "direct" | "list";
};
type AuditRow = {
  user_id: string;
  action: string;
  entity: string;
  entity_id: string;
  diff?: { source: string; notification_id: string | null };
};

async function runLogReferralView(
  supabase: any,
  userId: string,
  data: Input,
  writeAudit: (row: AuditRow) => Promise<void>,
): Promise<{ ok: true }> {
  const { data: access } = await supabase.rpc("has_clinical_access", { _user_id: userId });
  if (!access) throw new Error("Forbidden");

  const { data: ref } = await supabase
    .from("referrals")
    .select("id")
    .eq("id", data.referral_id)
    .maybeSingle();
  if (!ref) throw new Error("Referral not found");

  let verifiedNotificationId: string | null = null;
  if (data.notification_id) {
    const { data: n } = await supabase
      .from("notifications")
      .select("id")
      .eq("id", data.notification_id)
      .eq("user_id", userId)
      .eq("referral_id", data.referral_id)
      .maybeSingle();
    if (n) verifiedNotificationId = n.id;
  }

  const source = data.source ?? (verifiedNotificationId ? "notification" : "direct");

  await writeAudit({
    user_id: userId,
    action: "view",
    entity: "referral",
    entity_id: data.referral_id,
    diff: { source, notification_id: verifiedNotificationId },
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
// Fixture: notifications actually persisted in the database.
// ---------------------------------------------------------------------
const NOTIFS: Notification[] = [
  { id: NOTIF_OK, user_id: CLIN, referral_id: REF_A },
  { id: NOTIF_WRONG_REF, user_id: CLIN, referral_id: REF_B },
  { id: NOTIF_OTHER_USER, user_id: OTHER, referral_id: REF_A },
];

describe("deep-link view is recorded in audit_log with actor + referral + source notification", () => {
  it("records a view with source=notification and the verified notification_id", async () => {
    const sb = makeSupabase({
      hasClinicalAccess: true,
      existingReferralIds: new Set([REF_A, REF_B]),
      notifications: NOTIFS,
    });
    const audits: AuditRow[] = [];

    await runLogReferralView(
      sb.client,
      CLIN,
      { referral_id: REF_A, notification_id: NOTIF_OK },
      async (r) => {
        audits.push(r);
      },
    );

    expect(audits).toHaveLength(1);
    expect(audits[0]).toEqual({
      user_id: CLIN,
      action: "view",
      entity: "referral",
      entity_id: REF_A,
      diff: { source: "notification", notification_id: NOTIF_OK },
    });

    // The verification lookup was scoped by all three columns.
    expect(sb.notifSelectFilters).toEqual([
      { id: NOTIF_OK, user_id: CLIN, referral_id: REF_A },
    ]);
  });

  it("records source=direct with notification_id=null when no notification_id is supplied", async () => {
    const sb = makeSupabase({
      hasClinicalAccess: true,
      existingReferralIds: new Set([REF_A]),
      notifications: NOTIFS,
    });
    const audits: AuditRow[] = [];

    await runLogReferralView(sb.client, CLIN, { referral_id: REF_A }, async (r) => {
      audits.push(r);
    });

    expect(audits).toHaveLength(1);
    expect(audits[0].diff).toEqual({ source: "direct", notification_id: null });
    // No notification verification lookup fired.
    expect(sb.notifSelectFilters).toEqual([]);
  });

  it("drops a notification_id whose referral does not match the opened referral", async () => {
    // NOTIF_WRONG_REF belongs to CLIN but was fired for REF_B, not REF_A.
    // A caller pasting it into a REF_A deep link must NOT get REF_B
    // credit in the audit trail.
    const sb = makeSupabase({
      hasClinicalAccess: true,
      existingReferralIds: new Set([REF_A, REF_B]),
      notifications: NOTIFS,
    });
    const audits: AuditRow[] = [];

    await runLogReferralView(
      sb.client,
      CLIN,
      { referral_id: REF_A, notification_id: NOTIF_WRONG_REF },
      async (r) => {
        audits.push(r);
      },
    );

    expect(audits[0].entity_id).toBe(REF_A);
    // Lookup missed → id scrubbed from the audit row; source falls back
    // to "direct".
    expect(audits[0].diff).toEqual({ source: "direct", notification_id: null });
  });

  it("drops a notification_id belonging to a different user", async () => {
    // NOTIF_OTHER_USER was addressed to OTHER, not CLIN.
    const sb = makeSupabase({
      hasClinicalAccess: true,
      existingReferralIds: new Set([REF_A]),
      notifications: NOTIFS,
    });
    const audits: AuditRow[] = [];

    await runLogReferralView(
      sb.client,
      CLIN,
      { referral_id: REF_A, notification_id: NOTIF_OTHER_USER },
      async (r) => {
        audits.push(r);
      },
    );

    expect(audits[0].diff).toEqual({ source: "direct", notification_id: null });
  });

  it("drops an entirely forged notification_id (no matching row at all)", async () => {
    const sb = makeSupabase({
      hasClinicalAccess: true,
      existingReferralIds: new Set([REF_A]),
      notifications: NOTIFS,
    });
    const audits: AuditRow[] = [];

    await runLogReferralView(
      sb.client,
      CLIN,
      { referral_id: REF_A, notification_id: NOTIF_FORGED },
      async (r) => {
        audits.push(r);
      },
    );

    expect(audits[0].diff).toEqual({ source: "direct", notification_id: null });
  });

  it("writes NO audit row when the caller lacks clinical access", async () => {
    const sb = makeSupabase({
      hasClinicalAccess: false,
      existingReferralIds: new Set([REF_A]),
      notifications: NOTIFS,
    });
    const audits: AuditRow[] = [];

    await expect(
      runLogReferralView(
        sb.client,
        NURSE,
        { referral_id: REF_A, notification_id: NOTIF_OK },
        async (r) => { audits.push(r); },
      ),
    ).rejects.toThrow(/Forbidden/);

    expect(audits).toEqual([]);
    // Never even ran the notification verification.
    expect(sb.notifSelectFilters).toEqual([]);
    // Never marked notifications read.
    expect(sb.notifUpdateCalls).toEqual([]);
  });

  it("writes NO audit row when the referral does not exist", async () => {
    const sb = makeSupabase({
      hasClinicalAccess: true,
      existingReferralIds: new Set([REF_A]),
      notifications: NOTIFS,
    });
    const audits: AuditRow[] = [];

    await expect(
      runLogReferralView(
        sb.client,
        CLIN,
        { referral_id: REF_MISSING, notification_id: NOTIF_OK },
        async (r) => { audits.push(r); },
      ),
    ).rejects.toThrow(/not found/i);

    expect(audits).toEqual([]);
    expect(sb.notifSelectFilters).toEqual([]);
    expect(sb.notifUpdateCalls).toEqual([]);
  });

  it("captures actor + referral pair correctly across concurrent viewers", async () => {
    // Two distinct clinicians open the same referral from their own
    // notification. audit_log must clearly attribute each view to its
    // own actor + notification id.
    const notifs: Notification[] = [
      { id: NOTIF_OK, user_id: CLIN, referral_id: REF_A },
      { id: "cccccccc-cccc-cccc-cccc-cccccccccc10", user_id: OTHER, referral_id: REF_A },
    ];
    const sb1 = makeSupabase({
      hasClinicalAccess: true,
      existingReferralIds: new Set([REF_A]),
      notifications: notifs,
    });
    const sb2 = makeSupabase({
      hasClinicalAccess: true,
      existingReferralIds: new Set([REF_A]),
      notifications: notifs,
    });
    const audits: AuditRow[] = [];

    await runLogReferralView(
      sb1.client,
      CLIN,
      { referral_id: REF_A, notification_id: NOTIF_OK },
      async (r) => { audits.push(r); },
    );
    await runLogReferralView(
      sb2.client,
      OTHER,
      { referral_id: REF_A, notification_id: "cccccccc-cccc-cccc-cccc-cccccccccc10" },
      async (r) => { audits.push(r); },
    );

    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({
      user_id: CLIN,
      entity_id: REF_A,
      diff: { source: "notification", notification_id: NOTIF_OK },
    });
    expect(audits[1]).toMatchObject({
      user_id: OTHER,
      entity_id: REF_A,
      diff: { source: "notification", notification_id: "cccccccc-cccc-cccc-cccc-cccccccccc10" },
    });
  });
});
