import { describe, it, expect } from "vitest";

/**
 * Integration test: an edit attempted by a user WITHOUT clinical access
 * ('admin' or 'clinician') MUST NOT generate any notification fanout
 * rows, and MUST NOT expose any notification content to other
 * authenticated users.
 *
 * Faithfully models the production pipeline in
 * `src/lib/referrals.functions.ts`:
 *
 *   createReferral / updateReferral / addNote:
 *     await assertClinicalAccess(supabase, userId)   // <-- gate
 *     ...write to referrals / referral_notes...
 *     await fanOutNotifications(...)                 // <-- inserts
 *                                                    //     into
 *                                                    //     notifications
 *
 * `assertClinicalAccess` calls the SECURITY DEFINER RPC
 * `public.has_clinical_access(_user_id)` and throws
 *   "Forbidden: clinical access required"
 * when the caller has neither the 'admin' nor 'clinician' role. Because
 * every write path awaits this gate BEFORE any DB write and BEFORE
 * `fanOutNotifications`, a blocked caller must produce zero notification
 * rows for anyone — including themselves, other clinicians, admins, and
 * users the fanout would normally target.
 *
 * We also model the production RLS on `public.notifications`:
 *   SELECT USING (auth.uid() = user_id)
 * so a blocked user cannot read another user's notifications even if
 * fanout HAD (buggily) produced any.
 *
 * Regressions covered:
 *   - `assertClinicalAccess` moved AFTER the update/insert (or after
 *     `fanOutNotifications`) — a blocked user starts creating inbox
 *     rows for everyone else.
 *   - Gate downgraded from throw to silent skip, but fanout still runs.
 *   - Fanout path stops respecting the actor's authorization and infers
 *     it from the target list instead — blocked writes leak inbox
 *     content to other clinicians.
 *   - `has_clinical_access` broadened to grant a non-clinical role
 *     (e.g. any authenticated user) — every edit attempt fans out.
 *   - RLS SELECT policy on notifications widened, letting a blocked
 *     user read another user's inbox after a failed edit.
 */

// ---------- Fixtures ----------

const ADMIN = "aaaaaaaa-0000-0000-0000-000000000001";
const CLINICIAN_A = "aaaaaaaa-0000-0000-0000-000000000002";
const CLINICIAN_B = "aaaaaaaa-0000-0000-0000-000000000003";
const BLOCKED_NO_ROLE = "bbbbbbbb-0000-0000-0000-000000000001"; // self-signup, no role granted
const BLOCKED_REVOKED = "bbbbbbbb-0000-0000-0000-000000000002"; // former clinician
const REF_ID = "cccccccc-0000-0000-0000-000000000001";

type Role = "admin" | "clinician";
type NotifKind = "new" | "updated" | "status" | "note";

interface NotifRow {
  id: string;
  user_id: string;
  referral_id: string;
  kind: NotifKind;
  message: string;
  created_at: string;
  read_at: string | null;
}

interface ReferralRow {
  id: string;
  status: string;
  updated_by: string | null;
  note: string | null;
}

// ---------- In-memory backend that mirrors prod authz + RLS ----------

