import { describe, it, expect, vi } from "vitest";
import {
  fanOutNotifications,
  selectRecipients,
  type FanOutDeps,
  type ProfileRow,
  type PushSubRow,
  type RoleRow,
} from "./notification-fanout";

/**
 * In-memory fixture modeling a small clinic:
 *
 *   actor        — the user performing the action (must never be notified)
 *   alice        — admin, at work, has push sub
 *   bob          — clinician, at work, has push sub on two devices
 *   carol        — clinician, OFF SHIFT, has push sub (must not be notified)
 *   dave         — admin, OFF SHIFT, no push sub
 *   erin         — clinician with NO at-work row at all (treated as off shift)
 *   frank        — unrelated user with no clinical role
 */
const USERS = {
  actor: "00000000-0000-0000-0000-000000000001",
  alice: "00000000-0000-0000-0000-000000000002",
  bob: "00000000-0000-0000-0000-000000000003",
  carol: "00000000-0000-0000-0000-000000000004",
  dave: "00000000-0000-0000-0000-000000000005",
  erin: "00000000-0000-0000-0000-000000000006",
  frank: "00000000-0000-0000-0000-000000000007",
};

const ROLES: RoleRow[] = [
  { user_id: USERS.actor, role: "clinician" },
  { user_id: USERS.alice, role: "admin" },
  { user_id: USERS.bob, role: "clinician" },
  { user_id: USERS.carol, role: "clinician" },
  { user_id: USERS.dave, role: "admin" },
  { user_id: USERS.erin, role: "clinician" },
  // frank has no clinical role
];

const PROFILES: ProfileRow[] = [
  { id: USERS.actor, is_at_work: true },
  { id: USERS.alice, is_at_work: true },
  { id: USERS.bob, is_at_work: true },
  { id: USERS.carol, is_at_work: false },
  { id: USERS.dave, is_at_work: false },
  { id: USERS.erin, is_at_work: false },
  { id: USERS.frank, is_at_work: true },
];

const PUSH_SUBS: PushSubRow[] = [
  { user_id: USERS.alice, endpoint: "https://push/alice-1", p256dh: "k", auth: "a" },
  { user_id: USERS.bob, endpoint: "https://push/bob-1", p256dh: "k", auth: "a" },
  { user_id: USERS.bob, endpoint: "https://push/bob-2", p256dh: "k", auth: "a" },
  // carol is OFF SHIFT — this subscription must NEVER receive a push.
  { user_id: USERS.carol, endpoint: "https://push/carol-1", p256dh: "k", auth: "a" },
  // actor — must NEVER be self-notified even though at work.
  { user_id: USERS.actor, endpoint: "https://push/actor-1", p256dh: "k", auth: "a" },
];

function makeDeps(overrides: Partial<FanOutDeps> = {}) {
  const insertNotifications = vi.fn().mockResolvedValue(undefined);
  const sendPush = vi.fn().mockResolvedValue({ goneEndpoints: [] });
  const deletePushSubs = vi.fn().mockResolvedValue(undefined);

  const deps: FanOutDeps = {
    fetchEligibleRoles: vi.fn(async (actorId: string) =>
      ROLES.filter(
        (r) =>
          (r.role === "admin" || r.role === "clinician") && r.user_id !== actorId,
      ),
    ),
    fetchAtWorkProfiles: vi.fn(async (ids: string[]) => {
      const set = new Set(ids);
      return PROFILES.filter((p) => set.has(p.id) && p.is_at_work === true);
    }),
    fetchPushSubs: vi.fn(async (ids: string[]) => {
      const set = new Set(ids);
      return PUSH_SUBS.filter((s) => set.has(s.user_id));
    }),
    insertNotifications,
    sendPush,
    deletePushSubs,
    ...overrides,
  };
  return { deps, insertNotifications, sendPush, deletePushSubs };
}

describe("selectRecipients", () => {
  it("includes only users who are both eligible AND at work", () => {
    const recipients = selectRecipients(ROLES, PROFILES, USERS.actor);
    expect(recipients.sort()).toEqual([USERS.alice, USERS.bob].sort());
  });

  it("excludes the actor even if they are at work and have a role", () => {
    const recipients = selectRecipients(ROLES, PROFILES, USERS.actor);
    expect(recipients).not.toContain(USERS.actor);
  });

  it("never includes an off-shift user even if they have an admin/clinician role", () => {
    const recipients = selectRecipients(ROLES, PROFILES, USERS.actor);
    expect(recipients).not.toContain(USERS.carol); // clinician, off shift
    expect(recipients).not.toContain(USERS.dave); // admin, off shift
    expect(recipients).not.toContain(USERS.erin); // clinician, off shift
  });

  it("excludes users without an admin/clinician role even if they are at work", () => {
    const recipients = selectRecipients(ROLES, PROFILES, USERS.actor);
    expect(recipients).not.toContain(USERS.frank);
  });

  it("dedupes users that hold multiple roles", () => {
    const dupRoles: RoleRow[] = [
      { user_id: USERS.alice, role: "admin" },
      { user_id: USERS.alice, role: "clinician" },
    ];
    const recipients = selectRecipients(
      dupRoles,
      [{ id: USERS.alice, is_at_work: true }],
      USERS.actor,
    );
    expect(recipients).toEqual([USERS.alice]);
  });
});

