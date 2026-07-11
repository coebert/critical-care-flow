import { describe, it, expect, vi } from "vitest";
import {
  fanOutNotifications,
  type FanOutDeps,
  type ProfileRow,
  type PushSubRow,
  type PushDeliveryResult,
  type RoleRow,
} from "./notification-fanout";
import { retryWithBackoff } from "./retry";

/**
 * Integration test: a transient push provider failure during a referral
 * update must be retried, but the eventual per-recipient delivery count
 * must stay at exactly one — no duplicate push per edit.
 *
 * `updateReferral` calls `fanOutNotifications` once per edit, and
 * fanout in turn calls the injected `sendPush` once with the full
 * subscription batch. Real push delivery is wrapped in `retryWithBackoff`
 * (see `src/lib/retry.ts`), so a transient network blip on a specific
 * endpoint causes THAT endpoint's request to be retried inside sendPush
 * — the recipient still receives exactly one push notification, and
 * fanout still reports exactly one in-app notification per user.
 */

const ACTOR = "00000000-0000-0000-0000-0000000000a1";
const CLIN_ON = "00000000-0000-0000-0000-0000000000b1";
const ADMIN_ON = "00000000-0000-0000-0000-0000000000c1";
const REFERRAL_ID = "deadbeef-0000-4000-8000-000000000001";

const ROLES: RoleRow[] = [
  { user_id: ACTOR, role: "clinician" },
  { user_id: CLIN_ON, role: "clinician" },
  { user_id: ADMIN_ON, role: "admin" },
];
const PROFILES: ProfileRow[] = [
  { id: ACTOR, is_at_work: true, notify_updated_referral: true },
  { id: CLIN_ON, is_at_work: true, notify_updated_referral: true },
  { id: ADMIN_ON, is_at_work: true, notify_updated_referral: true },
];
const SUBS: PushSubRow[] = [
  { user_id: CLIN_ON, endpoint: "https://push/clin", p256dh: "k", auth: "a" },
  { user_id: ADMIN_ON, endpoint: "https://push/admin", p256dh: "k", auth: "a" },
];

/**
 * Build a flaky per-endpoint push provider. The first `failuresPerEndpoint`
 * attempts against each endpoint throw a transient error; subsequent
 * attempts succeed. Records the delivery count per endpoint so the test
 * can assert the recipient ultimately received exactly one notification.
 */
function makeFlakyProvider(failuresPerEndpoint: number) {
  const attempts = new Map<string, number>();
  const delivered = new Map<string, number>();
  const provider = vi.fn(async (endpoint: string) => {
    const n = (attempts.get(endpoint) ?? 0) + 1;
    attempts.set(endpoint, n);
    if (n <= failuresPerEndpoint) {
      const err = new Error("ECONNRESET: transient network failure");
      // Tag as retryable per the default shouldRetry heuristic in retry.ts.
      (err as Error & { status?: number }).status = 503;
      throw err;
    }
    delivered.set(endpoint, (delivered.get(endpoint) ?? 0) + 1);
  });
  return { provider, attempts, delivered };
}

/**
 * A production-shaped `sendPush` that retries each endpoint with
 * `retryWithBackoff` — mirrors how the real Web Push HTTP call is
 * wrapped in `src/lib/push.server.ts`. Returns per-endpoint results so
 * fanOutNotifications can audit them.
 */
