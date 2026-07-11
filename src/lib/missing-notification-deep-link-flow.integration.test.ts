import { describe, it, expect, vi } from "vitest";

/**
 * End-to-end flow verification for a notification deep link that arrives
 * without a usable notification_id (e.g. a malformed `/referrals/:id?n=` link
 * or a notification link whose id was stripped before the browser opened it).
 *
 * When the `n` search parameter is present but empty, three things must
 * happen:
 *
 *   1. The referral view still opens — the clinician is never blocked.
 *   2. The same generic error toast used for invalid/forged ids is surfaced
 *      so the missing attribution is not silently swallowed.
 *   3. The audit_log entry for the view records source = "direct" and
 *      notification_id = null, so a malformed link can never write a bogus
 *      notification id into the audit trail.
 *
 * Mirrors the empty/missing notification_id handling in
 * src/routes/_authenticated/referrals.$id.tsx and the underlying
 * logReferralView server function in src/lib/referrals.functions.ts.
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
    let notificationStatus: "attributed" | "expired" | "reused" | "read" | "invalid" | "none" =
      "none";

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
          opts.now - new Date(n.created_at).getTime() <= 7 * 24 * 60 * 60 * 1000;
        if (n.read_at !== null) {
          notificationStatus = "read";
        } else if (!withinTtl) {
          notificationStatus = "expired";
        } else {
          const prior = audit.find(
            (a) => a.user_id === input.userId && a.diff.notification_id === input.notification_id,
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
  // The route only shows notification-related UI feedback when the `n` search
  // parameter is present. An empty/missing id is treated as an invalid
  // notification link (same toast as a forged or unknown id).
  if (args.notification_id !== undefined) {
    if (res.notificationStatus === "expired") {
      args.toast.warning("This notification link has expired.");
    } else if (res.notificationStatus === "reused") {
      args.toast.info("This notification link has already been used.");
    } else if (res.notificationStatus === "read") {
      args.toast.info("This notification has already been read.");
    } else if (res.notificationStatus === "invalid") {
      args.toast.error("This notification link isn't valid for this referral.");
    } else if (res.notificationStatus === "none") {
      args.toast.error("This notification link isn't valid for this referral.");
    }
  }
  await args.loadRef();
  return res;
}

const USER = "11111111-1111-1111-1111-111111111111";
const REF = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01";

const INVALID_TOAST = "This notification link isn't valid for this referral.";

describe("missing notification deep-link flow", () => {
  it("opens the referral, shows the invalid error toast, and writes notification_id=null to audit_log", async () => {
    const handler = makeHandler({
      now: Date.now(),
      referralExists: true,
      notifs: [
        {
          id: "cccccccc-cccc-cccc-cccc-ccccccccccc1",
          user_id: USER,
          referral_id: REF,
          read_at: null,
          expired_at: null,
          created_at: new Date(Date.now() - 60_000).toISOString(),
        },
      ],
    });
    const toast = { warning: vi.fn(), info: vi.fn(), error: vi.fn() };
    const loadRef = vi.fn(async () => {});

    const res = await runDeepLinkOpen({
      handler,
      referral_id: REF,
      // Empty/missing notification id — the deep link has the `n` parameter
      // but no value, or the value was stripped before the route saw it.
      notification_id: "",
      userId: USER,
      toast,
      loadRef,
    });

    // 1. Referral opened (view returned ok and the route loaded the data).
    expect(res.ok).toBe(true);
    expect(loadRef).toHaveBeenCalledTimes(1);

    // 2. The missing id is surfaced as an invalid link, using the same
    //    generic error toast as forged / unknown ids.
    expect(res.notificationStatus).toBe("none");
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(INVALID_TOAST);
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();

    // 3. The view is still logged, but the notification id is scrubbed to
    //    null and the source falls back to "direct".
    expect(handler.audit).toHaveLength(1);
    expect(handler.audit[0]).toMatchObject({
      user_id: USER,
      action: "view",
      entity: "referral",
      entity_id: REF,
      diff: { source: "direct", notification_id: null },
    });
  });
});
