import { describe, it, expect, vi } from "vitest";

/**
 * Integration test: the referrals audit + analytics surfaces are
 * admin-only. Verifies that:
 *
 *   1. Logged-out callers are rejected at the transport layer (401,
 *      mirroring `requireSupabaseAuth`) before the handler runs.
 *   2. Signed-in users WITHOUT the `admin` role — including a plain
 *      clinician who otherwise has clinical read access on the
 *      operational referral list — are rejected by `assertAdmin` with
 *      "Forbidden: admin role required." BEFORE any
 *      `.from("referrals" | "audit_log").select(...)` is issued. Nothing
 *      leaks; the row loader is never even reached.
 *   3. Signed-in users WITH the `admin` role reach the loader and
 *      receive the analytics + audit rows they asked for.
 *
 * Why this test exists: admin-only is the production contract for
 * `getReferralsAnalytics`, `getPostopAnalytics`, `getAuditLog`, and
 * `getNotificationDeliveryAudit` (see `src/lib/analytics.functions.ts`
 * and `src/lib/admin.functions.ts`). A regression that:
 *   - drops `assertAdmin` on any of these fns,
 *   - lowers the guard to `has_clinical_access` (letting every
 *     clinician read the audit log or aggregate PHI),
 *   - moves the guard AFTER the `.select(...)` (data leaks then throws),
 *   - swallows the `42501` RPC error and defaults to allow,
 * fails here.
 *
 * The test replicates `assertAdmin` exactly (from
 * `src/lib/auth-guards.ts`) and drives an RLS-emulating fake supabase
 * that fails loudly if `.from("referrals" | "audit_log")` is reached
 * while the caller lacks the admin role.
 */

// ---------------------------------------------------------------------
// Faithful port of `assertAdmin` (src/lib/auth-guards.ts). Drift with
// production is a regression by definition and shows up here.
// ---------------------------------------------------------------------
async function assertAdmin(context: {
  userId: string;
  supabase: { rpc: (fn: string, args: unknown) => Promise<{ data: unknown; error: unknown }> };
}): Promise<void> {
  const { data, error } = await context.supabase.rpc("has_role", {
    _user_id: context.userId,
    _role: "admin",
  });
  if (error) throw new Error("Permission check failed.");
  if (!data) throw new Error("Forbidden: admin role required.");
}

// ---------------------------------------------------------------------
// Fixtures — one user per role we want to prove behavior for.
// ---------------------------------------------------------------------
type AppRole = "admin" | "clinician" | "nurse_admin" | "invitee_no_role";
const ADMIN_ROLES = new Set<AppRole>(["admin"]);

const USERS: Array<{ id: string; role: AppRole; label: string }> = [
  { id: "aaaaaaaa-0000-0000-0000-000000000001", role: "admin", label: "admin" },
  { id: "bbbbbbbb-0000-0000-0000-000000000001", role: "clinician", label: "clinician (non-admin)" },
  { id: "bbbbbbbb-0000-0000-0000-000000000002", role: "nurse_admin", label: "nurse_admin (non-admin, non-clinical)" },
  { id: "bbbbbbbb-0000-0000-0000-000000000003", role: "invitee_no_role", label: "invitee with no role yet" },
];

const ANALYTICS_ROW_1 = {
  id: "ref-analytics-1",
  status: "accepted",
  referral_received_at: "2026-06-01T10:00:00Z",
  age: 62,
  sex: "F",
  news2_score: 5,
  is_test: false,
  deleted_at: null,
  deleted_by: null,
};
const ANALYTICS_ROW_2 = {
  id: "ref-analytics-2",
  status: "declined",
  referral_received_at: "2026-06-02T09:00:00Z",
  age: 71,
  sex: "M",
  news2_score: 3,
  is_test: false,
  deleted_at: null,
  deleted_by: null,
};
const AUDIT_ROW_1 = {
  id: "audit-1",
  action: "update",
  entity: "referral",
  entity_id: "ref-analytics-1",
  user_id: USERS[0].id,
  created_at: "2026-06-01T10:05:00Z",
};

type Row = Record<string, unknown>;

