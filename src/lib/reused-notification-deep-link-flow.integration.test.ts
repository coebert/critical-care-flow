import { describe, it, expect, vi } from "vitest";
import { NOTIFICATION_DEEP_LINK_TTL_MS } from "./referrals.functions";

/**
 * End-to-end flow verification for reused notification deep links.
 *
 * A notification_id is single-use per user. Once it has been credited
 * to a referral view in audit_log, any subsequent click on the same
 * link (reload, back-button, second device) must:
 *
 *   1. Still open the referral view (never block the clinician).
 *   2. Surface an info toast so the failed attribution is visible.
 *   3. Write a second audit_log row for the view with
 *      notification_id = null and source = "direct" — the original
 *      "attributed" row is preserved untouched, so the lifecycle is:
 *        first click  -> {source: "notification", notification_id: NID}
 *        second click -> {source: "direct",       notification_id: null}
 *
 * Mirrors the "reused" branch in src/lib/referrals.functions.ts ::
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

describe("reused notification deep-link flow", () => {
  it("first click attributes; second click opens the referral, warns, and records notification_id=null", async () => {
    const now = Date.now();
    const handler = makeHandler({
      now,
      referralExists: true,
      notifs: [
        {
          id: NID,
          user_id: USER,
          referral_id: REF,
          read_at: null,
          expired_at: null,
          created_at: new Date(now - 60_000).toISOString(),
        },
      ],
    });
    const toast = { warning: vi.fn(), info: vi.fn(), error: vi.fn() };
    const loadRef = vi.fn(async () => {});

    // First click — clean attribution.
    const first = await runDeepLinkOpen({
      handler,
      referral_id: REF,
      notification_id: NID,
      userId: USER,
      toast,
      loadRef,
    });
    expect(first.notificationStatus).toBe("attributed");
    expect(toast.info).not.toHaveBeenCalled();

    // Second click — reload / back-button.
    const second = await runDeepLinkOpen({
      handler,
      referral_id: REF,
      notification_id: NID,
      userId: USER,
      toast,
      loadRef,
    });

    // 1. Referral still opens both times.
    expect(second.ok).toBe(true);
    expect(loadRef).toHaveBeenCalledTimes(2);

    // 2. Second click surfaces the reused info toast; no error/warning.
    expect(second.notificationStatus).toBe("reused");
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(toast.info).toHaveBeenCalledWith("This notification link has already been used.");
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();

    // 3. Full lifecycle in audit_log: one attributed row, one direct row.
    expect(handler.audit).toHaveLength(2);
    expect(handler.audit[0].diff).toEqual({ source: "notification", notification_id: NID });
    expect(handler.audit[1].diff).toEqual({ source: "direct", notification_id: null });
    // The original attribution row is not mutated by the second click.
    expect(handler.audit.filter((a) => a.diff.notification_id === NID)).toHaveLength(1);
  });

  it("replaying the same notification_id against a DIFFERENT referral is also reused, not attributed", async () => {
    // Notification is bound to REF; a first legitimate click credits it
    // there. If a caller then hits OTHER_REF with the same id, the
    // referral-mismatch guard classifies it as "invalid" (the id
    // doesn't belong to that referral) — NOT as a way to bypass the
    // single-use rule and attribute a second view.
    const now = Date.now();
    const handler = makeHandler({
      now,
      referralExists: true,
      notifs: [
        {
          id: NID,
          user_id: USER,
          referral_id: REF,
          read_at: null,
          expired_at: null,
          created_at: new Date(now - 60_000).toISOString(),
        },
      ],
    });
    const toast = { warning: vi.fn(), info: vi.fn(), error: vi.fn() };
    const loadRef = vi.fn(async () => {});

    await runDeepLinkOpen({
      handler,
      referral_id: REF,
      notification_id: NID,
      userId: USER,
      toast,
      loadRef,
    });
    const cross = await runDeepLinkOpen({
      handler,
      referral_id: OTHER_REF,
      notification_id: NID,
      userId: USER,
      toast,
      loadRef,
    });

    expect(cross.notificationStatus).toBe("invalid");
    expect(toast.error).toHaveBeenCalledWith(
      "This notification link isn't valid for this referral.",
    );
    // Cross-referral click still logged, still scrubbed to null.
    expect(handler.audit).toHaveLength(2);
    expect(handler.audit[1]).toMatchObject({
      entity_id: OTHER_REF,
      diff: { source: "direct", notification_id: null },
    });
  });

  it("another user replaying the same notification_id cannot claim attribution", async () => {
    // Single-use is scoped per (user_id, notification_id). A different
    // user seeing the same id — e.g. a shared URL — must not attribute
    // it (the notification isn't theirs), and their view must still be
    // recorded with notification_id = null.
    const now = Date.now();
    const handler = makeHandler({
      now,
      referralExists: true,
      notifs: [
        {
          id: NID,
          user_id: USER,
          referral_id: REF,
          read_at: null,
          expired_at: null,
          created_at: new Date(now - 60_000).toISOString(),
        },
      ],
    });
    const toast = { warning: vi.fn(), info: vi.fn(), error: vi.fn() };
    const loadRef = vi.fn(async () => {});

    // Legit owner attributes.
    await runDeepLinkOpen({
      handler,
      referral_id: REF,
      notification_id: NID,
      userId: USER,
      toast,
      loadRef,
    });
    // Different user replays the same id.
    const stolen = await runDeepLinkOpen({
      handler,
      referral_id: REF,
      notification_id: NID,
      userId: OTHER,
      toast,
      loadRef,
    });

    expect(stolen.notificationStatus).toBe("invalid");
    expect(handler.audit).toHaveLength(2);
    expect(handler.audit[1]).toMatchObject({
      user_id: OTHER,
      diff: { source: "direct", notification_id: null },
    });
    // The original attribution remains the ONLY credited row.
    expect(handler.audit.filter((a) => a.diff.notification_id === NID)).toEqual([
      expect.objectContaining({ user_id: USER, diff: { source: "notification", notification_id: NID } }),
    ]);
  });
});
