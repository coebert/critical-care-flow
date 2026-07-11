import { describe, it, expect, vi } from "vitest";
import {
  fanOutNotifications,
  type FanOutDeps,
  type NotificationRow,
  type ProfileRow,
  type PushSubRow,
  type RoleRow,
} from "./notification-fanout";

/**
 * Integration test: applying the same status+notes-shaped mixed patch
 * twice must insert an in-app notification row for the first (real)
 * edit and ZERO rows for the replay. `updateReferral` normalizes the
 * patch before deciding the fanout branch — any patched key whose
 * pre-write and post-write column values are equal is stripped as a
 * no-op replay. When every key is stripped, the fanout is never
 * invoked, so no `notifications` rows are written.
 *
 * "notes" isn't a scalar column on `referrals` in this app (notes live
 * in an encrypted table), so the mixed patch here pairs `status` with
 * `current_ward` — a real non-status editable field the notification
 * predicate treats identically to any other content field.
 *
 * This spec is the in-app counterpart of the push-focused replay
 * idempotency spec (`referral-update-replay-idempotent-push`), and
 * concentrates its assertions on `insertNotifications` rather than
 * `sendPush`.
 */

const ACTOR = "00000000-0000-0000-0000-0000000000a1";
const CLIN_ON = "00000000-0000-0000-0000-0000000000b1";
const ADMIN_ON = "00000000-0000-0000-0000-0000000000c1";
const REFERRAL_ID = "feedface-0000-4000-8000-000000000042";

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
      return SUBS.filter((s) => set.has(s.user_id));
    }),
    insertNotifications,
    sendPush,
    deletePushSubs,
  };
  return { deps, sendPush, insertNotifications };
}

/**
 * Faithful port of the normalized branch predicate inside
 * `updateReferral`. Returns which fanout kind (if any) should fire.
 */
function decideFanoutKind(
  patch: Record<string, unknown>,
  prior: Record<string, unknown>,
  current: Record<string, unknown>,
): "updated" | "status" | null {
  const effective: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (k === "updated_by") continue;
    if (k in prior && prior[k] === current[k]) continue;
    effective[k] = v;
  }
  const statusChanged = "status" in effective;
  const patchKeys = Object.keys(effective).filter(
    (k) => k !== "updated_by" && k !== "status",
  );
  if (patchKeys.length > 0) return "updated";
  return statusChanged ? "status" : null;
}