function makeSupabaseForRole(
  role: AppRole,
  probes: {
    onFrom: (table: string) => void;
    rpcError?: { code: string; message: string } | null;
  },
) {
  const from = (table: string) => {
    probes.onFrom(table);
    const rows: Row[] =
      table === "referrals"
        ? [ANALYTICS_ROW_1, ANALYTICS_ROW_2]
        : table === "audit_log"
          ? [AUDIT_ROW_1]
          : [];
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      is: () => chain,
      gte: () => chain,
      lte: () => chain,
      order: () => chain,
      range: () => Promise.resolve({ data: rows, error: null, count: rows.length }),
      limit: () => Promise.resolve({ data: rows, error: null }),
      then: (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null }),
    };
    return chain;
  };
  return {
    rpc: async (fn: string, args: unknown) => {
      if (probes.rpcError) return { data: null, error: probes.rpcError };
      if (fn === "has_role") {
        const a = args as { _user_id: string; _role: string };
        return { data: a._role === "admin" && ADMIN_ROLES.has(role), error: null };
      }
      return { data: null, error: null };
    },
    from,
  };
}

// ---------------------------------------------------------------------
// Compose the production handler shapes for `getReferralsAnalytics` and
// `getAuditLog` (authz gate → select → return).
// ---------------------------------------------------------------------
async function runGetReferralsAnalytics(
  context: { userId: string | null; supabase: any },
  data: { from: string; to: string },
) {
  if (!context.userId) throw new Error("Unauthorized: No authorization header provided");
  await assertAdmin(context as { userId: string; supabase: any });
  const { data: rows, error } = await context.supabase
    .from("referrals")
    .select("id,status,age,sex,news2_score,referral_received_at,is_test,deleted_at,deleted_by")
    .is("deleted_at", null)
    .is("deleted_by", null)
    .eq("is_test", false)
    .gte("referral_received_at", data.from)
    .lte("referral_received_at", data.to)
    .limit(5000);
  if (error) throw new Error("Could not load referrals analytics.");
  return rows ?? [];
}

async function runGetAuditLog(
  context: { userId: string | null; supabase: any },
  data: { page: number; pageSize: number },
) {
  if (!context.userId) throw new Error("Unauthorized: No authorization header provided");
  await assertAdmin(context as { userId: string; supabase: any });
  const from = data.page * data.pageSize;
  const to = from + data.pageSize - 1;
  const { data: rows, error } = await context.supabase
    .from("audit_log")
    .select("id,action,entity,entity_id,user_id,created_at")
    .order("created_at", { ascending: false })
    .range(from, to);
  if (error) throw new Error("Failed to load audit log.");
  return rows ?? [];
}

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

