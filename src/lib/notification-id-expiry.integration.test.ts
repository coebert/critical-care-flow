import { describe, it, expect } from "vitest";
import { NOTIFICATION_DEEP_LINK_TTL_MS } from "./referrals.functions";

/**
 * Verification: an unread, unused notification_id still expires after
 * NOTIFICATION_DEEP_LINK_TTL_MS from its created_at. After that window,
 * logReferralView scrubs the id to null (source falls back to "direct"),
 * so a stale link from an old email/push payload cannot be replayed to
 * attribute a view.
 *
 * Mirrors the server-side branch in src/lib/referrals.functions.ts ::
 * logReferralView.
 */

type Notif = { id: string; user_id: string; referral_id: string; read_at: string | null; created_at: string };
type Audit = { user_id: string; entity_id: string; notification_id: string | null };

function makeBackend(now: number, notifs: Notif[]) {
  const audit: Audit[] = [];
  async function logReferralView(input: {
    referral_id: string;
    notification_id?: string;
    userId: string;
  }) {
    let verified: string | null = null;
    if (input.notification_id) {
      const n = notifs.find(
        (x) =>
          x.id === input.notification_id &&
          x.user_id === input.userId &&
          x.referral_id === input.referral_id,
      );
      const withinTtl =
        !!n && now - new Date(n.created_at).getTime() <= NOTIFICATION_DEEP_LINK_TTL_MS;
      if (n && n.read_at === null && withinTtl) {
        const prior = audit.find(
          (a) => a.user_id === input.userId && a.notification_id === input.notification_id,
        );
        if (!prior) verified = n.id;
      }
    }
    audit.push({ user_id: input.userId, entity_id: input.referral_id, notification_id: verified });
  }
  return { audit, logReferralView };
}

const USER = "11111111-1111-1111-1111-111111111111";
const REF = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01";
const NID = "cccccccc-cccc-cccc-cccc-ccccccccccc1";

describe("notification_id expiry (deep-link TTL)", () => {
  it("TTL is 7 days", () => {
    expect(NOTIFICATION_DEEP_LINK_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("fresh notification (well within TTL) still attributes", async () => {
    const now = Date.now();
    const be = makeBackend(now, [
      { id: NID, user_id: USER, referral_id: REF, read_at: null, created_at: new Date(now - 60_000).toISOString() },
    ]);
    await be.logReferralView({ referral_id: REF, notification_id: NID, userId: USER });
    expect(be.audit[0].notification_id).toBe(NID);
  });

  it("just inside TTL (last second) still attributes", async () => {
    const now = Date.now();
    const be = makeBackend(now, [
      {
        id: NID,
        user_id: USER,
        referral_id: REF,
        read_at: null,
        created_at: new Date(now - NOTIFICATION_DEEP_LINK_TTL_MS + 1_000).toISOString(),
      },
    ]);
    await be.logReferralView({ referral_id: REF, notification_id: NID, userId: USER });
    expect(be.audit[0].notification_id).toBe(NID);
  });

  it("exactly at TTL boundary is accepted (<= comparison)", async () => {
    const now = Date.now();
    const be = makeBackend(now, [
      {
        id: NID,
        user_id: USER,
        referral_id: REF,
        read_at: null,
        created_at: new Date(now - NOTIFICATION_DEEP_LINK_TTL_MS).toISOString(),
      },
    ]);
    await be.logReferralView({ referral_id: REF, notification_id: NID, userId: USER });
    expect(be.audit[0].notification_id).toBe(NID);
  });

  it("one second past TTL is scrubbed to null", async () => {
    const now = Date.now();
    const be = makeBackend(now, [
      {
        id: NID,
        user_id: USER,
        referral_id: REF,
        read_at: null,
        created_at: new Date(now - NOTIFICATION_DEEP_LINK_TTL_MS - 1_000).toISOString(),
      },
    ]);
    await be.logReferralView({ referral_id: REF, notification_id: NID, userId: USER });
    // View is still audited; the deep-link attribution is dropped.
    expect(be.audit).toHaveLength(1);
    expect(be.audit[0].entity_id).toBe(REF);
    expect(be.audit[0].notification_id).toBeNull();
  });

  it("weeks-old notification (e.g. 30 days) is scrubbed", async () => {
    const now = Date.now();
    const be = makeBackend(now, [
      {
        id: NID,
        user_id: USER,
        referral_id: REF,
        read_at: null,
        created_at: new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(),
      },
    ]);
    await be.logReferralView({ referral_id: REF, notification_id: NID, userId: USER });
    expect(be.audit[0].notification_id).toBeNull();
  });

  it("expiry is independent of unread/single-use — an expired id cannot be used even if pristine", async () => {
    const now = Date.now();
    const be = makeBackend(now, [
      {
        id: NID,
        user_id: USER,
        referral_id: REF,
        read_at: null, // unread
        created_at: new Date(now - NOTIFICATION_DEEP_LINK_TTL_MS - 60_000).toISOString(),
      },
    ]);
    // Nothing in audit_log yet — still expired.
    await be.logReferralView({ referral_id: REF, notification_id: NID, userId: USER });
    expect(be.audit[0].notification_id).toBeNull();
  });
});
