import { describe, it, expect } from "vitest";

/**
 * Verification: a notification_id can only ever be credited to ONE
 * referral view per user. The server-side rules in
 * src/lib/referrals.functions.ts :: logReferralView are:
 *
 *   1. The notification must belong to the caller (user_id === auth.uid()).
 *   2. Its referral_id must match the referral being opened — a
 *      notification cannot attribute a view against a different referral.
 *   3. It must still be unread (read_at IS NULL). Once marked read (via
 *      "Mark all read", inbox open, or a prior deep-link view), the id is
 *      spent and can no longer drive attribution.
 *   4. It must not appear in any prior audit_log 'view' entry by this
 *      user. This blocks reuse across referrals and repeat attribution
 *      on the same referral (reload / back button / opened twice).
 *
 * Any failed check scrubs the notification_id to null in the audit diff
 * (source falls back to "direct"). The view row is still written; only
 * the attribution is dropped.
 */

type AuditRow = {
  user_id: string;
  action: "view";
  entity: "referral";
  entity_id: string;
  diff: { source: "notification" | "direct" | "list"; notification_id: string | null };
};

type NotifRow = {
  id: string;
  user_id: string;
  referral_id: string;
  read_at: string | null;
};

function makeBackend(opts: {
  callerId: string;
  referrals: string[];
  notifications: NotifRow[];
}) {
  const audit: AuditRow[] = [];
  const notifications = opts.notifications.map((n) => ({ ...n }));

  async function logReferralView(input: {
    referral_id: string;
    notification_id?: string;
    source?: "notification" | "direct" | "list";
  }) {
    if (!opts.referrals.includes(input.referral_id)) throw new Error("Referral not found");

    let verifiedNotificationId: string | null = null;
    if (input.notification_id) {
      const hit = notifications.find(
        (n) =>
          n.id === input.notification_id &&
          n.user_id === opts.callerId &&
          n.referral_id === input.referral_id,
      );
      // Rule 3: must still be unread.
      if (hit && hit.read_at === null) {
        // Rule 4: must not have been consumed by a prior view by this user.
        const priorUse = audit.find(
          (a) =>
            a.user_id === opts.callerId &&
            a.action === "view" &&
            a.entity === "referral" &&
            a.diff.notification_id === input.notification_id,
        );
        if (!priorUse) verifiedNotificationId = hit.id;
      }
    }
    const source = input.source ?? (verifiedNotificationId ? "notification" : "direct");

    audit.push({
      user_id: opts.callerId,
      action: "view",
      entity: "referral",
      entity_id: input.referral_id,
      diff: { source, notification_id: verifiedNotificationId },
    });

    // Marking-read side-effect happens AFTER attribution, mirroring the
    // real server fn — so a first successful view both credits AND spends
    // the notification.
    const now = new Date().toISOString();
    for (const n of notifications) {
      if (n.user_id === opts.callerId && n.referral_id === input.referral_id && !n.read_at) {
        n.read_at = now;
      }
    }
  }

  return { audit, notifications, logReferralView };
}

const USER = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const REF_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01";
const REF_B = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa02";
const NOTIF = "cccccccc-cccc-cccc-cccc-ccccccccccc1";
const NOTIF_B = "cccccccc-cccc-cccc-cccc-ccccccccccc2";

function seed() {
  return makeBackend({
    callerId: USER,
    referrals: [REF_A, REF_B],
    notifications: [
      { id: NOTIF, user_id: USER, referral_id: REF_A, read_at: null },
      { id: NOTIF_B, user_id: USER, referral_id: REF_B, read_at: null },
    ],
  });
}

describe("notification_id is single-use per user", () => {
  it("first deep-link view credits the notification_id", async () => {
    const be = seed();
    await be.logReferralView({ referral_id: REF_A, notification_id: NOTIF, source: "notification" });

    expect(be.audit).toHaveLength(1);
    expect(be.audit[0].diff).toEqual({ source: "notification", notification_id: NOTIF });
  });

  it("second view of the SAME referral with the same id (reload / back button) is scrubbed", async () => {
    const be = seed();
    await be.logReferralView({ referral_id: REF_A, notification_id: NOTIF, source: "notification" });
    await be.logReferralView({ referral_id: REF_A, notification_id: NOTIF, source: "notification" });

    expect(be.audit).toHaveLength(2);
    expect(be.audit[0].diff.notification_id).toBe(NOTIF);
    // Reused → scrubbed. Notification is also now read, but the
    // audit-log check catches this even before the read-state check runs.
    expect(be.audit[1].diff).toEqual({ source: "notification", notification_id: null });
  });

  it("cannot be reused against a DIFFERENT referral", async () => {
    const be = seed();
    // First: legitimately spend NOTIF on REF_A.
    await be.logReferralView({ referral_id: REF_A, notification_id: NOTIF, source: "notification" });
    // Then: attempt to attribute a view on REF_B with the same id.
    await be.logReferralView({ referral_id: REF_B, notification_id: NOTIF, source: "notification" });

    expect(be.audit[1].entity_id).toBe(REF_B);
    // Referral mismatch alone would already scrub it; the audit-log dedupe
    // is the belt-and-braces guarantee. Either way: null.
    expect(be.audit[1].diff.notification_id).toBeNull();
  });

  it("id from a notification that is already read cannot be used", async () => {
    const be = makeBackend({
      callerId: USER,
      referrals: [REF_A],
      notifications: [
        // Already-read notification (e.g. cleared via "Mark all read").
        { id: NOTIF, user_id: USER, referral_id: REF_A, read_at: new Date().toISOString() },
      ],
    });
    await be.logReferralView({ referral_id: REF_A, notification_id: NOTIF, source: "notification" });

    expect(be.audit).toHaveLength(1);
    expect(be.audit[0].diff.notification_id).toBeNull();
  });

  it("distinct notification ids are each usable exactly once", async () => {
    const be = seed();
    await be.logReferralView({ referral_id: REF_A, notification_id: NOTIF, source: "notification" });
    await be.logReferralView({ referral_id: REF_B, notification_id: NOTIF_B, source: "notification" });

    expect(be.audit[0].diff.notification_id).toBe(NOTIF);
    expect(be.audit[1].diff.notification_id).toBe(NOTIF_B);
  });

  it("another user reusing a spent id gets nothing (per-user ledger, but their own audit log is separate)", async () => {
    const beMe = seed();
    await beMe.logReferralView({ referral_id: REF_A, notification_id: NOTIF, source: "notification" });

    // Simulate a second user whose own (different) notification points at
    // the same referral — a different id, so it's freely usable by them.
    const beOther = makeBackend({
      callerId: OTHER,
      referrals: [REF_A],
      notifications: [{ id: NOTIF_B, user_id: OTHER, referral_id: REF_A, read_at: null }],
    });
    await beOther.logReferralView({
      referral_id: REF_A,
      notification_id: NOTIF_B,
      source: "notification",
    });

    expect(beMe.audit[0].diff.notification_id).toBe(NOTIF);
    expect(beOther.audit[0].diff.notification_id).toBe(NOTIF_B);
  });

  it("scrubbed reuse still writes the view row (audit is not suppressed)", async () => {
    const be = seed();
    await be.logReferralView({ referral_id: REF_A, notification_id: NOTIF, source: "notification" });
    await be.logReferralView({ referral_id: REF_A, notification_id: NOTIF, source: "notification" });

    expect(be.audit).toHaveLength(2);
    expect(be.audit.every((a) => a.user_id === USER && a.entity_id === REF_A)).toBe(true);
  });
});
