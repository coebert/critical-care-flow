import { describe, it, expect, vi } from "vitest";
import { NOTIFICATION_DEEP_LINK_TTL_MS } from "./referrals.functions";

/**
 * End-to-end flow verification for invalid / unknown notification_ids.
 *
 * A caller may hit /referrals/:id?n=<x> with an id that:
 *   a) doesn't exist in the notifications table at all (forged / typo),
 *   b) exists but belongs to a different user (shared URL, stolen id), or
 *   c) exists for this user but references a different referral
 *      (id ↔ referral mismatch).
 *
 * All three cases must be indistinguishable from the client's point of
 * view — we deliberately never leak which specific check failed — and
 * must:
 *   1. Still open the referral view.
 *   2. Surface a generic error toast ("This notification link isn't
 *      valid for this referral.").
 *   3. Write the audit_log view row with notification_id = null and
 *      source = "direct" so a forged id can never appear in the
 *      audit trail.
 *
 * Mirrors the "invalid" branch in src/lib/referrals.functions.ts ::
 * logReferralView and the caller glue in
 * src/routes/_authenticated/referrals.$id.tsx.
 */

type Notif = {
  id: string;
  user_id: string;
  referral_id: string;
  read_at: string | null;
  expired_at: string | null;
  created_at: string;
};
type Audit = {
  user_id: string;
  action: string;
  entity: string;
  entity_id: string;
  diff: { source: string; notification_id: string | null };
};

function makeHandler(opts: { now: number; notifs: Notif[]; referralExists: boolean }) {
  const audit: Audit[] = [];
  async function logReferralView(input: {
    referral_id: string;
    notification_id?: string;
    userId: string;
  }) {
    if (!opts.referralExists) throw new Error("Referral not found");

    let verifiedNotificationId: string | null = null;
    let notificationStatus:
      | "attributed"
      | "expired"
      | "reused"
      | "read"
      | "invalid"
      | "none" = "none";

    if (input.notification_id) {
      notificationStatus = "invalid";
      const n = opts.notifs.find(
        (x) =>
          x.id === input.notification_id &&
          x.user_id === input.userId &&
          x.referral_id === input.referral_id,
      );
      if (n) {
        const withinTtl =
          n.expired_at === null &&
          opts.now - new Date(n.created_at).getTime() <= NOTIFICATION_DEEP_LINK_TTL_MS;
        if (n.read_at !== null) {
          notificationStatus = "read";
        } else if (!withinTtl) {
          notificationStatus = "expired";
        } else {
          const prior = audit.find(
            (a) =>
              a.user_id === input.userId &&
              a.diff.notification_id === input.notification_id,
          );
          if (prior) {
            notificationStatus = "reused";
          } else {
            verifiedNotificationId = n.id;
            notificationStatus = "attributed";
          }
        }
      }
    }

    const source = verifiedNotificationId ? "notification" : "direct";
    audit.push({
      user_id: input.userId,
      action: "view",
      entity: "referral",
      entity_id: input.referral_id,
      diff: { source, notification_id: verifiedNotificationId },
    });
    return { ok: true as const, notificationStatus };
  }
  return { audit, logReferralView };
}

async function runDeepLinkOpen(args: {
  handler: ReturnType<typeof makeHandler>;
  referral_id: string;
  notification_id?: string;
  userId: string;
  toast: { warning: (m: string) => void; info: (m: string) => void; error: (m: string) => void };
  loadRef: () => Promise<void>;
}) {
  const res = await args.handler.logReferralView({
    referral_id: args.referral_id,
    notification_id: args.notification_id,
    userId: args.userId,
  });
  if (args.notification_id) {
    if (res.notificationStatus === "expired") {
      args.toast.warning("This notification link has expired.");
    } else if (res.notificationStatus === "reused") {
      args.toast.info("This notification link has already been used.");
    } else if (res.notificationStatus === "read") {
      args.toast.info("This notification has already been read.");
    } else if (res.notificationStatus === "invalid") {
      args.toast.error("This notification link isn't valid for this referral.");
    }
  }
  await args.loadRef();
  return res;
}

const USER = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const REF = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01";
const OTHER_REF = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa02";
const NID = "cccccccc-cccc-cccc-cccc-ccccccccccc1";
const UNKNOWN_NID = "dddddddd-dddd-dddd-dddd-ddddddddddd9";

const INVALID_TOAST = "This notification link isn't valid for this referral.";