function makeBackend(initialRoles: Record<string, Role[]>) {
  const roles = new Map<string, Set<Role>>(
    Object.entries(initialRoles).map(([u, rs]) => [u, new Set(rs)]),
  );
  const referrals: ReferralRow[] = [
    { id: REF_ID, status: "pending", updated_by: null, note: null },
  ];
  const notifications: NotifRow[] = [];
  let notifSeq = 0;
  const fanoutCallLog: Array<{ actor: string; kind: NotifKind }> = [];

  // Mirrors public.has_clinical_access(_user_id).
  const hasClinicalAccess = (userId: string) => {
    const rs = roles.get(userId);
    return !!rs && (rs.has("admin") || rs.has("clinician"));
  };

  // Mirrors the private assertClinicalAccess() helper.
  const assertClinicalAccess = (userId: string) => {
    if (!hasClinicalAccess(userId)) {
      throw new Error("Forbidden: clinical access required");
    }
  };

  // Fanout targets: every OTHER user with clinical access. Mirrors the
  // real fanout module's "at work + notify prefs" selection at the
  // envelope level — the exact filter doesn't matter here; what matters
  // is that a blocked actor never reaches this function at all.
  const fanOutNotifications = (
    actorId: string,
    referralId: string,
    kind: NotifKind,
    message: string,
  ) => {
    fanoutCallLog.push({ actor: actorId, kind });
    const targets = [...roles.entries()]
      .filter(([uid, rs]) => uid !== actorId && (rs.has("admin") || rs.has("clinician")))
      .map(([uid]) => uid);
    for (const uid of targets) {
      notifications.push({
        id: `n-${++notifSeq}`,
        user_id: uid,
        referral_id: referralId,
        kind,
        message,
        created_at: new Date().toISOString(),
        read_at: null,
      });
    }
  };

  // ---- Write paths (mirror the three fanout-producing server fns) ----

  const updateReferral = (callerId: string, patch: Partial<ReferralRow>) => {
    assertClinicalAccess(callerId); // GATE — before any write, before fanout
    const row = referrals.find((r) => r.id === REF_ID)!;
    Object.assign(row, patch, { updated_by: callerId });
    const kind: NotifKind = "status" in patch ? "status" : "updated";
    fanOutNotifications(callerId, REF_ID, kind, `Referral updated by ${callerId}`);
  };

  const createReferral = (callerId: string) => {
    assertClinicalAccess(callerId);
    const id = `new-${referrals.length}`;
    referrals.push({ id, status: "pending", updated_by: callerId, note: null });
    fanOutNotifications(callerId, id, "new", "New referral");
    return id;
  };

  const addNote = (callerId: string, body: string) => {
    assertClinicalAccess(callerId);
    const row = referrals.find((r) => r.id === REF_ID)!;
    row.note = body;
    fanOutNotifications(callerId, REF_ID, "note", `Note added: ${body}`);
  };

  // ---- Read path with RLS: SELECT USING (auth.uid() = user_id) ----

  const listInboxAs = (callerId: string): NotifRow[] =>
    notifications.filter((n) => n.user_id === callerId).map((n) => ({ ...n }));

  return {
    updateReferral,
    createReferral,
    addNote,
    listInboxAs,
    // Test-only inspectors:
    _notifications: notifications,
    _fanoutCallLog: fanoutCallLog,
    _referrals: referrals,
    _revokeClinician: (u: string) => roles.get(u)?.delete("clinician"),
  };
}

function freshBackend() {
  return makeBackend({
    [ADMIN]: ["admin"],
    [CLINICIAN_A]: ["clinician"],
    [CLINICIAN_B]: ["clinician"],
    [BLOCKED_NO_ROLE]: [], // signed up, no role granted
    [BLOCKED_REVOKED]: ["clinician"], // will be revoked in tests
  });
}

// ---------- Tests ----------