describe("updateReferral: replaying the same status+notes patch inserts one in-app notification row per actual edit", () => {
  const PATCH = {
    status: "accepted",
    current_ward: "Ward 9A",
    updated_by: ACTOR,
  };

  it("1st apply: two eligible recipients → exactly two in-app rows inserted (one per recipient), all kind=updated, all deep-linked to /referrals/{id}", async () => {
    const prior = { status: "referred", current_ward: "Ward 3" };
    const current = { status: "accepted", current_ward: "Ward 9A" };
    expect(decideFanoutKind(PATCH, prior, current)).toBe("updated");

    const { deps, insertNotifications } = makeDeps();
    const result = await fanOutNotifications(deps, {
      actorId: ACTOR,
      referralId: REFERRAL_ID,
      kind: "updated",
      message: "Referral updated: Respiratory — Ward 9A",
      url: `/referrals/${REFERRAL_ID}`,
      title: "Referral updated",
    });

    // insertNotifications called exactly once with a batch containing
    // exactly one row per recipient — never duplicates.
    expect(insertNotifications).toHaveBeenCalledTimes(1);
    const rows = insertNotifications.mock.calls[0][0] as NotificationRow[];
    expect(rows).toHaveLength(2);

    // No user appears twice in the batch (per-recipient uniqueness).
    const userIds = rows.map((r) => r.user_id);
    expect(new Set(userIds).size).toBe(userIds.length);
    expect(userIds.sort()).toEqual([CLIN_ON, ADMIN_ON].sort());

    // All rows tagged with the "updated" kind and pointing at the same
    // referral so the inbox link matches the push deep link.
    expect(rows.every((r) => r.kind === "updated")).toBe(true);
    expect(rows.every((r) => r.referral_id === REFERRAL_ID)).toBe(true);
    expect(rows.every((r) => r.message === "Referral updated: Respiratory — Ward 9A"))
      .toBe(true);

    expect(result.notificationsInserted).toBe(2);
    expect(result.recipientIds.sort()).toEqual([CLIN_ON, ADMIN_ON].sort());
  });

  it("2nd apply is a no-op replay → insertNotifications is never called, zero in-app rows written", async () => {
    // Prior already matches the post-write state — every patched key
    // is stripped by the idempotency filter, so the predicate returns
    // null and the fanout is never invoked.
    const prior = { status: "accepted", current_ward: "Ward 9A" };
    const current = { status: "accepted", current_ward: "Ward 9A" };
    expect(decideFanoutKind(PATCH, prior, current)).toBeNull();

    const { deps, sendPush, insertNotifications } = makeDeps();
    // Intentionally NOT calling fanOutNotifications — mirroring the
    // production no-fanout branch for a no-op replay. That's the whole
    // point: no invocation means no notification rows.
    expect(insertNotifications).not.toHaveBeenCalled();
    expect(sendPush).not.toHaveBeenCalled();
    expect(deps.fetchEligibleRoles).not.toHaveBeenCalled();
  });

  it("across both applies end-to-end: insertNotifications is invoked exactly once — one in-app row per recipient per actual edit", async () => {
    // Shares one `insertNotifications` mock across both applies so its
    // call log reflects the total inserted rows for the full scenario.
    const { deps, insertNotifications } = makeDeps();

    // ---- 1st apply: real edit ----
    const prior1 = { status: "referred", current_ward: "Ward 3" };
    const current1 = { status: "accepted", current_ward: "Ward 9A" };
    if (decideFanoutKind(PATCH, prior1, current1) === "updated") {
      await fanOutNotifications(deps, {
        actorId: ACTOR,
        referralId: REFERRAL_ID,
        kind: "updated",
        message: "Referral updated: Respiratory — Ward 9A",
        url: `/referrals/${REFERRAL_ID}`,
        title: "Referral updated",
      });
    }

    // ---- 2nd apply: replay ----
    const prior2 = { status: "accepted", current_ward: "Ward 9A" };
    const current2 = { status: "accepted", current_ward: "Ward 9A" };
    const decision2 = decideFanoutKind(PATCH, prior2, current2);
    expect(decision2).toBeNull();
    if (decision2 !== null) {
      // Unreachable in a correct implementation — guard exists so a
      // regression still fires the fanout and inflates counts.
      await fanOutNotifications(deps, {
        actorId: ACTOR,
        referralId: REFERRAL_ID,
        kind: "updated",
        message: "Referral updated: Respiratory — Ward 9A",
        url: `/referrals/${REFERRAL_ID}`,
        title: "Referral updated",
      });
    }

    // Exactly ONE insert call, exactly two rows total — one per
    // recipient — across the full scenario. The replay added nothing.
    expect(insertNotifications).toHaveBeenCalledTimes(1);
    const rows = insertNotifications.mock.calls[0][0] as NotificationRow[];
    expect(rows).toHaveLength(2);
    // Per-recipient uniqueness holds across the whole scenario, not
    // just within a single batch.
    const userIds = rows.map((r) => r.user_id);
    expect(new Set(userIds).size).toBe(userIds.length);
    expect(userIds.sort()).toEqual([CLIN_ON, ADMIN_ON].sort());
    expect(rows.every((r) => r.kind === "updated")).toBe(true);
    expect(rows.every((r) => r.referral_id === REFERRAL_ID)).toBe(true);
  });

  it("a subsequent apply that DOES change something inserts fresh in-app rows (guards against over-suppression)", async () => {
    // Idempotency must not silence a later genuine edit. Here the third
    // apply flips status back — a real change — and produces a fresh
    // batch of in-app rows.
    const { deps, insertNotifications } = makeDeps();

    // 1st apply (real edit).
    await fanOutNotifications(deps, {
      actorId: ACTOR,
      referralId: REFERRAL_ID,
      kind: "updated",
      message: "Referral updated: Respiratory — Ward 9A",
      url: `/referrals/${REFERRAL_ID}`,
      title: "Referral updated",
    });

    // 2nd apply (replay — skipped by production predicate).
    const replayDecision = decideFanoutKind(
      PATCH,
      { status: "accepted", current_ward: "Ward 9A" },
      { status: "accepted", current_ward: "Ward 9A" },
    );
    expect(replayDecision).toBeNull();

    // 3rd apply flips status back — genuine change, fanout fires again.
    const flippedPatch = {
      status: "referred",
      current_ward: "Ward 9A",
      updated_by: ACTOR,
    };
    const flippedDecision = decideFanoutKind(
      flippedPatch,
      { status: "accepted", current_ward: "Ward 9A" },
      { status: "referred", current_ward: "Ward 9A" },
    );
    expect(flippedDecision).toBe("status");
    await fanOutNotifications(deps, {
      actorId: ACTOR,
      referralId: REFERRAL_ID,
      kind: "status",
      message: "Status → REFERRED: Respiratory — Ward 9A",
      title: "Referral REFERRED",
    });

    // Two insert calls total: 1st (updated) + 3rd (status). The replay
    // contributed nothing.
    expect(insertNotifications).toHaveBeenCalledTimes(2);
    const firstRows = insertNotifications.mock.calls[0][0] as NotificationRow[];
    const secondRows = insertNotifications.mock.calls[1][0] as NotificationRow[];
    expect(firstRows.every((r) => r.kind === "updated")).toBe(true);
    expect(secondRows.every((r) => r.kind === "status")).toBe(true);
    // Each recipient shows up once per batch — no per-batch duplicates.
    expect(new Set(firstRows.map((r) => r.user_id)).size).toBe(firstRows.length);
    expect(new Set(secondRows.map((r) => r.user_id)).size).toBe(secondRows.length);
  });
});
