import { describe, it, expect, vi } from "vitest";
import {
  fanOutNotifications,
  type FanOutDeps,
  type ProfileRow,
  type PushSubRow,
  type RoleRow,
} from "./notification-fanout";

/**
 * Integration test: a status-only referral update produces exactly one
 * "status" push AND that push carries the `/referrals/{id}` deep link,
 * so tapping the notification opens the updated referral.
 *
 * The `updateReferral` server function (see `src/lib/referrals.functions.ts`)
 * calls `fanOutNotifications` for a pure status transition WITHOUT
 * passing an explicit `url` — it relies on the fanout default:
 *
 *   url: args.url ?? `/referrals/${args.referralId}`
 *
 * If a future refactor ever tightens fanout to require an explicit url,
 * or drops the default, users would tap status pushes and land on the
 * inbox instead of the referral. This spec locks the deep-link contract
 * for the status branch.
 */

const ACTOR = "00000000-0000-0000-0000-0000000000a1";
const CLIN_ON = "00000000-0000-0000-0000-0000000000b1";
const ADMIN_ON = "00000000-0000-0000-0000-0000000000c1";
const REFERRAL_ID = "9f9f9f9f-1111-4222-8333-444444444444";
const EXPECTED_URL = `/referrals/${REFERRAL_ID}`;

const ROLES: RoleRow[] = [
  { user_id: ACTOR, role: "clinician" },
  { user_id: CLIN_ON, role: "clinician" },
  { user_id: ADMIN_ON, role: "admin" },
];

const PROFILES: ProfileRow[] = [
  { id: ACTOR, is_at_work: true },
  { id: CLIN_ON, is_at_work: true },
  { id: ADMIN_ON, is_at_work: true },
];

const SUBS: PushSubRow[] = [
  { user_id: CLIN_ON, endpoint: "https://push/clin", p256dh: "k", auth: "a" },
  { user_id: ADMIN_ON, endpoint: "https://push/admin", p256dh: "k", auth: "a" },
  // Actor's own device must never be self-pushed.
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
      return SUBS.filter((s) => set.has(s.user_id));
    }),
    insertNotifications,
    sendPush,
    deletePushSubs,
  };
  return { deps, sendPush, insertNotifications };
}

describe("updateReferral: status-only edit → single 'status' push carries /referrals/{id} deep link", () => {
  it("dispatches ONE push, kind=status, url=/referrals/{id}, tag=referral-{id}", async () => {
    const { deps, sendPush, insertNotifications } = makeDeps();

    // Mirror of the call `updateReferral` makes for a pure status
    // transition: url is NOT passed explicitly — fanout defaults it to
    // `/referrals/${referralId}`, which is the contract this test locks.
    const result = await fanOutNotifications(deps, {
      actorId: ACTOR,
      referralId: REFERRAL_ID,
      kind: "status",
      message: "Status → ACCEPTED: Respiratory — Ward 7B",
      title: "Referral ACCEPTED",
      // NOTE: no `url` — must default to /referrals/{id}.
    });

    // Exactly ONE push batch fired.
    expect(sendPush).toHaveBeenCalledTimes(1);

    const [subsSent, payload] = sendPush.mock.calls[0] as [
      PushSubRow[],
      { url?: string; body: string; title?: string; tag?: string },
    ];

    // Deep link points at the updated referral (defaulted by fanout).
    expect(payload.url).toBe(EXPECTED_URL);
    expect(payload.url).toMatch(/^\/referrals\/[0-9a-f-]{36}$/);
    // Tag is per-referral so consecutive status pushes coalesce on the
    // same referral card rather than stacking.
    expect(payload.tag).toBe(`referral-${REFERRAL_ID}`);

    // Copy is the status message; not the "updated" branch's copy.
    expect(payload.title).toBe("Referral ACCEPTED");
    expect(payload.body).toBe("Status → ACCEPTED: Respiratory — Ward 7B");
    expect(payload.body).not.toMatch(/^Referral updated:/);

    // Recipients: at-work admin + clinician only. Actor excluded.
    const endpoints = subsSent.map((s) => s.endpoint).sort();
    expect(endpoints).toEqual(
      ["https://push/admin", "https://push/clin"].sort(),
    );
    expect(endpoints).not.toContain("https://push/actor");

    // In-app rows tagged `status`, one per recipient, all pointing at
    // the same referral so the inbox link matches the push deep link.
    expect(insertNotifications).toHaveBeenCalledTimes(1);
    const rows = insertNotifications.mock.calls[0][0] as Array<{
      user_id: string;
      referral_id: string;
      kind: string;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.kind === "status")).toBe(true);
    expect(rows.every((r) => r.referral_id === REFERRAL_ID)).toBe(true);
    expect(rows.map((r) => r.user_id).sort()).toEqual(
      [CLIN_ON, ADMIN_ON].sort(),
    );

    expect(result.pushSent).toBe(2);
    expect(result.recipientIds.sort()).toEqual([CLIN_ON, ADMIN_ON].sort());
  });

  it("deep link matches the referral id byte-for-byte even for varied ids", async () => {
    // Guards against a regression where the deep link was hard-coded or
    // built from stale state rather than the current referralId.
    const OTHER_ID = "01234567-89ab-cdef-0123-456789abcdef";
    const { deps, sendPush } = makeDeps();

    await fanOutNotifications(deps, {
      actorId: ACTOR,
      referralId: OTHER_ID,
      kind: "status",
      message: "Status → DECLINED: Cardiology — CCU",
      title: "Referral DECLINED",
    });

    expect(sendPush).toHaveBeenCalledTimes(1);
    const payload = sendPush.mock.calls[0][1] as { url?: string; tag?: string };
    expect(payload.url).toBe(`/referrals/${OTHER_ID}`);
    expect(payload.tag).toBe(`referral-${OTHER_ID}`);
  });
});
