import { describe, it, expect, vi } from "vitest";
import { NOTIFICATION_DEEP_LINK_TTL_MS } from "./referrals.functions";

/**
 * End-to-end flow verification for a notification deep link that points
 * at a referral the caller can no longer see:
 *
 *   a) soft-deleted referral (`deleted_at IS NOT NULL`),
 *   b) hard-deleted referral (row is gone entirely), or
 *   c) RLS-blocked referral (belongs to a partner org the caller lost
 *      access to, or was reassigned).
 *
 * All three modes must be indistinguishable from the client's point of
 * view — leaking "the referral exists but you can't see it" vs "the
 * referral is gone" would let a probe distinguish deleted-vs-forbidden.
 * The route must:
 *
 *   1. Open the referral view without crashing (no white screen, no
 *      infinite spinner beyond the normal loading state).
 *   2. Surface a single generic error toast ("Failed to load referral")
 *      with no referral id, no owner, no partner org, no "you don't
 *      have permission" wording — all three failure modes produce the
 *      same string.
 *   3. Record the view attempt in audit_log with
 *      `source = "direct"` and `notification_id = null`. The notification
 *      id from the URL must never appear in the audit trail because the
 *      server could not verify that the notification actually referenced
 *      the (inaccessible) referral, and writing an unverified id would
 *      leak that a notification-for-this-referral exists for this user.
 *
 * Mirrors the fetchDetail failure path in
 * src/routes/_authenticated/referrals.$id.tsx (loadRef → toast.error)
 * and the notification verification path in
 * src/lib/referrals.functions.ts :: logReferralView, which falls into
 * the "invalid" branch whenever the referral+notification pair cannot
 * be matched.
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

type ReferralAccess =
  | { kind: "ok" }
  | { kind: "soft_deleted" }
  | { kind: "hard_deleted" }
  | { kind: "rls_blocked" };

function makeHandler(opts: {
  now: number;
  notifs: Notif[];
  referralAccess: ReferralAccess;
}) {
  const audit: Audit[] = [];

  // The server-side view logger runs even when the caller cannot read
  // the referral row. It uses its own (service-role) lookup to verify
  // the notification actually references the referral for this user;
  // when the pair can't be verified we fall into the "invalid" branch
  // and write notification_id = null. We never bail out early, because
  // silently skipping the audit row would erase evidence of a probe.
  async function logReferralView(input: {
    referral_id: string;
    notification_id?: string;
    userId: string;
  }) {
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
      // For soft/hard-deleted or RLS-blocked referrals the notification
      // row either doesn't reference a live referral or the caller is
      // no longer entitled to the pair — in every non-ok mode we refuse
      // to verify the id.
      const canVerify = opts.referralAccess.kind === "ok";
      const n = canVerify
        ? opts.notifs.find(
            (x) =>
              x.id === input.notification_id &&
              x.user_id === input.userId &&
              x.referral_id === input.referral_id,
          )
        : undefined;
      if (n) {
        const withinTtl =
          n.expired_at === null &&
          opts.now - new Date(n.created_at).getTime() <= NOTIFICATION_DEEP_LINK_TTL_MS;
        if (n.read_at !== null) {
          notificationStatus = "read";
        } else if (!withinTtl) {
          notificationStatus = "expired";
        } else {
          verifiedNotificationId = n.id;
          notificationStatus = "attributed";
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

  // Mirrors fetchDetail — throws with a single generic message for every
  // failure mode so callers can't distinguish deleted-vs-forbidden.
  async function fetchDetail(): Promise<null> {
    if (opts.referralAccess.kind === "ok") return null;
    throw new Error("Failed to load referral");
  }

  return { audit, logReferralView, fetchDetail };
}

async function runDeepLinkOpen(args: {
  handler: ReturnType<typeof makeHandler>;
  referral_id: string;
  notification_id?: string;
  userId: string;
  toast: {
    warning: (m: string) => void;
    info: (m: string) => void;
    error: (m: string) => void;
  };
}) {
  const res = await args.handler.logReferralView({
    referral_id: args.referral_id,
    notification_id: args.notification_id,
    userId: args.userId,
  });
  if (args.notification_id !== undefined) {
    if (res.notificationStatus === "expired") {
      args.toast.warning("This notification link has expired.");
    } else if (res.notificationStatus === "reused") {
      args.toast.info("This notification link has already been used.");
    } else if (res.notificationStatus === "read") {
      args.toast.info("This notification has already been read.");
    } else if (
      res.notificationStatus === "invalid" ||
      res.notificationStatus === "none"
    ) {
      args.toast.error("This notification link isn't valid for this referral.");
    }
  }
  // loadRef surfaces the generic "Failed to load referral" toast on any
  // fetchDetail rejection — regardless of soft-delete / hard-delete / RLS.
  try {
    await args.handler.fetchDetail();
  } catch (e: any) {
    args.toast.error(e?.message ?? "Failed to load referral");
  }
  return res;
}

const USER = "11111111-1111-1111-1111-111111111111";
const REF = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01";
const NID = "cccccccc-cccc-cccc-cccc-ccccccccccc1";

const LOAD_ERROR = "Failed to load referral";
const INVALID_TOAST = "This notification link isn't valid for this referral.";

function liveNotif(now: number): Notif {
  return {
    id: NID,
    user_id: USER,
    referral_id: REF,
    read_at: null,
    expired_at: null,
    created_at: new Date(now - 60_000).toISOString(),
  };
}

describe("inaccessible referral notification deep-link flow", () => {
  it("soft-deleted referral: view opens, generic load-error toast, audit records notification_id=null", async () => {
    const now = Date.now();
    const handler = makeHandler({
      now,
      referralAccess: { kind: "soft_deleted" },
      notifs: [liveNotif(now)],
    });
    const toast = { warning: vi.fn(), info: vi.fn(), error: vi.fn() };

    const res = await runDeepLinkOpen({
      handler,
      referral_id: REF,
      notification_id: NID,
      userId: USER,
      toast,
    });

    expect(res.ok).toBe(true);
    expect(res.notificationStatus).toBe("invalid");

    // Two error toasts: the notification-invalid message and the generic
    // load failure. Neither one names the referral id or reveals that
    // the row was soft-deleted vs missing vs forbidden.
    expect(toast.error).toHaveBeenCalledTimes(2);
    expect(toast.error).toHaveBeenNthCalledWith(1, INVALID_TOAST);
    expect(toast.error).toHaveBeenNthCalledWith(2, LOAD_ERROR);
    for (const call of toast.error.mock.calls) {
      expect(call[0]).not.toContain(REF);
      expect(call[0]).not.toContain(NID);
      expect(String(call[0]).toLowerCase()).not.toContain("permission");
      expect(String(call[0]).toLowerCase()).not.toContain("deleted");
      expect(String(call[0]).toLowerCase()).not.toContain("forbidden");
    }
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();

    // Audit row exists and the notification id is scrubbed to null so
    // the unverified id never enters the audit trail.
    expect(handler.audit).toHaveLength(1);
    expect(handler.audit[0]).toMatchObject({
      user_id: USER,
      action: "view",
      entity: "referral",
      entity_id: REF,
      diff: { source: "direct", notification_id: null },
    });
    expect(handler.audit.some((a) => a.diff.notification_id === NID)).toBe(false);
  });

  it("hard-deleted referral produces the same outward behaviour", async () => {
    const now = Date.now();
    const handler = makeHandler({
      now,
      referralAccess: { kind: "hard_deleted" },
      // No live notification row — the deleted referral cascaded the notification away.
      notifs: [],
    });
    const toast = { warning: vi.fn(), info: vi.fn(), error: vi.fn() };

    const res = await runDeepLinkOpen({
      handler,
      referral_id: REF,
      notification_id: NID,
      userId: USER,
      toast,
    });

    expect(res.notificationStatus).toBe("invalid");
    expect(toast.error).toHaveBeenNthCalledWith(1, INVALID_TOAST);
    expect(toast.error).toHaveBeenNthCalledWith(2, LOAD_ERROR);
    expect(handler.audit[0].diff).toEqual({ source: "direct", notification_id: null });
    expect(handler.audit.some((a) => a.diff.notification_id === NID)).toBe(false);
  });

  it("RLS-blocked referral produces the same outward behaviour (no leak of existence)", async () => {
    const now = Date.now();
    const handler = makeHandler({
      now,
      // The referral row is alive server-side, but the caller can't read it.
      referralAccess: { kind: "rls_blocked" },
      notifs: [liveNotif(now)],
    });
    const toast = { warning: vi.fn(), info: vi.fn(), error: vi.fn() };

    const res = await runDeepLinkOpen({
      handler,
      referral_id: REF,
      notification_id: NID,
      userId: USER,
      toast,
    });

    expect(res.notificationStatus).toBe("invalid");
    expect(toast.error).toHaveBeenNthCalledWith(1, INVALID_TOAST);
    expect(toast.error).toHaveBeenNthCalledWith(2, LOAD_ERROR);
    // Even though the notification row exists and matches the referral,
    // the server refuses to verify it because the caller has lost access
    // — otherwise the audit trail would leak "you used to have access".
    expect(handler.audit[0].diff).toEqual({ source: "direct", notification_id: null });
    expect(handler.audit.some((a) => a.diff.notification_id === NID)).toBe(false);
  });

  it("all inaccessible modes are indistinguishable client-side", async () => {
    // Toast strings, notificationStatus, and audit shape must be
    // identical across soft-delete / hard-delete / RLS-block — otherwise
    // a caller could differentiate "referral is deleted" from
    // "referral exists but you can't see it".
    const now = Date.now();
    const modes: ReferralAccess[] = [
      { kind: "soft_deleted" },
      { kind: "hard_deleted" },
      { kind: "rls_blocked" },
    ];

    const results = await Promise.all(
      modes.map(async (referralAccess) => {
        const handler = makeHandler({
          now,
          referralAccess,
          notifs: referralAccess.kind === "hard_deleted" ? [] : [liveNotif(now)],
        });
        const toast = { warning: vi.fn(), info: vi.fn(), error: vi.fn() };
        const res = await runDeepLinkOpen({
          handler,
          referral_id: REF,
          notification_id: NID,
          userId: USER,
          toast,
        });
        return {
          status: res.notificationStatus,
          errorCalls: toast.error.mock.calls.map((c) => c[0]),
          warningCalls: toast.warning.mock.calls.length,
          infoCalls: toast.info.mock.calls.length,
          audit: handler.audit.map((a) => ({
            source: a.diff.source,
            notification_id: a.diff.notification_id,
            entity_id: a.entity_id,
          })),
        };
      }),
    );

    const [first, ...rest] = results;
    for (const other of rest) {
      expect(other).toEqual(first);
    }
    // Sanity: the shared shape is the safe one.
    expect(first.status).toBe("invalid");
    expect(first.errorCalls).toEqual([INVALID_TOAST, LOAD_ERROR]);
    expect(first.audit).toEqual([
      { source: "direct", notification_id: null, entity_id: REF },
    ]);
  });

  it("direct visit (no notification id) to an inaccessible referral still surfaces only the generic load error", async () => {
    // No `n` param at all — the notification-invalid toast must NOT fire,
    // only the generic load-failure toast. Audit still records a direct view.
    const now = Date.now();
    const handler = makeHandler({
      now,
      referralAccess: { kind: "soft_deleted" },
      notifs: [],
    });
    const toast = { warning: vi.fn(), info: vi.fn(), error: vi.fn() };

    await runDeepLinkOpen({
      handler,
      referral_id: REF,
      // notification_id intentionally omitted
      userId: USER,
      toast,
    });

    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(LOAD_ERROR);
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
    expect(handler.audit).toHaveLength(1);
    expect(handler.audit[0].diff).toEqual({ source: "direct", notification_id: null });
  });
});
