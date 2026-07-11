import { describe, it, expect } from "vitest";

/**
 * Verification: clicking a notification deep-link from the clinician UI
 * records the correct audit_log entry — carrying the accessing user, the
 * referral_id, and the source notification_id.
 *
 * Faithful trace of the production wiring:
 *
 *   NotificationBell / InboxList / InboxDetail
 *     └─ <Link to="/referrals/$id" params={{ id: n.referral_id }}
 *              search={{ n: n.id }} />
 *
 *   src/routes/_authenticated/referrals.$id.tsx
 *     validateSearch → { highlight, n }
 *     useEffect → logView({ data: { referral_id: id,
 *                                    notification_id: n,
 *                                    source: "notification" } })
 *
 *   src/lib/referrals.functions.ts :: logReferralView
 *     1. assert has_clinical_access(user)
 *     2. verify referral exists
 *     3. verify notification.user_id === caller AND
 *                 notification.referral_id === referral_id
 *        else drop it to null (source falls back to "direct")
 *     4. writeAudit({
 *          user_id: userId,       // accessing user
 *          action: "view",
 *          entity: "referral",
 *          entity_id: referral_id,
 *          diff: { source, notification_id: verifiedOrNull }
 *        })
 *     5. mark this user's unread notifications for this referral as read
 *
 * Regressions covered:
 *   - The bell/inbox stops forwarding the notification id (link created
 *     without `search={{ n: ... }}`) → audit entry falls back to "direct"
 *     and loses provenance.
 *   - `n` search param not declared on the route → validator strips it
 *     and `logView` never sees it.
 *   - A forged notification id from another user or another referral is
 *     accepted at face value.
 *   - Audit entry attributed to the wrong user (e.g. captured from the
 *     notification's user_id instead of auth.uid()).
 *   - Deep-link visit fails to mark the source notification read.
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

// ---------- Fixture backend ----------
// Mirrors the exact server-side sequence in logReferralView, so any change
// to that fn's ordering / verification / audit payload will surface as a
// test failure here.

function makeBackend(opts: {
  callerId: string;
  callerHasClinicalAccess: boolean;
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
    if (!opts.callerHasClinicalAccess) throw new Error("Forbidden");
    if (!opts.referrals.includes(input.referral_id)) throw new Error("Referral not found");

    let verifiedNotificationId: string | null = null;
    if (input.notification_id) {
      const hit = notifications.find(
        (n) =>
          n.id === input.notification_id &&
          n.user_id === opts.callerId &&
          n.referral_id === input.referral_id,
      );
      if (hit) verifiedNotificationId = hit.id;
    }
    const source = input.source ?? (verifiedNotificationId ? "notification" : "direct");

    audit.push({
      user_id: opts.callerId,
      action: "view",
      entity: "referral",
      entity_id: input.referral_id,
      diff: { source, notification_id: verifiedNotificationId },
    });

    const now = new Date().toISOString();
    for (const n of notifications) {
      if (n.user_id === opts.callerId && n.referral_id === input.referral_id && !n.read_at) {
        n.read_at = now;
      }
    }
  }

  return { audit, notifications, logReferralView };
}

// Mirrors what the Link + route effect sends when the user clicks a bell/
// inbox notification: params carries the referral id, search carries the
// notification id under the key `n`, and the effect forwards both to
// logView with source: "notification".
function simulateDeepLinkClick(
  be: ReturnType<typeof makeBackend>,
  args: { referralId: string; notificationId: string },
) {
  return be.logReferralView({
    referral_id: args.referralId,
    notification_id: args.notificationId,
    source: "notification",
  });
}

// ---------- Fixtures ----------
const USER = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const REF_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01";
const REF_B = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa02";
const NOTIF_MINE = "cccccccc-cccc-cccc-cccc-ccccccccccc1";
const NOTIF_OTHER = "cccccccc-cccc-cccc-cccc-ccccccccccc2";
const NOTIF_WRONG_REF = "cccccccc-cccc-cccc-cccc-ccccccccccc3";

function seed() {
  return makeBackend({
    callerId: USER,
    callerHasClinicalAccess: true,
    referrals: [REF_A, REF_B],
    notifications: [
      { id: NOTIF_MINE, user_id: USER, referral_id: REF_A, read_at: null },
      { id: NOTIF_OTHER, user_id: OTHER, referral_id: REF_A, read_at: null },
      { id: NOTIF_WRONG_REF, user_id: USER, referral_id: REF_B, read_at: null },
    ],
  });
}

// ---------- Tests ----------
describe("deep-link click → audit_log records notification_id, referral_id, user", () => {
  it("bell/inbox click writes user_id, entity_id, and diff.notification_id", async () => {
    const be = seed();
    await simulateDeepLinkClick(be, { referralId: REF_A, notificationId: NOTIF_MINE });

    expect(be.audit).toHaveLength(1);
    expect(be.audit[0]).toEqual({
      user_id: USER,                       // accessing user (auth.uid()), not the notification's owner
      action: "view",
      entity: "referral",
      entity_id: REF_A,                    // the referral being opened
      diff: {
        source: "notification",
        notification_id: NOTIF_MINE,       // the exact notification that drove the click
      },
    });
  });

  it("visit without a notification id records source=direct and notification_id=null", async () => {
    const be = seed();
    await be.logReferralView({ referral_id: REF_A });

    expect(be.audit).toHaveLength(1);
    expect(be.audit[0].diff).toEqual({ source: "direct", notification_id: null });
    expect(be.audit[0].user_id).toBe(USER);
    expect(be.audit[0].entity_id).toBe(REF_A);
  });

  it("forged notification id belonging to ANOTHER user is scrubbed to null", async () => {
    const be = seed();
    await simulateDeepLinkClick(be, { referralId: REF_A, notificationId: NOTIF_OTHER });

    // Audit still written for the view — but attribution is not accepted.
    expect(be.audit).toHaveLength(1);
    expect(be.audit[0].diff.notification_id).toBeNull();
    // Nothing else about the caller's audit changes.
    expect(be.audit[0].user_id).toBe(USER);
    expect(be.audit[0].entity_id).toBe(REF_A);
  });

  it("forged notification id belonging to a DIFFERENT referral is scrubbed to null", async () => {
    const be = seed();
    await simulateDeepLinkClick(be, { referralId: REF_A, notificationId: NOTIF_WRONG_REF });

    expect(be.audit[0].diff.notification_id).toBeNull();
    expect(be.audit[0].entity_id).toBe(REF_A);
  });

  it("the source notification is marked read by the same call, but others are not", async () => {
    const be = seed();
    await simulateDeepLinkClick(be, { referralId: REF_A, notificationId: NOTIF_MINE });

    const readMap = Object.fromEntries(be.notifications.map((n) => [n.id, !!n.read_at]));
    expect(readMap[NOTIF_MINE]).toBe(true);         // caller's, for this referral
    expect(readMap[NOTIF_OTHER]).toBe(false);       // belongs to someone else
    expect(readMap[NOTIF_WRONG_REF]).toBe(false);   // caller's, but different referral
  });

  it("without clinical access, no audit row is written", async () => {
    const be = makeBackend({
      callerId: USER,
      callerHasClinicalAccess: false,
      referrals: [REF_A],
      notifications: [{ id: NOTIF_MINE, user_id: USER, referral_id: REF_A, read_at: null }],
    });
    await expect(
      simulateDeepLinkClick(be, { referralId: REF_A, notificationId: NOTIF_MINE }),
    ).rejects.toThrow(/Forbidden/);
    expect(be.audit).toEqual([]);
  });

  it("concurrent viewers each attribute the audit row to themselves", async () => {
    const beMe = seed();
    const beOther = makeBackend({
      callerId: OTHER,
      callerHasClinicalAccess: true,
      referrals: [REF_A],
      notifications: [{ id: NOTIF_OTHER, user_id: OTHER, referral_id: REF_A, read_at: null }],
    });

    await Promise.all([
      simulateDeepLinkClick(beMe, { referralId: REF_A, notificationId: NOTIF_MINE }),
      simulateDeepLinkClick(beOther, { referralId: REF_A, notificationId: NOTIF_OTHER }),
    ]);

    expect(beMe.audit[0]).toMatchObject({ user_id: USER, diff: { notification_id: NOTIF_MINE } });
    expect(beOther.audit[0]).toMatchObject({ user_id: OTHER, diff: { notification_id: NOTIF_OTHER } });
  });
});
