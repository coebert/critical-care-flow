import { describe, it, expect, vi } from "vitest";
import {
  fanOutNotifications,
  selectRecipients,
  type FanOutDeps,
  type NotificationKind,
  type ProfileRow,
  type PushSubRow,
  type RoleRow,
} from "./notification-fanout";

/**
 * Preference matrix coverage for new / updated referral notifications.
 *
 * Each recipient in this fixture is at work with a clinician role and one
 * push subscription. Only their per-preference flags differ. The tests
 * assert the exact set of users who receive an in-app notification AND a
 * web-push for each event kind (`new`, `updated`), for both the default
 * (prefs undefined → treated as ON) and every explicit ON/OFF combination.
 */

const ACTOR = "00000000-0000-0000-0000-0000000000aa";

interface Persona {
  id: string;
  label: string;
  prefs: Partial<
    Pick<
      ProfileRow,
      "notify_new_referral" | "notify_updated_referral" | "notify_notes" | "notify_status"
    >
  >;
}

const PERSONAS: Persona[] = [
  { id: "u-default", label: "default (all prefs undefined)", prefs: {} },
  {
    id: "u-both-on",
    label: "explicit new=ON, updated=ON",
    prefs: { notify_new_referral: true, notify_updated_referral: true },
  },
  {
    id: "u-new-off",
    label: "new=OFF, updated=ON",
    prefs: { notify_new_referral: false, notify_updated_referral: true },
  },
  {
    id: "u-updated-off",
    label: "new=ON, updated=OFF",
    prefs: { notify_new_referral: true, notify_updated_referral: false },
  },
  {
    id: "u-both-off",
    label: "new=OFF, updated=OFF",
    prefs: { notify_new_referral: false, notify_updated_referral: false },
  },
];

function buildDeps() {
  const roles: RoleRow[] = PERSONAS.map((p) => ({ user_id: p.id, role: "clinician" }));
  const profiles: ProfileRow[] = PERSONAS.map((p) => ({
    id: p.id,
    is_at_work: true,
    ...p.prefs,
  }));
  const subs: PushSubRow[] = PERSONAS.map((p) => ({
    user_id: p.id,
    endpoint: `https://push/${p.id}`,
    p256dh: "k",
    auth: "a",
  }));

  const insertNotifications = vi.fn().mockResolvedValue(undefined);
  const sendPush = vi.fn().mockResolvedValue({ goneEndpoints: [] });
  const deletePushSubs = vi.fn().mockResolvedValue(undefined);

  const deps: FanOutDeps = {
    fetchEligibleRoles: async (actorId) => roles.filter((r) => r.user_id !== actorId),
    fetchAtWorkProfiles: async (ids) => {
      const set = new Set(ids);
      return profiles.filter((p) => set.has(p.id) && p.is_at_work);
    },
    fetchPushSubs: async (ids) => {
      const set = new Set(ids);
      return subs.filter((s) => set.has(s.user_id));
    },
    insertNotifications,
    sendPush,
    deletePushSubs,
  };
  return { deps, insertNotifications, sendPush };
}

function idsFromInsert(insertMock: ReturnType<typeof vi.fn>): string[] {
  if (!insertMock.mock.calls.length) return [];
  const rows = insertMock.mock.calls[0][0] as Array<{ user_id: string }>;
  return rows.map((r) => r.user_id).sort();
}

function endpointsFromPush(sendMock: ReturnType<typeof vi.fn>): string[] {
  if (!sendMock.mock.calls.length) return [];
  const subs = sendMock.mock.calls[0][0] as PushSubRow[];
  return subs.map((s) => s.endpoint).sort();
}

