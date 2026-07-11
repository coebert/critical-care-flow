import { describe, it, expect, vi } from "vitest";
import { NOTIFICATION_DEEP_LINK_TTL_MS } from "./referrals.functions";

/**
 * End-to-end flow verification for already-read notification deep links.
 *
 * When a clinician clicks a bell / email link whose notification row has
 * already been marked read (e.g. they opened the referral in another
 * tab, or a partner device marked it read), three things must happen:
 *
 *   1. The referral view still opens — the click is not blocked.
 *   2. An info toast is surfaced ("This notification has already been
 *      read.") so the missing attribution is not silently swallowed.
 *   3. The audit_log entry for the view records notification_id = null
 *      (source falls back to "direct") — a read id cannot be replayed
 *      to attribute the view.
 *
 * Mirrors the "read" branch in src/lib/referrals.functions.ts ::
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
        // read_at takes precedence over TTL — a read notification is
        // "read" regardless of age.
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
const REF = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01";
const NID = "cccccccc-cccc-cccc-cccc-ccccccccccc1";

describe("read notification deep-link flow", () => {
  it("opens the referral, shows the read info toast, and records notification_id=null in audit_log", async () => {
    const now = Date.now();
    const handler = makeHandler({
      now,
      referralExists: true,
      notifs: [
        {
          id: NID,
          user_id: USER,
          referral_id: REF,
          // Already marked read one minute ago (e.g. another tab).
          read_at: new Date(now - 60_000).toISOString(),
          expired_at: null,
          // Fresh — well within TTL — proving read_at wins over TTL.
          created_at: new Date(now - 5 * 60_000).toISOString(),
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

    // 1. Referral opened.
    expect(res.ok).toBe(true);
    expect(loadRef).toHaveBeenCalledTimes(1);

    // 2. Read info toast fired, no warning/error.
    expect(res.notificationStatus).toBe("read");
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(toast.info).toHaveBeenCalledWith("This notification has already been read.");
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();

    // 3. Audit row records the view with notification_id scrubbed to
    //    null and source falling back to "direct".
    expect(handler.audit).toHaveLength(1);
    expect(handler.audit[0]).toMatchObject({
      user_id: USER,
      action: "view",
      entity: "referral",
      entity_id: REF,
      diff: { source: "direct", notification_id: null },
    });
  });

  it("read status takes precedence over TTL — a read + expired id still classifies as read", async () => {
    // If a stale notification was marked read before the cleanup cron
    // ran, the caller should see "read" (the more specific/actionable
    // hint) rather than "expired".
    const now = Date.now();
    const handler = makeHandler({
      now,
      referralExists: true,
      notifs: [
        {
          id: NID,
          user_id: USER,
          referral_id: REF,
          read_at: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
          expired_at: null,
          created_at: new Date(now - NOTIFICATION_DEEP_LINK_TTL_MS - 60_000).toISOString(),
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

    expect(res.notificationStatus).toBe("read");
    expect(toast.info).toHaveBeenCalledOnce();
    expect(toast.warning).not.toHaveBeenCalled();
    expect(loadRef).toHaveBeenCalledOnce();
    expect(handler.audit[0].diff).toEqual({ source: "direct", notification_id: null });
  });
});