describe("invalid notification deep-link flow", () => {
  it("unknown notification_id (no matching row) opens the referral, errors, and audit is null", async () => {
    const now = Date.now();
    const handler = makeHandler({ now, referralExists: true, notifs: [] });
    const toast = { warning: vi.fn(), info: vi.fn(), error: vi.fn() };
    const loadRef = vi.fn(async () => {});

    const res = await runDeepLinkOpen({
      handler,
      referral_id: REF,
      notification_id: UNKNOWN_NID,
      userId: USER,
      toast,
      loadRef,
    });

    expect(res.ok).toBe(true);
    expect(loadRef).toHaveBeenCalledTimes(1);
    expect(res.notificationStatus).toBe("invalid");
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(INVALID_TOAST);
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
    expect(handler.audit).toHaveLength(1);
    expect(handler.audit[0]).toMatchObject({
      user_id: USER,
      action: "view",
      entity: "referral",
      entity_id: REF,
      diff: { source: "direct", notification_id: null },
    });
  });

  it("notification belongs to a different user (forged / shared URL) is invalid", async () => {
    const now = Date.now();
    const handler = makeHandler({
      now,
      referralExists: true,
      notifs: [
        {
          id: NID,
          user_id: OTHER, // not the caller
          referral_id: REF,
          read_at: null,
          expired_at: null,
          created_at: new Date(now - 60_000).toISOString(),
        },
      ],
    });
    const toast = { warning: vi.fn(), info: vi.fn(), error: vi.fn() };
    const loadRef = vi.fn(async () => {});

    const res = await runDeepLinkOpen({
      handler,
      referral_id: REF,
      notification_id: NID,
      userId: USER,
      toast,
      loadRef,
    });

    expect(res.notificationStatus).toBe("invalid");
    expect(toast.error).toHaveBeenCalledWith(INVALID_TOAST);
    expect(loadRef).toHaveBeenCalledOnce();
    expect(handler.audit[0].diff).toEqual({ source: "direct", notification_id: null });
    // Forged id must never appear in the audit trail.
    expect(handler.audit.some((a) => a.diff.notification_id === NID)).toBe(false);
  });

  it("notification exists for this user but references a different referral is invalid", async () => {
    const now = Date.now();
    const handler = makeHandler({
      now,
      referralExists: true,
      notifs: [
        {
          id: NID,
          user_id: USER,
          referral_id: OTHER_REF, // notification is for a different referral
          read_at: null,
          expired_at: null,
          created_at: new Date(now - 60_000).toISOString(),
        },
      ],
    });
    const toast = { warning: vi.fn(), info: vi.fn(), error: vi.fn() };
    const loadRef = vi.fn(async () => {});

    const res = await runDeepLinkOpen({
      handler,
      referral_id: REF, // clicking against REF, not OTHER_REF
      notification_id: NID,
      userId: USER,
      toast,
      loadRef,
    });

    expect(res.notificationStatus).toBe("invalid");
    expect(toast.error).toHaveBeenCalledWith(INVALID_TOAST);
    expect(handler.audit[0]).toMatchObject({
      entity_id: REF,
      diff: { source: "direct", notification_id: null },
    });
    expect(handler.audit.some((a) => a.diff.notification_id === NID)).toBe(false);
  });

  it("all three invalid variants produce indistinguishable outward behaviour", async () => {
    // The three failure modes must not be distinguishable client-side —
    // status, toast, and audit shape are identical. This prevents an
    // attacker from probing "does this notification_id exist?" via
    // differential responses.
    const now = Date.now();
    const cases: Array<{ notifs: Notif[]; label: string }> = [
      { label: "unknown", notifs: [] },
      {
        label: "wrong user",
        notifs: [{
          id: NID, user_id: OTHER, referral_id: REF,
          read_at: null, expired_at: null,
          created_at: new Date(now - 60_000).toISOString(),
        }],
      },
      {
        label: "wrong referral",
        notifs: [{
          id: NID, user_id: USER, referral_id: OTHER_REF,
          read_at: null, expired_at: null,
          created_at: new Date(now - 60_000).toISOString(),
        }],
      },
    ];

    const results = await Promise.all(
      cases.map(async (c) => {
        const handler = makeHandler({ now, referralExists: true, notifs: c.notifs });
        const toast = { warning: vi.fn(), info: vi.fn(), error: vi.fn() };
        const loadRef = vi.fn(async () => {});
        const res = await runDeepLinkOpen({
          handler,
          referral_id: REF,
          notification_id: c.label === "unknown" ? UNKNOWN_NID : NID,
          userId: USER,
          toast,
          loadRef,
        });
        return {
          status: res.notificationStatus,
          errorCalled: toast.error.mock.calls.length,
          errorMsg: toast.error.mock.calls[0]?.[0],
          warningCalled: toast.warning.mock.calls.length,
          infoCalled: toast.info.mock.calls.length,
          auditDiff: handler.audit[0].diff,
        };
      }),
    );

    // Every case is identical along every observable axis.
    const [first, ...rest] = results;
    for (const r of rest) expect(r).toEqual(first);
    expect(first).toEqual({
      status: "invalid",
      errorCalled: 1,
      errorMsg: INVALID_TOAST,
      warningCalled: 0,
      infoCalled: 0,
      auditDiff: { source: "direct", notification_id: null },
    });
  });
});