function makeSendPushWithRetry(provider: (endpoint: string) => Promise<void>) {
  return vi.fn(
    async (
      subs: PushSubRow[],
    ): Promise<{
      goneEndpoints: string[];
      results: PushDeliveryResult[];
    }> => {
      const results: PushDeliveryResult[] = [];
      for (const sub of subs) {
        try {
          await retryWithBackoff(() => provider(sub.endpoint), {
            retries: 3,
            baseDelayMs: 0,
            maxDelayMs: 0,
            factor: 1,
            shouldRetry: () => true,
          });
          results.push({ endpoint: sub.endpoint, user_id: sub.user_id, ok: true });
        } catch (e) {
          results.push({
            endpoint: sub.endpoint,
            user_id: sub.user_id,
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      return { goneEndpoints: [], results };
    },
  );
}

function makeDeps(sendPush: ReturnType<typeof makeSendPushWithRetry>) {
  const insertNotifications = vi.fn().mockResolvedValue(undefined);
  const deletePushSubs = vi.fn().mockResolvedValue(undefined);
  const deps: FanOutDeps = {
    fetchEligibleRoles: vi.fn(async (actorId: string) =>
      ROLES.filter(
        (r) =>
          (r.role === "admin" || r.role === "clinician") &&
          r.user_id !== actorId,
      ),
    ),
    fetchAtWorkProfiles: vi.fn(async (ids: string[]) => {
      const set = new Set(ids);
      return PROFILES.filter((p) => set.has(p.id));
    }),
    fetchPushSubs: vi.fn(async (ids: string[]) => {
      const set = new Set(ids);
      return SUBS.filter((s) => set.has(s.user_id));
    }),
    insertNotifications,
    sendPush,
    deletePushSubs,
  };
  return { deps, insertNotifications };
}

describe("referral update push retry — one push per edit despite transient failures", () => {
  it("first attempt fails per endpoint, retry succeeds → each recipient gets exactly one push", async () => {
    const { provider, attempts, delivered } = makeFlakyProvider(1);
    const sendPush = makeSendPushWithRetry(provider);
    const { deps, insertNotifications } = makeDeps(sendPush);

    // Same call shape as updateReferral makes for a non-status edit.
    const result = await fanOutNotifications(deps, {
      actorId: ACTOR,
      referralId: REFERRAL_ID,
      kind: "updated",
      message: "Referral updated: Respiratory — Ward 7B",
      url: `/referrals/${REFERRAL_ID}`,
      title: "Referral updated",
    });

    // Fanout invoked sendPush exactly once (retry lives INSIDE it, per
    // endpoint) — the edit produces one fanout, not two.
    expect(sendPush).toHaveBeenCalledTimes(1);

    // Each endpoint saw 2 attempts (1 transient failure + 1 success)
    // but was ultimately delivered to exactly once.
    expect(provider).toHaveBeenCalledTimes(4);
    expect(attempts.get("https://push/clin")).toBe(2);
    expect(attempts.get("https://push/admin")).toBe(2);
    expect(delivered.get("https://push/clin")).toBe(1);
    expect(delivered.get("https://push/admin")).toBe(1);

    // Fanout reports one successful push per recipient.
    expect(result.pushSent).toBe(2);
    expect(result.recipientIds.sort()).toEqual([CLIN_ON, ADMIN_ON].sort());

    // In-app notifications inserted exactly once per recipient.
    expect(insertNotifications).toHaveBeenCalledTimes(1);
    const rows = insertNotifications.mock.calls[0][0] as Array<{
      user_id: string;
      kind: string;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.user_id).sort()).toEqual(
      [CLIN_ON, ADMIN_ON].sort(),
    );
    expect(rows.every((r) => r.kind === "updated")).toBe(true);

    // Payload still carries the correct deep link after retry.
    const payload = sendPush.mock.calls[0][1] as { url?: string; body: string };
    expect(payload.url).toBe(`/referrals/${REFERRAL_ID}`);
    expect(payload.body).toBe("Referral updated: Respiratory — Ward 7B");
  });

  it("multiple transient failures on the same endpoint still resolve to exactly one delivery", async () => {
    // Simulates a longer blip — 2 transient failures before success.
    // The retry ceiling in makeSendPushWithRetry is 3 retries (4 total
    // attempts), so 2 failures still recover.
    const { provider, delivered } = makeFlakyProvider(2);
    const sendPush = makeSendPushWithRetry(provider);
    const { deps } = makeDeps(sendPush);

    const result = await fanOutNotifications(deps, {
      actorId: ACTOR,
      referralId: REFERRAL_ID,
      kind: "updated",
      message: "Referral updated: Respiratory — Ward 7B",
      url: `/referrals/${REFERRAL_ID}`,
      title: "Referral updated",
    });

    expect(delivered.get("https://push/clin")).toBe(1);
    expect(delivered.get("https://push/admin")).toBe(1);
    expect(result.pushSent).toBe(2);
  });

  it("sanity: with zero failures, retry path still yields exactly one delivery per recipient", async () => {
    // Guards against a regression where retry wrapping accidentally
    // double-invokes the provider on happy path.
    const { provider, delivered } = makeFlakyProvider(0);
    const sendPush = makeSendPushWithRetry(provider);
    const { deps, insertNotifications } = makeDeps(sendPush);

    const result = await fanOutNotifications(deps, {
      actorId: ACTOR,
      referralId: REFERRAL_ID,
      kind: "updated",
      message: "Referral updated: Respiratory — Ward 7B",
      url: `/referrals/${REFERRAL_ID}`,
      title: "Referral updated",
    });

    expect(provider).toHaveBeenCalledTimes(2);
    expect(delivered.get("https://push/clin")).toBe(1);
    expect(delivered.get("https://push/admin")).toBe(1);
    expect(result.pushSent).toBe(2);
    expect(insertNotifications).toHaveBeenCalledTimes(1);
  });
});
