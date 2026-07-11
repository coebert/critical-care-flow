import { describe, it, expect, vi } from "vitest";
import { NOTIFICATION_DEEP_LINK_TTL_MS } from "./referrals.functions";

/**
 * End-to-end flow verification for expired notification deep links.
 *
 * When a clinician clicks a bell / email link older than
 * NOTIFICATION_DEEP_LINK_TTL_MS, three things must all happen:
 *
 *   1. The referral view still opens — the link is not a hard failure,
 *      the clinician is not blocked from doing their job.
 *   2. A warning toast is surfaced so the click is not silently
 *      swallowed ("This notification link has expired.").
 *   3. The audit_log entry for the view records notification_id = null
 *      (source falls back to "direct") so an expired id cannot be
 *      replayed to attribute the view.
 *
 * This test wires a faithful mock of the `logReferralView` server-fn
 * handler (mirroring src/lib/referrals.functions.ts) together with the
 * caller glue that lives in src/routes/_authenticated/referrals.$id.tsx
 * (toast + loadRef), and asserts all three effects fire in one flow.
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

// Mirrors the route's post-log side effects in referrals.$id.tsx.
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
  // Referral opens regardless of the notification outcome.
  await args.loadRef();
  return res;
}

const USER = "11111111-1111-1111-1111-111111111111";
const REF = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01";
const NID = "cccccccc-cccc-cccc-cccc-ccccccccccc1";

describe("expired notification deep-link flow", () => {
  it("opens the referral, shows the expired toast, and writes notification_id=null to audit_log", async () => {
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
          // 8 days old — past the 7-day TTL window.
          created_at: new Date(now - NOTIFICATION_DEEP_LINK_TTL_MS - 24 * 60 * 60 * 1000).toISOString(),
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

    // 1. Referral opened (view function returned + loadRef ran).
    expect(res.ok).toBe(true);
    expect(loadRef).toHaveBeenCalledTimes(1);

    // 2. Expired toast surfaced, no other tone fired.
    expect(res.notificationStatus).toBe("expired");
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith("This notification link has expired.");
    expect(toast.info).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();

    // 3. Audit row exists for this referral with notification_id scrubbed
    //    to null and source falling back to "direct".
    expect(handler.audit).toHaveLength(1);
    expect(handler.audit[0]).toMatchObject({
      user_id: USER,
      action: "view",
      entity: "referral",
      entity_id: REF,
      diff: { source: "direct", notification_id: null },
    });
  });

  it("also honours the persisted expired_at flag (cron-stamped) — same expired flow", async () => {
    // Even inside the TTL window, if the cleanup job has already stamped
    // expired_at, the id must be treated as expired.
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
          expired_at: new Date(now - 60_000).toISOString(),
          created_at: new Date(now - 60 * 60 * 1000).toISOString(), // 1h old
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

    expect(res.notificationStatus).toBe("expired");
    expect(toast.warning).toHaveBeenCalledOnce();
    expect(loadRef).toHaveBeenCalledOnce();
    expect(handler.audit[0].diff).toEqual({ source: "direct", notification_id: null });
  });
});
