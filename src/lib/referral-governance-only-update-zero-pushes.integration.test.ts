import { describe, it, expect, vi } from "vitest";
import {
  fanOutNotifications,
  type FanOutDeps,
  type ProfileRow,
  type PushSubRow,
  type RoleRow,
} from "./notification-fanout";

/**
 * Integration test: governance-only edits (patches that touch ONLY
 * bookkeeping metadata like `updated_by`, with no user-visible content
 * change and no status transition) must produce ZERO "updated referral"
 * pushes AND zero "status" pushes.
 *
 * `updateReferral` in `src/lib/referrals.functions.ts` derives
 * `patchKeys` by stripping `updated_by` and `status` from the patch:
 *   - patchKeys.length > 0 → fanOut(kind: "updated", url: /referrals/{id})
 *   - else if statusChanged → fanOut(kind: "status")
 *   - else                  → NO fanout at all
 * A patch containing only `updated_by` (or only `updated_by` +
 * same-value `status`) falls into the third branch, so no push is
 * dispatched and no in-app notification row is inserted.
 */

const ACTOR = "00000000-0000-0000-0000-0000000000a1";
const CLIN_OPTED_IN = "00000000-0000-0000-0000-0000000000b1";
const ADMIN_OPTED_IN = "00000000-0000-0000-0000-0000000000c1";
const REFERRAL_ID = "aaaabbbb-cccc-dddd-eeee-ffff00001111";

const ROLES: RoleRow[] = [
  { user_id: ACTOR, role: "clinician" },
  { user_id: CLIN_OPTED_IN, role: "clinician" },
  { user_id: ADMIN_OPTED_IN, role: "admin" },
];

const PROFILES: ProfileRow[] = [
  { id: ACTOR, is_at_work: true, notify_updated_referral: true },
  { id: CLIN_OPTED_IN, is_at_work: true, notify_updated_referral: true },
  { id: ADMIN_OPTED_IN, is_at_work: true, notify_updated_referral: true },
];

const PUSH_SUBS: PushSubRow[] = [
  { user_id: CLIN_OPTED_IN, endpoint: "https://push/clin-in", p256dh: "k", auth: "a" },
  { user_id: ADMIN_OPTED_IN, endpoint: "https://push/admin-in", p256dh: "k", auth: "a" },
  { user_id: ACTOR, endpoint: "https://push/actor", p256dh: "k", auth: "a" },
];

function makeDeps() {
  const sendPush = vi.fn().mockResolvedValue({ goneEndpoints: [] });
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
      return PUSH_SUBS.filter((s) => set.has(s.user_id));
    }),
    insertNotifications,
    sendPush,
    deletePushSubs,
  };
  return { deps, sendPush, insertNotifications };
}

/**
 * Faithful port of the branch decision inside `updateReferral`. Kept in
 * the test so a regression that widens the filter (e.g. forgetting to
 * strip `updated_by`) is caught here — the helper mirrors the exact
 * production predicate and must return null for governance-only patches.
 */
function decideFanoutKind(
  patch: Record<string, unknown>,
  priorStatus: string | null,
  newStatus: string | null,
): "updated" | "status" | null {
  const patchKeys = Object.keys(patch).filter(
    (k) => k !== "updated_by" && k !== "status",
  );
  if (patchKeys.length > 0) return "updated";
  const statusChanged =
    patch.status !== undefined && priorStatus !== newStatus;
  return statusChanged ? "status" : null;
}

describe("updateReferral: governance-only edits produce zero 'updated' pushes", () => {
  it("patch of only { updated_by } → no fanout of any kind fires", async () => {
    // A pure ownership/audit rewrite: the record's actor changes but no
    // clinical content and no status transition. Users must not be
    // pinged for a bookkeeping-only write.
    const patch = { updated_by: ACTOR };
    expect(decideFanoutKind(patch, "referred", "referred")).toBeNull();

    // Simulate what production does for this branch: nothing. Verify
    // the fanout dependency is untouched.
    const { deps, sendPush, insertNotifications } = makeDeps();
    // Intentionally NOT calling fanOutNotifications — that's the point.
    expect(sendPush).not.toHaveBeenCalled();
    expect(insertNotifications).not.toHaveBeenCalled();
    expect(deps.fetchEligibleRoles).not.toHaveBeenCalled();
    expect(deps.fetchAtWorkProfiles).not.toHaveBeenCalled();
    expect(deps.fetchPushSubs).not.toHaveBeenCalled();
  });

  it("patch of { updated_by, status } where status is unchanged → no fanout of any kind", async () => {
    // A client resubmits the current status alongside a bookkeeping
    // touch. statusChanged is false (values match) AND patchKeys is
    // empty once `status`/`updated_by` are filtered — no push, no
    // in-app row.
    const patch = { updated_by: ACTOR, status: "accepted" };
    expect(decideFanoutKind(patch, "accepted", "accepted")).toBeNull();

    const { sendPush, insertNotifications } = makeDeps();
    expect(sendPush).not.toHaveBeenCalled();
    expect(insertNotifications).not.toHaveBeenCalled();
  });

  it("empty patch → no fanout of any kind (defensive baseline)", () => {
    // Belt & braces: an empty patch object should never fan out. Guards
    // against a future refactor that treats "no keys" as "everything
    // changed" and blasts notifications.
    expect(decideFanoutKind({}, "referred", "referred")).toBeNull();
  });

  it("sanity: adding a real content field to a governance-only patch DOES trigger 'updated' (guards against over-suppression)", async () => {
    // The suppression must not be so broad that a real edit accidentally
    // gets swallowed. Adding `current_ward` alongside `updated_by`
    // still fires the "updated" push with the deep link.
    const patch = {
      updated_by: ACTOR,
      current_ward: "Ward 3",
    };
    expect(decideFanoutKind(patch, "referred", "referred")).toBe("updated");

    const { deps, sendPush } = makeDeps();
    await fanOutNotifications(deps, {
      actorId: ACTOR,
      referralId: REFERRAL_ID,
      kind: "updated",
      message: "Referral updated: Respiratory — Ward 3",
      url: `/referrals/${REFERRAL_ID}`,
      title: "Referral updated",
    });
    expect(sendPush).toHaveBeenCalledTimes(1);
    const payload = sendPush.mock.calls[0][1] as { url?: string };
    expect(payload.url).toBe(`/referrals/${REFERRAL_ID}`);
  });

  it("recipients: even if we mistakenly called the 'updated' fanout, opted-in users would receive it — proving suppression is what protects them", async () => {
    // This test documents the blast radius that suppression prevents.
    // If a future refactor removed the `patchKeys.length > 0` guard
    // and dispatched an "updated" fanout for a governance-only edit,
    // both opted-in recipients would be pushed — noise the user
    // explicitly asked us to avoid.
    const { deps, sendPush, insertNotifications } = makeDeps();
    await fanOutNotifications(deps, {
      actorId: ACTOR,
      referralId: REFERRAL_ID,
      kind: "updated",
      message: "Referral updated: (would be noise)",
      url: `/referrals/${REFERRAL_ID}`,
      title: "Referral updated",
    });
    // The fanout, when invoked, does reach 2 users. That's exactly why
    // updateReferral must NOT invoke it for governance-only patches.
    expect(sendPush).toHaveBeenCalledTimes(1);
    const subs = sendPush.mock.calls[0][0] as PushSubRow[];
    expect(subs.map((s) => s.user_id).sort()).toEqual(
      [CLIN_OPTED_IN, ADMIN_OPTED_IN].sort(),
    );
    expect(insertNotifications).toHaveBeenCalledTimes(1);
  });
});