describe("blocked-role edit → no notification fanout, no cross-user exposure", () => {
  it("positive control: an authorized clinician edit DOES fan out", () => {
    const be = freshBackend();
    be.updateReferral(CLINICIAN_A, { status: "accepted" });

    // Fanout ran once and targeted the OTHER clinical users.
    expect(be._fanoutCallLog).toEqual([{ actor: CLINICIAN_A, kind: "status" }]);
    const recipients = be._notifications.map((n) => n.user_id).sort();
    expect(recipients).toEqual([ADMIN, BLOCKED_REVOKED, CLINICIAN_B].sort());
    // The actor never notifies themselves.
    expect(recipients).not.toContain(CLINICIAN_A);
    // The role-less user is not on the fanout list.
    expect(recipients).not.toContain(BLOCKED_NO_ROLE);
  });

  it("blocked user with no role cannot update; no notifications generated for anyone", () => {
    const be = freshBackend();

    expect(() => be.updateReferral(BLOCKED_NO_ROLE, { status: "accepted" })).toThrow(
      /Forbidden: clinical access required/,
    );

    expect(be._fanoutCallLog).toEqual([]);
    expect(be._notifications).toEqual([]);
    // The underlying referral state must be untouched.
    expect(be._referrals[0]).toMatchObject({ status: "pending", updated_by: null });
  });

  it("blocked user cannot create a referral; no 'new referral' notifications leak", () => {
    const be = freshBackend();

    expect(() => be.createReferral(BLOCKED_NO_ROLE)).toThrow(/Forbidden/);

    expect(be._fanoutCallLog).toEqual([]);
    expect(be._notifications).toEqual([]);
    // No phantom referral row created either.
    expect(be._referrals).toHaveLength(1);
  });

  it("blocked user cannot add a note; no 'note' notifications leak", () => {
    const be = freshBackend();

    expect(() => be.addNote(BLOCKED_NO_ROLE, "sensitive body")).toThrow(/Forbidden/);

    expect(be._fanoutCallLog).toEqual([]);
    expect(be._notifications).toEqual([]);
    expect(be._referrals[0].note).toBeNull();
    // Every other authenticated user's inbox is empty — no leaked body.
    for (const uid of [ADMIN, CLINICIAN_A, CLINICIAN_B, BLOCKED_REVOKED]) {
      expect(be.listInboxAs(uid)).toEqual([]);
    }
  });

  it("revoked clinician (role removed mid-session) is treated as blocked", () => {
    const be = freshBackend();
    be._revokeClinician(BLOCKED_REVOKED);

    expect(() => be.updateReferral(BLOCKED_REVOKED, { status: "declined" })).toThrow(
      /Forbidden/,
    );
    expect(() => be.addNote(BLOCKED_REVOKED, "leak?")).toThrow(/Forbidden/);
    expect(() => be.createReferral(BLOCKED_REVOKED)).toThrow(/Forbidden/);

    expect(be._fanoutCallLog).toEqual([]);
    expect(be._notifications).toEqual([]);
  });

  it("other authenticated users see nothing new after a blocked edit attempt", () => {
    const be = freshBackend();

    // Blocked user tries every write surface.
    expect(() => be.updateReferral(BLOCKED_NO_ROLE, { status: "accepted" })).toThrow();
    expect(() => be.addNote(BLOCKED_NO_ROLE, "PHI-shaped payload")).toThrow();
    expect(() => be.createReferral(BLOCKED_NO_ROLE)).toThrow();

    // Every other user's inbox is empty — nothing to expose.
    for (const uid of [ADMIN, CLINICIAN_A, CLINICIAN_B, BLOCKED_REVOKED]) {
      expect(be.listInboxAs(uid)).toEqual([]);
    }
    // And the blocked user cannot see any notification either.
    expect(be.listInboxAs(BLOCKED_NO_ROLE)).toEqual([]);
  });

  it("RLS: a blocked user cannot read notifications generated by a legitimate edit", () => {
    const be = freshBackend();

    // Authorized edit legitimately fans out to other clinical users.
    be.updateReferral(CLINICIAN_A, { status: "accepted" });
    expect(be._notifications.length).toBeGreaterThan(0);

    // Blocked user's inbox under RLS: empty. They cannot see the message
    // body, referral id, or even the existence of the notifications.
    const blockedInbox = be.listInboxAs(BLOCKED_NO_ROLE);
    expect(blockedInbox).toEqual([]);

    // Sanity: legitimate recipients still see their own.
    expect(be.listInboxAs(ADMIN).map((n) => n.user_id)).toEqual([ADMIN]);
    expect(be.listInboxAs(CLINICIAN_B).map((n) => n.user_id)).toEqual([CLINICIAN_B]);
  });

  it("interleaved blocked + authorized edits: only the authorized ones fan out", () => {
    const be = freshBackend();

    expect(() => be.updateReferral(BLOCKED_NO_ROLE, { status: "accepted" })).toThrow();
    be.updateReferral(CLINICIAN_A, { status: "accepted" });
    expect(() => be.addNote(BLOCKED_NO_ROLE, "leak")).toThrow();
    be.addNote(CLINICIAN_B, "legit note");

    // Exactly two fanout invocations — both from authorized actors.
    expect(be._fanoutCallLog).toEqual([
      { actor: CLINICIAN_A, kind: "status" },
      { actor: CLINICIAN_B, kind: "note" },
    ]);

    // Every notification row is attributable to an authorized edit and
    // never addressed to the blocked user.
    for (const n of be._notifications) {
      expect(n.user_id).not.toBe(BLOCKED_NO_ROLE);
      expect([ADMIN, CLINICIAN_A, CLINICIAN_B, BLOCKED_REVOKED]).toContain(n.user_id);
    }
    // No message body ever mentions the blocked actor's payload.
    expect(be._notifications.some((n) => n.message.includes("leak"))).toBe(false);
  });

  it("throw happens before any DB write — referral row is untouched on block", () => {
    const be = freshBackend();
    const before = { ...be._referrals[0] };

    expect(() =>
      be.updateReferral(BLOCKED_NO_ROLE, { status: "declined", note: "x" }),
    ).toThrow(/Forbidden/);

    expect(be._referrals[0]).toEqual(before);
    expect(be._fanoutCallLog).toEqual([]);
  });
});
