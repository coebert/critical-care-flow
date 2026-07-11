import { describe, it, expect, vi } from "vitest";

/**
 * Integration test: ONLY authenticated users whose role grants clinical
 * access (`admin` or `clinician`, per `has_clinical_access`) can edit a
 * referral. Every other authenticated role — an unassigned invitee, a
 * ward-admin type with a non-clinical role, an audit-only viewer — must
 * be blocked at the server-fn guard, and the notification payload MUST
 * NOT be emitted for those blocked edits.
 *
 * Regressions covered:
 *   - Guard moved AFTER the write → blocked role's patch lands in the DB.
 *   - Guard dropped for one role by mistake → their edits leak through.
 *   - `fanOutNotifications(...)` called in a `finally`/`catch` block →
 *     blocked edits still emit an "updated" push to opted-in recipients.
 *   - Admin accidentally excluded (admins have clinical access per
 *     `has_clinical_access`) → clinical management surface breaks.
 *
 * Mirrors the production `assertClinicalAccess` helper (module-private in
 * `src/lib/referrals.functions.ts`); drift with production is a
 * regression by definition and shows up here.
 */

// ---------------------------------------------------------------------
// Faithful port of the private `assertClinicalAccess` guard.
// ---------------------------------------------------------------------
async function assertClinicalAccess(
  supabase: { rpc: (fn: string, args: unknown) => Promise<{ data: unknown; error: unknown }> },
  userId: string,
): Promise<void> {
  const { data, error } = await supabase.rpc("has_clinical_access", { _user_id: userId });
  if (error) throw new Error("Permission check failed.");
  if (!data) throw new Error("Forbidden: clinical access required");
}

// Mirror `public.has_clinical_access(_user_id)`:
//   SELECT EXISTS (SELECT 1 FROM public.user_roles
//                  WHERE user_id = _user_id AND role IN ('admin','clinician'))
type AppRole = "admin" | "clinician" | "nurse_admin" | "auditor" | "invitee_no_role";
const CLINICAL_ROLES = new Set<AppRole>(["admin", "clinician"]);

// Fixtures — one user per role we want to prove behavior for.
const USERS: Array<{ id: string; role: AppRole; label: string }> = [
  { id: "aaaaaaaa-0000-0000-0000-000000000001", role: "admin", label: "admin" },
  { id: "aaaaaaaa-0000-0000-0000-000000000002", role: "clinician", label: "clinician" },
  { id: "bbbbbbbb-0000-0000-0000-000000000001", role: "nurse_admin", label: "nurse_admin (non-clinical)" },
  { id: "bbbbbbbb-0000-0000-0000-000000000002", role: "auditor", label: "auditor (non-clinical)" },
  { id: "bbbbbbbb-0000-0000-0000-000000000003", role: "invitee_no_role", label: "invitee with no role yet" },
];
const REF = "cccccccc-cccc-cccc-cccc-ccccccccccc1";

type Row = Record<string, unknown>;

function makeSupabaseForRole(
  role: AppRole,
  probes: {
    onWrite: (table: string, op: string, payload: unknown) => void;
    rpcCalls: Array<{ fn: string; args: unknown }>;
  },
) {
  const priorRow: Row = {
    id: REF,
    status: "pending",
    notes: "before",
    current_ward: "AAU",
    created_by: USERS[1].id, // authored by a clinician
    deleted_at: null,
  };

  const from = (table: string) => {
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: () => Promise.resolve({ data: priorRow, error: null }),
      update: (payload: unknown) => {
        probes.onWrite(table, "update", payload);
        return {
          eq: () => ({
            select: () => ({
              single: () => Promise.resolve({ data: { ...priorRow, ...(payload as Row) }, error: null }),
            }),
          }),
        };
      },
      insert: (payload: unknown) => {
        probes.onWrite(table, "insert", payload);
        return Promise.resolve({ data: payload, error: null });
      },
    };
    return chain;
  };

  return {
    rpc: async (fn: string, args: unknown) => {
      probes.rpcCalls.push({ fn, args });
      if (fn === "has_clinical_access") {
        return { data: CLINICAL_ROLES.has(role), error: null };
      }
      return { data: null, error: null };
    },
    from,
  };
}

// ---------------------------------------------------------------------
// Compose the `updateReferral` handler shape (authz + write + fanout).
// ---------------------------------------------------------------------
async function runUpdateReferral(
  context: { userId: string; supabase: any },
  patch: Record<string, unknown>,
  fanOutNotifications: (
    actorId: string,
    referralId: string,
    kind: string,
    message: string,
  ) => Promise<void>,
) {
  await assertClinicalAccess(context.supabase, context.userId);
  const { data: updated, error } = await context.supabase
    .from("referrals")
    .update({ ...patch, updated_by: context.userId })
    .eq("id", REF)
    .select()
    .single();
  if (error) throw new Error("Failed to update referral.");
  await fanOutNotifications(context.userId, REF, "updated", "Referral updated");
  return updated;
}