describe("selectRecipients honours per-kind preferences", () => {
  const profiles: ProfileRow[] = PERSONAS.map((p) => ({
    id: p.id,
    is_at_work: true,
    ...p.prefs,
  }));
  const roles: RoleRow[] = PERSONAS.map((p) => ({ user_id: p.id, role: "clinician" }));

  it("kind='new' excludes users with notify_new_referral === false", () => {
    const ids = selectRecipients(roles, profiles, ACTOR, "new").sort();
    expect(ids).toEqual(["u-both-on", "u-default", "u-updated-off"].sort());
    expect(ids).not.toContain("u-new-off");
    expect(ids).not.toContain("u-both-off");
  });

  it("kind='updated' excludes users with notify_updated_referral === false", () => {
    const ids = selectRecipients(roles, profiles, ACTOR, "updated").sort();
    expect(ids).toEqual(["u-both-on", "u-default", "u-new-off"].sort());
    expect(ids).not.toContain("u-updated-off");
    expect(ids).not.toContain("u-both-off");
  });

  it("undefined preferences default to opted-in for both kinds", () => {
    const only = [{ id: "u-default", is_at_work: true }];
    const roleRow = [{ user_id: "u-default", role: "clinician" }];
    expect(selectRecipients(roleRow, only, ACTOR, "new")).toEqual(["u-default"]);
    expect(selectRecipients(roleRow, only, ACTOR, "updated")).toEqual(["u-default"]);
  });
});

describe.each<{ kind: NotificationKind; expected: string[] }>([
  { kind: "new", expected: ["u-both-on", "u-default", "u-updated-off"] },
  { kind: "updated", expected: ["u-both-on", "u-default", "u-new-off"] },
])("fanOutNotifications: kind=$kind", ({ kind, expected }) => {
  it(`inserts in-app notifications only for users opted-in to '${kind}'`, async () => {
    const { deps, insertNotifications } = buildDeps();
    const result = await fanOutNotifications(deps, {
      actorId: ACTOR,
      referralId: "ref-1",
      kind,
      message: `${kind} referral`,
    });

    expect(result.recipientIds.sort()).toEqual([...expected].sort());
    expect(idsFromInsert(insertNotifications)).toEqual([...expected].sort());
  });

  it(`sends web push only to endpoints owned by users opted-in to '${kind}'`, async () => {
    const { deps, sendPush } = buildDeps();
    await fanOutNotifications(deps, {
      actorId: ACTOR,
      referralId: "ref-1",
      kind,
      message: `${kind} referral`,
    });

    const expectedEndpoints = expected.map((id) => `https://push/${id}`).sort();
    expect(endpointsFromPush(sendPush)).toEqual(expectedEndpoints);
  });
});

describe("fanOutNotifications: preference edge cases", () => {
  it("sends neither in-app nor push when every eligible user has the relevant pref OFF", async () => {
    const roles: RoleRow[] = [{ user_id: "solo", role: "clinician" }];
    const profiles: ProfileRow[] = [
      { id: "solo", is_at_work: true, notify_new_referral: false },
    ];
    const insertNotifications = vi.fn();
    const sendPush = vi.fn();
    const deps: FanOutDeps = {
      fetchEligibleRoles: async () => roles,
      fetchAtWorkProfiles: async () => profiles,
      fetchPushSubs: async () => [
        { user_id: "solo", endpoint: "https://push/solo", p256dh: "k", auth: "a" },
      ],
      insertNotifications,
      sendPush,
      deletePushSubs: vi.fn(),
    };

    const result = await fanOutNotifications(deps, {
      actorId: ACTOR,
      referralId: "ref-1",
      kind: "new",
      message: "new referral",
    });

    expect(result.recipientIds).toEqual([]);
    expect(insertNotifications).not.toHaveBeenCalled();
    expect(sendPush).not.toHaveBeenCalled();
  });

  it("a user with new=OFF still receives 'updated' events (prefs are independent)", async () => {
    const { deps, insertNotifications } = buildDeps();
    await fanOutNotifications(deps, {
      actorId: ACTOR,
      referralId: "ref-1",
      kind: "updated",
      message: "status change",
    });
    expect(idsFromInsert(insertNotifications)).toContain("u-new-off");
  });

  it("a user with updated=OFF still receives 'new' events (prefs are independent)", async () => {
    const { deps, insertNotifications } = buildDeps();
    await fanOutNotifications(deps, {
      actorId: ACTOR,
      referralId: "ref-1",
      kind: "new",
      message: "new referral",
    });
    expect(idsFromInsert(insertNotifications)).toContain("u-updated-off");
  });
});
