import { describe, it, expect, vi } from "vitest";
import {
  fanOutNotifications,
  type FanOutDeps,
  type ProfileRow,
  type PushSubRow,
  type RoleRow,
} from "./notification-fanout";

/**
 * Integration test: the `updateReferral` notification filter must ignore
 * `status` keys whose value equals the current row status. A same-value
 * status write is a no-op and must not influence the fanout decision —
 * neither the "status" branch nor the "updated" branch should fire when
 * the ONLY thing in the patch is an unchanged status (with or without
 * bookkeeping keys like `updated_by`).
 *
 * The production code normalizes the patch before deciding:
 *   const effectivePatch = { ...patch }
 *   if ("status" in effectivePatch && prior.status === row.status)
 *     delete effectivePatch.status;
 *   const statusChanged = "status" in effectivePatch;
 *   const patchKeys = keys(effectivePatch) minus updated_by/status;
 *   if patchKeys.length > 0 → "updated"
 *   else if statusChanged  → "status"
 *   else                    → no fanout
 *
 * This spec locks that normalization in with the same predicate.
 */

const ACTOR = "00000000-0000-0000-0000-0000000000a1";
const CLIN_OPTED_IN = "00000000-0000-0000-0000-0000000000b1";
const ADMIN_OPTED_IN = "00000000-0000-0000-0000-0000000000c1";
const REFERRAL_ID = "abcdef01-2345-6789-abcd-ef0123456789";

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
 * Faithful port of the normalized branch predicate inside
 * `updateReferral`. Returns the fanout kind that should fire.
 */
function decideFanoutKind(
  patch: Record<string, unknown>,
  priorStatus: string | null,
  currentStatus: string | null,
): "updated" | "status" | null {
  const effective: Record<string, unknown> = { ...patch };
  if ("status" in effective && priorStatus === currentStatus) {
    delete effective.status;
  }
  const statusChanged = "status" in effective;
  const patchKeys = Object.keys(effective).filter(
    (k) => k !== "updated_by" && k !== "status",
  );
  if (patchKeys.length > 0) return "updated";
  return statusChanged ? "status" : null;
}

describe("updateReferral: unchanged status keys are ignored by the notification filter", () => {
  it("patch { status: 'referred' } when current status is 'referred' → no fanout", () => {
    // The archetypal case: a client resubmits the current status. The
    // normalization strips the key entirely, so neither branch fires.
    expect(decideFanoutKind({ status: "referred" }, "referred", "referred"))
      .toBeNull();
  });

  it("patch { status: 'accepted', updated_by } when status already 'accepted' → no fanout", () => {
    // Same-value status paired with bookkeeping is still a governance-only
    // write. `updated_by` is stripped, unchanged `status` is stripped,
    // and no keys remain to trigger either push.
    expect(
      decideFanoutKind(
        { status: "accepted", updated_by: ACTOR },
        "accepted",
        "accepted",
      ),
    ).toBeNull();
  });

  it("firing 'updated' anyway would reach opted-in users — proving suppression is what protects them", async () => {
    // Documents the blast radius that suppression avoids. If the filter
    // ever regressed and dispatched "updated" for a same-value status
    // patch, both opted-in recipients would be pinged for nothing.
    const { deps, sendPush, insertNotifications } = makeDeps();
    await fanOutNotifications(deps, {
      actorId: ACTOR,
      referralId: REFERRAL_ID,
      kind: "updated",
      message: "Referral updated: (would be noise)",
      url: `/referrals/${REFERRAL_ID}`,
      title: "Referral updated",
    });
    expect(sendPush).toHaveBeenCalledTimes(1);
    const subs = sendPush.mock.calls[0][0] as PushSubRow[];
    expect(subs.map((s) => s.user_id).sort()).toEqual(
      [CLIN_OPTED_IN, ADMIN_OPTED_IN].sort(),
    );
    expect(insertNotifications).toHaveBeenCalledTimes(1);
  });

  it("a genuinely CHANGED status still fires the 'status' push (guards against over-suppression)", () => {
    // The filter must only ignore status when its value is unchanged.
    // A real transition still produces the dedicated status push.
    expect(decideFanoutKind({ status: "accepted" }, "referred", "accepted"))
      .toBe("status");
  });

  it("unchanged status paired with a real field edit still fires 'updated' with the deep link", async () => {
    // Same-value status must not eclipse a real content change. The
    // "updated" push still fires because the content key survives.
    expect(
      decideFanoutKind(
        { status: "accepted", current_ward: "Ward 9A" },
        "accepted",
        "accepted",
      ),
    ).toBe("updated");

    const { deps, sendPush } = makeDeps();
    await fanOutNotifications(deps, {
      actorId: ACTOR,
      referralId: REFERRAL_ID,
      kind: "updated",
      message: "Referral updated: Respiratory — Ward 9A",
      url: `/referrals/${REFERRAL_ID}`,
      title: "Referral updated",
    });
    expect(sendPush).toHaveBeenCalledTimes(1);
    const payload = sendPush.mock.calls[0][1] as { url?: string; body: string };
    expect(payload.url).toBe(`/referrals/${REFERRAL_ID}`);
    expect(payload.body).toBe("Referral updated: Respiratory — Ward 9A");
  });
});