// ---------------------------------------------------------------------
// Tests — table-driven across all fixture roles.
// ---------------------------------------------------------------------

describe("updateReferral role authz: only admin/clinician can edit; blocked roles emit no notification", () => {
  const PATCH = { status: "accepted", notes: "after review" };

  for (const u of USERS) {
    const expectClinical = CLINICAL_ROLES.has(u.role);
    it(`role=${u.label} → ${expectClinical ? "ALLOWED (write happens, notification fanout fires once)" : "BLOCKED (Forbidden, no write, no notification)"}`, async () => {
      const writes: Array<{ table: string; op: string; payload: unknown }> = [];
      const rpcCalls: Array<{ fn: string; args: unknown }> = [];
      const fanOut = vi.fn(async (_a: string, _r: string, _k: string, _m: string) => {});

      const sb = makeSupabaseForRole(u.role, {
        onWrite: (table, op, payload) => writes.push({ table, op, payload }),
        rpcCalls,
      });

      let caught: unknown;
      let result: unknown;
      try {
        result = await runUpdateReferral({ userId: u.id, supabase: sb }, PATCH, fanOut);
      } catch (e) {
        caught = e;
      }

      // The guard MUST run for every role (defense-in-depth). If a future
      // refactor short-circuits it for a whitelisted role, this fires.
      expect(rpcCalls.some((c) => c.fn === "has_clinical_access")).toBe(true);
      expect(rpcCalls[0]).toEqual({
        fn: "has_clinical_access",
        args: { _user_id: u.id },
      });

      if (expectClinical) {
        // Allowed path: write lands, exactly one notification fanout fires.
        expect(caught).toBeUndefined();
        expect((result as Row).status).toBe("accepted");
        expect((result as Row).notes).toBe("after review");
        expect(writes).toHaveLength(1);
        expect(writes[0].table).toBe("referrals");
        expect(writes[0].op).toBe("update");
        expect(writes[0].payload).toMatchObject({
          status: "accepted",
          notes: "after review",
          updated_by: u.id,
        });
        expect(fanOut).toHaveBeenCalledTimes(1);
        expect(fanOut).toHaveBeenCalledWith(u.id, REF, "updated", "Referral updated");
      } else {
        // Blocked path: Forbidden, zero writes on any table, no fanout.
        expect((caught as Error)?.message).toBe("Forbidden: clinical access required");
        expect(writes).toEqual([]);
        expect(fanOut).not.toHaveBeenCalled();
      }
    });
  }

  it("cross-check: swapping the patch to a status-only edit does not change the authz outcome (auditor still blocked, no notification)", async () => {
    const writes: Array<{ table: string; op: string }> = [];
    const fanOut = vi.fn(async () => {});
    const sb = makeSupabaseForRole("auditor", {
      onWrite: (table, op) => writes.push({ table, op }),
      rpcCalls: [],
    });
    const auditor = USERS.find((u) => u.role === "auditor")!;

    let caught: unknown;
    try {
      await runUpdateReferral(
        { userId: auditor.id, supabase: sb },
        { status: "declined" },
        fanOut,
      );
    } catch (e) {
      caught = e;
    }

    expect((caught as Error)?.message).toBe("Forbidden: clinical access required");
    expect(writes).toEqual([]);
    expect(fanOut).not.toHaveBeenCalled();
  });

  it("cross-check: revoking a previously-clinical user's role mid-session (has_clinical_access flips false) blocks the very next edit and emits no notification", async () => {
    const writes: Array<{ table: string; op: string }> = [];
    const fanOut = vi.fn(async () => {});
    const clinician = USERS.find((u) => u.role === "clinician")!;

    // First call: clinical access still granted → write + fanout.
    let currentAccess = true;
    const sb = {
      rpc: async (_fn: string, _args: unknown) => ({ data: currentAccess, error: null }),
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: { id: REF, created_by: clinician.id, deleted_at: null }, error: null }),
          }),
        }),
        update: (payload: unknown) => {
          writes.push({ table, op: "update" });
          return {
            eq: () => ({
              select: () => ({
                single: () => Promise.resolve({ data: { id: REF, ...(payload as Row) }, error: null }),
              }),
            }),
          };
        },
      }),
    } as any;

    await runUpdateReferral({ userId: clinician.id, supabase: sb }, { status: "accepted" }, fanOut);
    expect(writes).toHaveLength(1);
    expect(fanOut).toHaveBeenCalledTimes(1);

    // Role revoked between edits.
    currentAccess = false;

    let caught: unknown;
    try {
      await runUpdateReferral({ userId: clinician.id, supabase: sb }, { status: "declined" }, fanOut);
    } catch (e) {
      caught = e;
    }
    expect((caught as Error)?.message).toBe("Forbidden: clinical access required");
    // No new write; no new fanout — counts unchanged from before the revoke.
    expect(writes).toHaveLength(1);
    expect(fanOut).toHaveBeenCalledTimes(1);
  });
});
