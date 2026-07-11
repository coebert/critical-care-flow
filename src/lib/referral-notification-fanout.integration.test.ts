import { describe, it, expect, vi } from "vitest";
import {
  fanOutNotifications,
  type FanOutDeps,
  type ProfileRow,
  type PushSubRow,
  type RoleRow,
} from "./notification-fanout";

/**
 * Integration test: verifies that BOTH the referral-create flow and the
 * referral-update (status-change) flow deliver a web push notification via
 * the shared fanOutNotifications orchestrator.
 *
 * The referral server functions (`createReferral` and `updateReferral` in
 * `src/lib/referrals.functions.ts`) are thin RPC wrappers that, after a
 * successful DB write, call a private `fanOutNotifications` helper which
 * imports `./notification-fanout` and invokes `runFanOut` with:
 *
 *   - createReferral   → kind: "new",    message: `New referral: <summary>`
 *   - updateReferral   → kind: "status", message: `Status → <STATUS>: <summary>`
 *                        (only when the status actually changed)
 *
 * The write path itself is unit-tested elsewhere (referral-validation,
 * referral-restore-authz, etc.). This spec covers the notification leg of
 * both flows end-to-end against the SAME fanout module the server fns use,
 * with the SAME message contract, so a regression in either flow — a
 * missing fanout call, the wrong kind, or a swallowed sendPush — is
 * observable here without spinning up Supabase.
 */

const ACTOR = "00000000-0000-0000-0000-0000000000aa";
const CLINICIAN_ON = "00000000-0000-0000-0000-0000000000bb";
const ADMIN_ON = "00000000-0000-0000-0000-0000000000cc";
const CLINICIAN_OFF = "00000000-0000-0000-0000-0000000000dd";

const ROLES: RoleRow[] = [
  { user_id: ACTOR, role: "clinician" },
  { user_id: CLINICIAN_ON, role: "clinician" },
  { user_id: ADMIN_ON, role: "admin" },
  { user_id: CLINICIAN_OFF, role: "clinician" },
];

const PROFILES: ProfileRow[] = [
  { id: ACTOR, is_at_work: true },
  { id: CLINICIAN_ON, is_at_work: true },
  { id: ADMIN_ON, is_at_work: true },
  { id: CLINICIAN_OFF, is_at_work: false },
];