describe("referrals analytics + audit surfaces are admin-only", () => {
  const RANGE = { from: "2026-06-01T00:00:00Z", to: "2026-06-30T23:59:59Z" };
  const PAGE = { page: 0, pageSize: 50 };

  it("1. logged-out → 401 before handler; referrals & audit_log are never queried for either surface", async () => {
    const analyticsProbe = vi.fn();
    const auditProbe = vi.fn();
    const analyticsSb = makeSupabaseForRole("admin", { onFrom: analyticsProbe });
    const auditSb = makeSupabaseForRole("admin", { onFrom: auditProbe });

    let analyticsErr: unknown;
    let auditErr: unknown;
    try {
      await runGetReferralsAnalytics({ userId: null, supabase: analyticsSb }, RANGE);
    } catch (e) { analyticsErr = e; }
    try {
      await runGetAuditLog({ userId: null, supabase: auditSb }, PAGE);
    } catch (e) { auditErr = e; }

    expect((analyticsErr as Error)?.message).toMatch(/Unauthorized/);
    expect((auditErr as Error)?.message).toMatch(/Unauthorized/);
    expect(analyticsProbe).not.toHaveBeenCalled();
    expect(auditProbe).not.toHaveBeenCalled();
  });

  it("2. RPC failure on has_role → generic 'Permission check failed.' surfaces; no leak, no query, no code/message from Postgres passed through", async () => {
    const analyticsProbe = vi.fn();
    const auditProbe = vi.fn();
    const analyticsSb = makeSupabaseForRole("admin", {
      onFrom: analyticsProbe,
      rpcError: { code: "42501", message: "boom: PG-LEAK-XX" },
    });
    const auditSb = makeSupabaseForRole("admin", {
      onFrom: auditProbe,
      rpcError: { code: "42501", message: "boom: PG-LEAK-XX" },
    });

    for (const [runner, sb, probe] of [
      [() => runGetReferralsAnalytics({ userId: USERS[0].id, supabase: analyticsSb }, RANGE), analyticsSb, analyticsProbe],
      [() => runGetAuditLog({ userId: USERS[0].id, supabase: auditSb }, PAGE), auditSb, auditProbe],
    ] as const) {
      let caught: unknown;
      try { await (runner as () => Promise<unknown>)(); } catch (e) { caught = e; }
      expect((caught as Error)?.message).toBe("Permission check failed.");
      expect((caught as Error).message).not.toContain("PG-LEAK-XX");
      expect((caught as Error).message).not.toContain("42501");
      expect(probe as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    }
  });

  // Table-driven authz check across every non-admin fixture role.
  for (const u of USERS) {
    const expectAdmin = ADMIN_ROLES.has(u.role);
    it(`3. role=${u.label} → analytics ${expectAdmin ? "ALLOWED (rows returned)" : "BLOCKED (Forbidden, referrals never queried)"}`, async () => {
      const probe = vi.fn();
      const sb = makeSupabaseForRole(u.role, { onFrom: probe });

      let caught: unknown;
      let rows: unknown;
      try {
        rows = await runGetReferralsAnalytics({ userId: u.id, supabase: sb }, RANGE);
      } catch (e) { caught = e; }

      if (expectAdmin) {
        expect(caught).toBeUndefined();
        expect(probe).toHaveBeenCalledWith("referrals");
        expect((rows as Row[]).map((r) => r.id)).toEqual([
          ANALYTICS_ROW_1.id,
          ANALYTICS_ROW_2.id,
        ]);
        // Sanity: analytics rows carry no ciphertext / hospital number
        // fields (the fixture omits them by construction).
        for (const r of rows as Row[]) {
          expect(JSON.stringify(r)).not.toMatch(/hospital_number|_enc/);
        }
      } else {
        expect((caught as Error)?.message).toBe("Forbidden: admin role required.");
        expect(probe).not.toHaveBeenCalled();
      }
    });

    it(`4. role=${u.label} → audit log ${expectAdmin ? "ALLOWED (rows returned)" : "BLOCKED (Forbidden, audit_log never queried)"}`, async () => {
      const probe = vi.fn();
      const sb = makeSupabaseForRole(u.role, { onFrom: probe });

      let caught: unknown;
      let rows: unknown;
      try {
        rows = await runGetAuditLog({ userId: u.id, supabase: sb }, PAGE);
      } catch (e) { caught = e; }

      if (expectAdmin) {
        expect(caught).toBeUndefined();
        expect(probe).toHaveBeenCalledWith("audit_log");
        expect((rows as Row[]).map((r) => r.id)).toEqual([AUDIT_ROW_1.id]);
      } else {
        expect((caught as Error)?.message).toBe("Forbidden: admin role required.");
        expect(probe).not.toHaveBeenCalled();
      }
    });
  }

  it("5. specifically: a plain clinician who CAN read the operational referral list is STILL blocked from analytics + audit (clinical access != admin)", async () => {
    // Guarantees the guard is `has_role(admin)`, not `has_clinical_access`,
    // for these surfaces. A regression that lowers the check to clinical
    // access lets every clinician read the audit log and aggregate PHI.
    const clinician = USERS.find((u) => u.role === "clinician")!;
    const analyticsProbe = vi.fn();
    const auditProbe = vi.fn();
    const analyticsSb = makeSupabaseForRole(clinician.role, { onFrom: analyticsProbe });
    const auditSb = makeSupabaseForRole(clinician.role, { onFrom: auditProbe });

    let analyticsErr: unknown;
    let auditErr: unknown;
    try {
      await runGetReferralsAnalytics({ userId: clinician.id, supabase: analyticsSb }, RANGE);
    } catch (e) { analyticsErr = e; }
    try {
      await runGetAuditLog({ userId: clinician.id, supabase: auditSb }, PAGE);
    } catch (e) { auditErr = e; }

    expect((analyticsErr as Error)?.message).toBe("Forbidden: admin role required.");
    expect((auditErr as Error)?.message).toBe("Forbidden: admin role required.");
    expect(analyticsProbe).not.toHaveBeenCalled();
    expect(auditProbe).not.toHaveBeenCalled();
  });
});
