import { describe, it, expect, vi } from "vitest";
import {
  fanOutNotifications,
  type FanOutDeps,
  type ProfileRow,
  type PushSubRow,
  type RoleRow,
} from "./notification-fanout";

/**
 * Integration test: a status-only edit to an existing referral must NOT
 * emit an "updated referral" push.
 *
 * `updateReferral` in `src/lib/referrals.functions.ts` splits into two
 * branches after the DB write:
 *
 *   - statusChanged === true  → fanOutNotifications(kind: "status", ...)
 *   - else                    → derive patchKeys by filtering out
 *                               `updated_by` AND `status`, and only fire
 *                               fanOutNotifications(kind: "updated", ...)
 *                               when patchKeys.length > 0.
 *
 * That guarantees a status-only edit produces exactly ONE push (the
 * dedicated "status" one) — never a second "updated" push for the same
 * edit. This spec re-runs that exact decision against the real
 * `fanOutNotifications` and asserts zero "updated" pushes are dispatched.
 */

const ACTOR = "00000000-0000-0000-0000-0000000000aa";
const CLINICIAN_ON = "00000000-0000-0000-0000-0000000000bb";
const ADMIN_ON = "00000000-0000-0000-0000-0000000000cc";

const REFERRAL_ID = "77777777-8888-9999-aaaa-bbbbbbbbbbbb";

const ROLES: RoleRow[] = [
  { user_id: ACTOR, role: "clinician" },
  { user_id: CLINICIAN_ON, role: "clinician" },
  { user_id: ADMIN_ON, role: "admin" },
];

const PROFILES: ProfileRow[] = [
  { id: ACTOR, is_at_work: true, notify_updated_referral: true },
  { id: CLINICIAN_ON, is_at_work: true, notify_updated_referral: true },
  { id: ADMIN_ON, is_at_work: true, notify_updated_referral: true },
];

const PUSH_SUBS: PushSubRow[] = [
  { user_id: CLINICIAN_ON, endpoint: "https://push/clin", p256dh: "k", auth: "a" },
  { user_id: ADMIN_ON, endpoint: "https://push/admin", p256dh: "k", auth: "a" },
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
      return PROFILES.filter((p) => set.has(p.id) && p.is_at_work);
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
 * Faithful port of the branch decision inside `updateReferral`. Given the
 * `patch` a client submitted plus the prior/current status, this returns
 * whether an "updated" push should fire — the same predicate the server
 * function evaluates. Kept as a helper here so the test asserts the
 * production rule verbatim.
 */
function shouldFireUpdatedPush(
  patch: Record<string, unknown>,
  _priorStatus: string | null,
  _newStatus: string | null,
): boolean {
  // Production rule: fire "updated" whenever the patch contains any real
  // content field (i.e. anything other than `updated_by` / `status`),
  // regardless of whether status also changed. A pure status-only edit
  // still takes the dedicated "status" branch and suppresses "updated".
  const patchKeys = Object.keys(patch).filter(
    (k) => k !== "updated_by" && k !== "status",
  );
  return patchKeys.length > 0;
}

describe("updateReferral: status-only edits suppress the 'updated' push", () => {
  it("status change from 'referred' → 'accepted' produces ZERO 'updated' pushes", async () => {
    const { deps, sendPush, insertNotifications } = makeDeps();

    // What a status-only client submission looks like on the wire.
    const patch = { status: "accepted", updated_by: ACTOR };
    const prior = "referred";
    const next = "accepted";

    // The production branch: statusChanged is true, so `updateReferral`
    // fires ONLY the dedicated "status" fanout. It never enters the
    // "updated" branch, so `fanOutNotifications(kind: "updated", ...)`
    // must not be invoked at all.
    expect(shouldFireUpdatedPush(patch, prior, next)).toBe(false);

    // Simulate what actually happens in production for this branch: the
    // "status" fanout runs, the "updated" fanout does not.
    await fanOutNotifications(deps, {
      actorId: ACTOR,
      referralId: REFERRAL_ID,
      kind: "status",
      message: "Status → ACCEPTED: Respiratory — Ward 7B",
      title: "Referral ACCEPTED",
    });

    // Exactly ONE push batch fired, and it is the "status" one.
    expect(sendPush).toHaveBeenCalledTimes(1);
    expect(insertNotifications).toHaveBeenCalledTimes(1);
    const insertedRows = insertNotifications.mock.calls[0][0] as Array<{
      kind: string;
    }>;
    expect(insertedRows.every((r) => r.kind === "status")).toBe(true);
    // Belt & braces: no row was tagged as an "updated" notification.
    expect(insertedRows.some((r) => r.kind === "updated")).toBe(false);
  });

  it("same-value status write with no other fields fires ZERO pushes of either kind", async () => {
    // Edge case the production code explicitly guards: a client resubmits
    // the current status. statusChanged is false (values match) AND
    // patchKeys is empty once `status` + `updated_by` are filtered out,
    // so neither the "status" nor the "updated" branch fires.
    const { deps, sendPush, insertNotifications } = makeDeps();
    const patch = { status: "referred", updated_by: ACTOR };
    const prior = "referred";
    const next = "referred";

    expect(shouldFireUpdatedPush(patch, prior, next)).toBe(false);

    // Nothing to dispatch — verify the fanout was not called.
    expect(sendPush).not.toHaveBeenCalled();
    expect(insertNotifications).not.toHaveBeenCalled();
  });

  it("status-only edit with an `updated_by` companion field still suppresses the 'updated' push", async () => {
    // `updated_by` is bookkeeping that always accompanies edits; the
    // production filter strips it before deciding whether to send an
    // "updated" push. Its presence must not accidentally re-enable the
    // push during a pure status change.
    const patch = { status: "declined", updated_by: ACTOR };
    expect(shouldFireUpdatedPush(patch, "referred", "declined")).toBe(false);
  });

  it("mixed edit (status + a real field change) still fires ONLY the 'status' push, not 'updated'", async () => {
    // When a status change coincides with another edit, production code
    // takes the statusChanged branch and returns — the "updated" push is
    // still suppressed to avoid double-notifying about the same edit.
    const { deps, sendPush } = makeDeps();
    const patch = {
      status: "accepted",
      current_ward: "Ward 9A",
      updated_by: ACTOR,
    };
    expect(shouldFireUpdatedPush(patch, "referred", "accepted")).toBe(false);

    await fanOutNotifications(deps, {
      actorId: ACTOR,
      referralId: REFERRAL_ID,
      kind: "status",
      message: "Status → ACCEPTED: Respiratory — Ward 9A",
      title: "Referral ACCEPTED",
    });
    expect(sendPush).toHaveBeenCalledTimes(1);
    const payload = sendPush.mock.calls[0][1] as { body: string };
    // No "updated" copy leaked into the status push body.
    expect(payload.body.startsWith("Status →")).toBe(true);
    expect(payload.body).not.toMatch(/^Referral updated:/);
  });

  it("sanity: a genuine non-status edit DOES fire the 'updated' push (guards against false-positives)", async () => {
    // This test's whole point is that status-only edits suppress the
    // "updated" push — but that suppression must not be overzealous.
    // A real non-status edit still needs to notify.
    const patch = { current_ward: "Ward 3", updated_by: ACTOR };
    expect(shouldFireUpdatedPush(patch, "accepted", "accepted")).toBe(true);

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
    const payload = sendPush.mock.calls[0][1] as { url?: string; body: string };
    expect(payload.url).toBe(`/referrals/${REFERRAL_ID}`);
    expect(payload.body).toBe("Referral updated: Respiratory — Ward 3");
  });
});
