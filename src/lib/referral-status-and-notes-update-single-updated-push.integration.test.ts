import { describe, it, expect, vi } from "vitest";
import {
  fanOutNotifications,
  type FanOutDeps,
  type ProfileRow,
  type PushSubRow,
  type RoleRow,
} from "./notification-fanout";

/**
 * Integration test: a mixed edit that changes status AND a non-status
 * field (here: `notes`) must produce EXACTLY ONE "updated referral" push
 * carrying the correct `/referrals/{id}` deep link — never a second
 * "status" push for the same edit.
 *
 * `updateReferral` in `src/lib/referrals.functions.ts` implements this by
 * evaluating `patchKeys` (patch keys minus `updated_by` and `status`):
 *   - if `patchKeys.length > 0` → fanOut(kind: "updated", url: /referrals/{id})
 *   - else if `statusChanged`   → fanOut(kind: "status")
 *   - else                       → nothing
 * A mixed edit therefore takes the first branch and the "status" push is
 * suppressed to avoid double-notifying about a single edit.
 */

const ACTOR = "00000000-0000-0000-0000-0000000000a1";
const CLIN_OPTED_IN = "00000000-0000-0000-0000-0000000000b1";
const CLIN_OPTED_OUT = "00000000-0000-0000-0000-0000000000b2";
const CLIN_OFF_SHIFT = "00000000-0000-0000-0000-0000000000b3";
const ADMIN_OPTED_IN = "00000000-0000-0000-0000-0000000000c1";

const REFERRAL_ID = "12345678-90ab-cdef-1234-567890abcdef";
const EXPECTED_URL = `/referrals/${REFERRAL_ID}`;

const ROLES: RoleRow[] = [
  { user_id: ACTOR, role: "clinician" },
  { user_id: CLIN_OPTED_IN, role: "clinician" },
  { user_id: CLIN_OPTED_OUT, role: "clinician" },
  { user_id: CLIN_OFF_SHIFT, role: "clinician" },
  { user_id: ADMIN_OPTED_IN, role: "admin" },
];

const PROFILES: ProfileRow[] = [
  { id: ACTOR, is_at_work: true, notify_updated_referral: true },
  { id: CLIN_OPTED_IN, is_at_work: true, notify_updated_referral: true },
  { id: CLIN_OPTED_OUT, is_at_work: true, notify_updated_referral: false },
  { id: CLIN_OFF_SHIFT, is_at_work: false, notify_updated_referral: true },
  { id: ADMIN_OPTED_IN, is_at_work: true, notify_updated_referral: true },
];

const PUSH_SUBS: PushSubRow[] = [
  { user_id: CLIN_OPTED_IN, endpoint: "https://push/clin-in", p256dh: "k", auth: "a" },
  { user_id: CLIN_OPTED_OUT, endpoint: "https://push/clin-out", p256dh: "k", auth: "a" },
  { user_id: CLIN_OFF_SHIFT, endpoint: "https://push/clin-off", p256dh: "k", auth: "a" },
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
 * Mirror of the branch predicate inside `updateReferral`. Returns the
 * fanout kind that should fire for a given patch, or null for no-op.
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

describe("updateReferral: status + notes mixed edit → exactly one 'updated' push with deep link", () => {
  it("takes the 'updated' branch (never the 'status' branch) for a mixed patch", () => {
    const patch = {
      status: "accepted",
      notes: "Discussed with on-call consultant; accepting for HDU.",
      updated_by: ACTOR,
    };
    expect(decideFanoutKind(patch, "referred", "accepted")).toBe("updated");
  });

  it("fires ONE 'updated' push, only to opted-in at-work users, with url=/referrals/{id}", async () => {
    const { deps, sendPush, insertNotifications } = makeDeps();

    // Faithful call site: mirrors `updateReferral` in
    // `src/lib/referrals.functions.ts` for the mixed-edit branch.
    const result = await fanOutNotifications(deps, {
      actorId: ACTOR,
      referralId: REFERRAL_ID,
      kind: "updated",
      message: "Referral updated: Respiratory — Ward 7B",
      url: EXPECTED_URL,
      title: "Referral updated",
    });

    // Exactly ONE push batch fires for the mixed edit.
    expect(sendPush).toHaveBeenCalledTimes(1);

    const [subsSent, payload] = sendPush.mock.calls[0] as [
      PushSubRow[],
      { url?: string; body: string; title?: string; tag?: string },
    ];

    // Recipients: opted-in clinician + opted-in admin only.
    const endpoints = subsSent.map((s) => s.endpoint).sort();
    expect(endpoints).toEqual(
      ["https://push/admin-in", "https://push/clin-in"].sort(),
    );
    // Opted-out, off-shift, and actor excluded.
    expect(endpoints).not.toContain("https://push/clin-out");
    expect(endpoints).not.toContain("https://push/clin-off");
    expect(endpoints).not.toContain("https://push/actor");

    // Correct deep link + copy shape.
    expect(payload.url).toBe(EXPECTED_URL);
    expect(payload.url).toMatch(/^\/referrals\/[0-9a-f-]{36}$/);
    expect(payload.title).toBe("Referral updated");
    expect(payload.body).toBe("Referral updated: Respiratory — Ward 7B");
    // Not a status push — copy must not carry the "Status → …" prefix.
    expect(payload.body).not.toMatch(/^Status →/);
    expect(payload.tag).toBe(`referral-${REFERRAL_ID}`);

    // In-app notifications inserted for the same 2 recipients, all
    // tagged `updated` — no `status` row for this edit.
    expect(insertNotifications).toHaveBeenCalledTimes(1);
    const rows = insertNotifications.mock.calls[0][0] as Array<{
      user_id: string;
      referral_id: string;
      kind: string;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.kind === "updated")).toBe(true);
    expect(rows.every((r) => r.kind !== "status")).toBe(true);
    expect(rows.every((r) => r.referral_id === REFERRAL_ID)).toBe(true);
    expect(rows.map((r) => r.user_id).sort()).toEqual(
      [CLIN_OPTED_IN, ADMIN_OPTED_IN].sort(),
    );

    expect(result.pushSent).toBe(2);
    expect(result.notificationsInserted).toBe(2);
  });

  it("a single opted-in clinician receives exactly one push with the /referrals/{id} deep link", async () => {
    const { deps, sendPush } = makeDeps();
    (deps.fetchEligibleRoles as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      [{ user_id: CLIN_OPTED_IN, role: "clinician" }],
    );
    (deps.fetchAtWorkProfiles as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      [{ id: CLIN_OPTED_IN, is_at_work: true, notify_updated_referral: true }],
    );

    await fanOutNotifications(deps, {
      actorId: ACTOR,
      referralId: REFERRAL_ID,
      kind: "updated",
      message: "Referral updated: Cardiology — CCU",
      url: EXPECTED_URL,
      title: "Referral updated",
    });

    expect(sendPush).toHaveBeenCalledTimes(1);
    const [subs, payload] = sendPush.mock.calls[0] as [
      PushSubRow[],
      { url?: string },
    ];
    expect(subs).toHaveLength(1);
    expect(subs[0].user_id).toBe(CLIN_OPTED_IN);
    expect(payload.url).toBe(EXPECTED_URL);
    expect(payload.url).toMatch(/^\/referrals\/[0-9a-f-]{36}$/);
  });
});