describe("fanOutNotifications", () => {
  it("inserts in-app notifications only for at-work eligible users", async () => {
    const { deps, insertNotifications } = makeDeps();
    const result = await fanOutNotifications(deps, {
      actorId: USERS.actor,
      referralId: "ref-1",
      kind: "new",
      message: "New referral",
    });

    expect(result.recipientIds.sort()).toEqual([USERS.alice, USERS.bob].sort());
    expect(insertNotifications).toHaveBeenCalledOnce();

    const rows = insertNotifications.mock.calls[0][0];
    const recipientIds = rows.map((r: any) => r.user_id).sort();
    expect(recipientIds).toEqual([USERS.alice, USERS.bob].sort());

    // Hard invariants for off-shift / actor / unrelated users:
    expect(recipientIds).not.toContain(USERS.carol);
    expect(recipientIds).not.toContain(USERS.dave);
    expect(recipientIds).not.toContain(USERS.erin);
    expect(recipientIds).not.toContain(USERS.actor);
    expect(recipientIds).not.toContain(USERS.frank);
  });

  it("sends web push only to subscriptions owned by at-work users", async () => {
    const { deps, sendPush } = makeDeps();
    await fanOutNotifications(deps, {
      actorId: USERS.actor,
      referralId: "ref-1",
      kind: "new",
      message: "New referral",
    });

    expect(sendPush).toHaveBeenCalledOnce();
    const [subsSent] = sendPush.mock.calls[0];
    const endpoints = subsSent.map((s: PushSubRow) => s.endpoint).sort();
    expect(endpoints).toEqual(
      ["https://push/alice-1", "https://push/bob-1", "https://push/bob-2"].sort(),
    );

    // The hard guarantee the user asked for:
    expect(endpoints).not.toContain("https://push/carol-1"); // off shift
    expect(endpoints).not.toContain("https://push/actor-1"); // actor's own device
  });

  it("sends NO push and inserts NO notifications when every eligible user is off shift", async () => {
    const allOff: ProfileRow[] = PROFILES.map((p) => ({ ...p, is_at_work: false }));
    const { deps, sendPush, insertNotifications } = makeDeps({
      fetchAtWorkProfiles: async (ids) =>
        allOff.filter((p) => ids.includes(p.id) && p.is_at_work),
    });

    const result = await fanOutNotifications(deps, {
      actorId: USERS.actor,
      referralId: "ref-1",
      kind: "updated",
      message: "Status changed",
    });

    expect(result.recipientIds).toEqual([]);
    expect(result.notificationsInserted).toBe(0);
    expect(insertNotifications).not.toHaveBeenCalled();
    expect(sendPush).not.toHaveBeenCalled();
  });

  it("never pushes to a subscription whose owner has just gone off shift mid-query (defense in depth)", async () => {
    // Simulate a race: profile query says only Alice is at work, but the push
    // subs query returns Bob's row as well. The orchestrator must filter Bob out
    // because he is not in the recipient set.
    const { deps, sendPush } = makeDeps({
      fetchAtWorkProfiles: async () => [{ id: USERS.alice, is_at_work: true }],
      fetchPushSubs: async () => PUSH_SUBS, // includes Bob, Carol, actor
    });

    await fanOutNotifications(deps, {
      actorId: USERS.actor,
      referralId: "ref-1",
      kind: "new",
      message: "New referral",
    });

    expect(sendPush).toHaveBeenCalledOnce();
    const [subsSent] = sendPush.mock.calls[0];
    const endpoints = subsSent.map((s: PushSubRow) => s.endpoint);
    expect(endpoints).toEqual(["https://push/alice-1"]);
  });

  it("prunes expired push endpoints reported by the push service", async () => {
    const { deps, deletePushSubs } = makeDeps({
      sendPush: vi
        .fn()
        .mockResolvedValue({ goneEndpoints: ["https://push/bob-2"] }),
    });

    const result = await fanOutNotifications(deps, {
      actorId: USERS.actor,
      referralId: "ref-1",
      kind: "new",
      message: "New referral",
    });

    expect(deletePushSubs).toHaveBeenCalledWith(["https://push/bob-2"]);
    expect(result.goneEndpointsCleared).toBe(1);
    expect(result.pushSent).toBe(2); // 3 subs sent, 1 expired
  });

  it("still inserts in-app notifications even if push delivery throws", async () => {
    const { deps, insertNotifications } = makeDeps({
      sendPush: vi.fn().mockRejectedValue(new Error("network down")),
    });

    const result = await fanOutNotifications(deps, {
      actorId: USERS.actor,
      referralId: "ref-1",
      kind: "new",
      message: "New referral",
    });

    expect(insertNotifications).toHaveBeenCalledOnce();
    expect(result.notificationsInserted).toBe(2);
    expect(result.pushSent).toBe(0);
  });
});
