import { describe, it, expect, vi } from "vitest";
import { NOTIFICATION_DEEP_LINK_TTL_MS } from "./referrals.functions";

/**
 * End-to-end flow verification for repeated invalid deep-link clicks
 * fired in quick succession (e.g. a user impatiently mashing an old
 * bell link, an over-eager service worker replaying a stale push, or
 * a scripted probe hammering /referrals/:id?n=<forged>).
 *
 * Every click — regardless of how tightly they're spaced — must:
 *
 *   1. Open the referral view (never block, never crash).
 *   2. Surface the same generic invalid-link error toast so the
 *      failure is visible each time (no silent dedupe that could mask
 *      an ongoing probe from the clinician).
 *   3. Append a fresh audit_log row with source = "direct" and
 *      notification_id = null. The forged id must never appear in the
 *      audit trail, and the number of audit rows must equal the number
 *      of clicks so an admin can see the burst pattern.
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
  at: number;
};

function makeHandler(opts: { now: () => number; notifs: Notif[] }) {
  const audit: Audit[] = [];
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
      const n = opts.notifs.find(
        (x) =>
          x.id === input.notification_id &&
          x.user_id === input.userId &&
          x.referral_id === input.referral_id,
      );
      if (n) {
        const withinTtl =
          n.expired_at === null &&
          opts.now() - new Date(n.created_at).getTime() <= NOTIFICATION_DEEP_LINK_TTL_MS;
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
      at: opts.now(),
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
  toast: {
    warning: (m: string) => void;
    info: (m: string) => void;
    error: (m: string) => void;
  };
  loadRef: () => Promise<void>;
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
  await args.loadRef();
  return res;
}

const USER = "11111111-1111-1111-1111-111111111111";
const REF = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01";
const FORGED = "dddddddd-dddd-dddd-dddd-ddddddddddd9";
const INVALID_TOAST = "This notification link isn't valid for this referral.";

describe("repeated invalid notification deep-link clicks (burst)", () => {
  it("N rapid clicks each open safely, fire the error toast, and append N audit rows with null notification_id", async () => {
    // Simulate a virtual clock so all clicks share (effectively) the
    // same millisecond — realistic for a mashed link or a script.
    let t = Date.UTC(2026, 6, 11, 12, 0, 0);
    const handler = makeHandler({ now: () => t, notifs: [] });
    const toast = { warning: vi.fn(), info: vi.fn(), error: vi.fn() };
    const loadRef = vi.fn(async () => {});

    const CLICKS = 7;
    const results = [];
    for (let i = 0; i < CLICKS; i++) {
      // Advance by 1ms between clicks — well inside any reasonable
      // debounce window, which we explicitly do NOT want to apply.
      t += 1;
      results.push(
        await runDeepLinkOpen({
          handler,
          referral_id: REF,
          notification_id: FORGED,
          userId: USER,
          toast,
          loadRef,
        }),
      );
    }

    // 1. Every click opened the referral view.
    expect(loadRef).toHaveBeenCalledTimes(CLICKS);
    for (const r of results) {
      expect(r.ok).toBe(true);
      expect(r.notificationStatus).toBe("invalid");
    }

    // 2. Every click surfaced the generic error toast — no dedupe.
    expect(toast.error).toHaveBeenCalledTimes(CLICKS);
    for (const call of toast.error.mock.calls) {
      expect(call[0]).toBe(INVALID_TOAST);
    }
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();

    // 3. Audit trail records one row per click, all scrubbed.
    expect(handler.audit).toHaveLength(CLICKS);
    for (const row of handler.audit) {
      expect(row).toMatchObject({
        user_id: USER,
        action: "view",
        entity: "referral",
        entity_id: REF,
        diff: { source: "direct", notification_id: null },
      });
    }
    // Forged id must NEVER appear in the audit trail.
    expect(handler.audit.some((a) => a.diff.notification_id === FORGED)).toBe(false);
  });

  it("concurrent (Promise.all) invalid clicks each produce their own audit row", async () => {
    // A service worker or double-tap can dispatch multiple in-flight
    // requests before any of them resolves. All must still be logged
    // as invalid with null notification_id — none may be silently
    // collapsed by an accidental in-memory dedupe.
    let t = Date.UTC(2026, 6, 11, 12, 5, 0);
    const handler = makeHandler({ now: () => t, notifs: [] });
    const toast = { warning: vi.fn(), info: vi.fn(), error: vi.fn() };
    const loadRef = vi.fn(async () => {});

    const CLICKS = 5;
    const results = await Promise.all(
      Array.from({ length: CLICKS }, () =>
        runDeepLinkOpen({
          handler,
          referral_id: REF,
          notification_id: FORGED,
          userId: USER,
          toast,
          loadRef,
        }),
      ),
    );

    expect(results).toHaveLength(CLICKS);
    for (const r of results) expect(r.notificationStatus).toBe("invalid");
    expect(toast.error).toHaveBeenCalledTimes(CLICKS);
    expect(loadRef).toHaveBeenCalledTimes(CLICKS);
    expect(handler.audit).toHaveLength(CLICKS);
    expect(
      handler.audit.every(
        (a) => a.diff.source === "direct" && a.diff.notification_id === null,
      ),
    ).toBe(true);
    expect(handler.audit.some((a) => a.diff.notification_id === FORGED)).toBe(false);
  });

  it("burst of distinct forged ids each log a separate null row (no id leaks into audit)", async () => {
    // A probe might rotate through a list of guessed ids. Each attempt
    // must still be scrubbed to null so the guessed ids can't be
    // reconstructed from the audit trail.
    let t = Date.UTC(2026, 6, 11, 12, 10, 0);
    const handler = makeHandler({ now: () => t, notifs: [] });
    const toast = { warning: vi.fn(), info: vi.fn(), error: vi.fn() };
    const loadRef = vi.fn(async () => {});

    const guesses = [
      "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1",
      "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee2",
      "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee3",
      "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee4",
    ];
    for (const g of guesses) {
      t += 1;
      await runDeepLinkOpen({
        handler,
        referral_id: REF,
        notification_id: g,
        userId: USER,
        toast,
        loadRef,
      });
    }

    expect(toast.error).toHaveBeenCalledTimes(guesses.length);
    expect(handler.audit).toHaveLength(guesses.length);
    for (const row of handler.audit) {
      expect(row.diff).toEqual({ source: "direct", notification_id: null });
    }
    for (const g of guesses) {
      expect(handler.audit.some((a) => a.diff.notification_id === g)).toBe(false);
    }
  });
});
