import { describe, it, expect, vi } from "vitest";
import {
  fanOutNotifications,
  type FanOutDeps,
  type ProfileRow,
  type PushSubRow,
  type RoleRow,
} from "./notification-fanout";

/**
 * Integration test: an existing referral is updated (non-status patch).
 * `updateReferral` in `src/lib/referrals.functions.ts` fans out with
 * `kind: "updated"` and `url: /referrals/${row.id}`. Clinicians with the
 * per-user `notify_updated_referral` preference enabled must receive
 * EXACTLY ONE push carrying that deep link; clinicians who opted out and
 * off-shift users must not.
 */

const ACTOR = "00000000-0000-0000-0000-0000000000a1";
const CLIN_OPTED_IN = "00000000-0000-0000-0000-0000000000b1";
const CLIN_OPTED_OUT = "00000000-0000-0000-0000-0000000000b2";
const CLIN_OFF_SHIFT = "00000000-0000-0000-0000-0000000000b3";
const ADMIN_OPTED_IN = "00000000-0000-0000-0000-0000000000c1";

const REFERRAL_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
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

describe("updateReferral flow — notify_updated_referral opt-in receives one push with deep link", () => {
  it("dispatches exactly one push batch, only to opted-in at-work users, with url=/referrals/{id}", async () => {
    const { deps, sendPush, insertNotifications } = makeDeps();

    // Mirrors the call inside `updateReferral` for a non-status patch:
    // fanOutNotifications({ kind: "updated", message, url: `/referrals/${row.id}` })
    const result = await fanOutNotifications(deps, {
      actorId: ACTOR,
      referralId: REFERRAL_ID,
      kind: "updated",
      message: "Referral updated: Respiratory — Ward 7B",
      url: EXPECTED_URL,
    });

    // Exactly ONE push batch fired.
    expect(sendPush).toHaveBeenCalledTimes(1);

    const [subsSent, payload] = sendPush.mock.calls[0] as [
      PushSubRow[],
      { url?: string; body: string; tag?: string },
    ];

    // Recipients: opted-in clinician + opted-in admin only.
    const endpoints = subsSent.map((s) => s.endpoint).sort();
    expect(endpoints).toEqual(
      ["https://push/admin-in", "https://push/clin-in"].sort(),
    );
    // Opted-out, off-shift, and actor's own device excluded.
    expect(endpoints).not.toContain("https://push/clin-out");
    expect(endpoints).not.toContain("https://push/clin-off");
    expect(endpoints).not.toContain("https://push/actor");

    // Correct deep link back to the updated referral.
    expect(payload.url).toBe(EXPECTED_URL);
    expect(payload.tag).toBe(`referral-${REFERRAL_ID}`);
    expect(payload.body).toBe("Referral updated: Respiratory — Ward 7B");

    // In-app notifications inserted for the same 2 recipients, all kind=updated.
    expect(insertNotifications).toHaveBeenCalledTimes(1);
    const rows = insertNotifications.mock.calls[0][0] as Array<{
      user_id: string;
      referral_id: string;
      kind: string;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.kind === "updated")).toBe(true);
    expect(rows.every((r) => r.referral_id === REFERRAL_ID)).toBe(true);
    expect(rows.map((r) => r.user_id).sort()).toEqual(
      [CLIN_OPTED_IN, ADMIN_OPTED_IN].sort(),
    );

    expect(result.pushSent).toBe(2);
    expect(result.notificationsInserted).toBe(2);
    expect(result.recipientIds.sort()).toEqual(
      [CLIN_OPTED_IN, ADMIN_OPTED_IN].sort(),
    );
  });

  it("a single opted-in clinician receives exactly one push with the correct deep link", async () => {
    const { deps, sendPush } = makeDeps();
    // Narrow the world to one eligible opted-in clinician.
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
    });

    expect(sendPush).toHaveBeenCalledTimes(1);
    const [subs, payload] = sendPush.mock.calls[0] as [
      PushSubRow[],
      { url?: string },
    ];
    expect(subs).toHaveLength(1);
    expect(subs[0].user_id).toBe(CLIN_OPTED_IN);
    expect(subs[0].endpoint).toBe("https://push/clin-in");
    expect(payload.url).toBe(EXPECTED_URL);
    expect(payload.url).toMatch(/^\/referrals\/[0-9a-f-]{36}$/);
  });
});