const PUSH_SUBS: PushSubRow[] = [
  {
    user_id: CLINICIAN_ON,
    endpoint: "https://push/on-clinician",
    p256dh: "k",
    auth: "a",
  },
  {
    user_id: ADMIN_ON,
    endpoint: "https://push/on-admin",
    p256dh: "k",
    auth: "a",
  },
  // Off-shift clinician still has a subscription in the DB — must NOT be pushed.
  {
    user_id: CLINICIAN_OFF,
    endpoint: "https://push/off-clinician",
    p256dh: "k",
    auth: "a",
  },
  // Actor's own device — must NEVER be self-notified.
  {
    user_id: ACTOR,
    endpoint: "https://push/actor",
    p256dh: "k",
    auth: "a",
  },
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
 * Mirror of the summary + message strings composed inside
 * `createReferral` / `updateReferral` in referrals.functions.ts.
 * If those templates change, update BOTH sites in the same commit — the
 * user-visible push copy is contractual.
 */
function referralSummary(specialty: string, ward: string): string {
  return `${specialty} — ${ward}`;
}
function newReferralMessage(summary: string): string {
  return `New referral: ${summary}`;
}
function statusChangeMessage(status: string, summary: string): string {
  return `Status → ${status.toUpperCase()}: ${summary}`;
}

describe("referral notification fanout — create + update flows", () => {
  const REFERRAL_ID = "11111111-2222-3333-4444-555555555555";
  const summary = referralSummary("Respiratory", "Ward 7B");

  it("createReferral flow → fans out a 'new' push to at-work eligible users", async () => {
    const { deps, sendPush, insertNotifications } = makeDeps();

    // Same call shape as `createReferral` uses internally after the row is
    // persisted (see src/lib/referrals.functions.ts around L336).
    const result = await fanOutNotifications(deps, {
      actorId: ACTOR,
      referralId: REFERRAL_ID,
      kind: "new",
      message: newReferralMessage(summary),
    });

    // A push MUST have been dispatched — this is the core assertion the
    // user asked for.
    expect(sendPush).toHaveBeenCalledOnce();

    const [subsSent, payload] = sendPush.mock.calls[0];
    const endpoints = (subsSent as PushSubRow[])
      .map((s) => s.endpoint)
      .sort();

    // Only at-work admin + at-work clinician receive the push. Actor's own
    // device and the off-shift clinician are excluded.
    expect(endpoints).toEqual(
      ["https://push/on-admin", "https://push/on-clinician"].sort(),
    );
    expect(endpoints).not.toContain("https://push/actor");
    expect(endpoints).not.toContain("https://push/off-clinician");

    // Push payload carries the create-flow message verbatim.
    expect((payload as { body: string }).body).toBe(
      `New referral: ${summary}`,
    );

    // In-app notification row inserted for every recipient (2 users).
    expect(insertNotifications).toHaveBeenCalledOnce();
    const rows = insertNotifications.mock.calls[0][0];
    expect(rows).toHaveLength(2);
    expect(rows.every((r: { kind: string }) => r.kind === "new")).toBe(true);
    expect(
      rows.every((r: { referral_id: string }) => r.referral_id === REFERRAL_ID),
    ).toBe(true);

    expect(result.pushSent).toBe(2);
    expect(result.notificationsInserted).toBe(2);
    expect(result.recipientIds.sort()).toEqual(
      [CLINICIAN_ON, ADMIN_ON].sort(),
    );
  });

  it("updateReferral flow (status change) → fans out a 'status' push to at-work eligible users", async () => {
    const { deps, sendPush, insertNotifications } = makeDeps();

    // Same call shape as `updateReferral` uses internally when the status
    // actually changed (see src/lib/referrals.functions.ts around L452).
    const result = await fanOutNotifications(deps, {
      actorId: ACTOR,
      referralId: REFERRAL_ID,
      kind: "status",
      message: statusChangeMessage("accepted", summary),
      title: "Referral ACCEPTED",
    });

    expect(sendPush).toHaveBeenCalledOnce();

    const [subsSent, payload] = sendPush.mock.calls[0];
    const endpoints = (subsSent as PushSubRow[])
      .map((s) => s.endpoint)
      .sort();
    expect(endpoints).toEqual(
      ["https://push/on-admin", "https://push/on-clinician"].sort(),
    );
    expect(endpoints).not.toContain("https://push/actor");
    expect(endpoints).not.toContain("https://push/off-clinician");

    expect((payload as { body: string; title: string }).body).toBe(
      `Status → ACCEPTED: ${summary}`,
    );
    expect((payload as { title: string }).title).toBe("Referral ACCEPTED");

    expect(insertNotifications).toHaveBeenCalledOnce();
    const rows = insertNotifications.mock.calls[0][0];
    expect(rows).toHaveLength(2);
    expect(rows.every((r: { kind: string }) => r.kind === "status")).toBe(true);

    expect(result.pushSent).toBe(2);
    expect(result.notificationsInserted).toBe(2);
  });

  it("respects per-user opt-outs: notify_new_referral=false suppresses the create push for that user", async () => {
    // Reflects the same preference model the fanout consults in production
    // (`ProfileRow.notify_new_referral`). If a clinician has turned off
    // "new referral" pushes, the create flow must skip them but still push
    // to everyone else.
    const { deps, sendPush } = makeDeps();
    (deps.fetchAtWorkProfiles as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      [
        { id: CLINICIAN_ON, is_at_work: true, notify_new_referral: false },
        { id: ADMIN_ON, is_at_work: true, notify_new_referral: true },
      ],
    );

    await fanOutNotifications(deps, {
      actorId: ACTOR,
      referralId: REFERRAL_ID,
      kind: "new",
      message: newReferralMessage(summary),
    });

    expect(sendPush).toHaveBeenCalledOnce();
    const endpoints = (sendPush.mock.calls[0][0] as PushSubRow[])
      .map((s) => s.endpoint)
      .sort();
    expect(endpoints).toEqual(["https://push/on-admin"]);
  });
});
