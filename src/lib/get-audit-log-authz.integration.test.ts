import { describe, it, expect } from "vitest";
import { assertAdmin } from "./auth-guards";
import { runGetAuditLog } from "./admin.functions";

/**
 * Integration: `getAuditLog` authorisation contract.
 *
 * The real server fn handler is:
 *
 *   createServerFn({ method: "POST" })
 *     .middleware([requireSupabaseAuth])          // bearer required
 *     .inputValidator(auditLogInputSchema.parse)
 *     .handler(async ({ data, context }) => {
 *       await assertAdmin(context);              //  ← must gate the read
 *       const { supabaseAdmin } = await import(...);
 *       return runGetAuditLog(data, supabaseAdmin);
 *     });
 *
 * Two authorisation layers must hold:
 *
 *   1. **Middleware:** `requireSupabaseAuth` rejects requests with no /
 *      invalid bearer BEFORE the handler runs, so `data` and `context`
 *      never reach any DB read. We can't drive the TanStack middleware
 *      chain from a unit test, but we can prove the invariant it
 *      protects: if the handler is invoked with a context that lacks
 *      `supabase`/`userId`, `assertAdmin` throws before any audit fetch.
 *
 *   2. **Role guard:** `assertAdmin` throws with a fixed
 *      `"Forbidden: admin role required."` message when `has_role`
 *      returns false. The response must be a SAFE, redacted error —
 *      no rows, no diff, no fixture markers, no driver text.
 *
 * This suite composes `assertAdmin` + `runGetAuditLog` exactly like the
 * server-fn handler and asserts the authz contract holds end-to-end.
 */

// ---------------------------------------------------------------------
// Fixture — dangerous rows that MUST never appear in any response an
// unauthorised caller sees.
// ---------------------------------------------------------------------

const DANGEROUS_ROWS = [
  {
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    user_id: "11111111-1111-1111-1111-111111111111",
    action: "create",
    entity: "referral",
    entity_id: "r1",
    created_at: "2026-07-11T10:00:00.000Z",
    diff: {
      hospital_number: "H-AUTHZ-PLAIN-1",
      hospital_number_enc: "v1:HN-AUTHZ-CIPHER-1",
      hospital_number_hash: "hn-authz-hash-1",
      reason_for_referral: {
        old: "RR-AUTHZ-OLD-1",
        new: "RR-AUTHZ-NEW-1",
      },
      reason_for_referral_ciphertext: "rr-authz-cipher-1",
      reason_for_referral_nonce: "IV-RR-AUTHZ-1",
      body: "NOTE-AUTHZ-BODY-1",
      body_ciphertext: "body-authz-cipher-1",
      body_nonce: "IV-BODY-AUTHZ-1",
    },
  },
];

const FORBIDDEN_MARKERS = [
  "H-AUTHZ-PLAIN-1",
  "v1:HN-AUTHZ-CIPHER-1",
  "hn-authz-hash-1",
  "RR-AUTHZ-OLD-1",
  "RR-AUTHZ-NEW-1",
  "rr-authz-cipher-1",
  "IV-RR-AUTHZ-1",
  "NOTE-AUTHZ-BODY-1",
  "body-authz-cipher-1",
  "IV-BODY-AUTHZ-1",
];

const CRYPTO_SUFFIXES = ["_enc", "_ciphertext", "_nonce", "_hash"];
const SENSITIVE_KEYS = new Set([
  "hospital_number",
  "patient_initials",
  "reason_for_referral",
  "reason_for_bed",
  "past_medical_history",
  "past_surgical_history",
  "social_history",
  "baseline_function",
  "proposed_procedure",
  "body",
  "dnacpr_details",
  "dnacpr_reason",
  "tep_details",
  "allergies",
  "infection_organism",
]);

function findLeaks(node: unknown, path: string[] = []): string[] {
  const leaks: string[] = [];
  if (Array.isArray(node)) {
    node.forEach((v, i) => leaks.push(...findLeaks(v, [...path, String(i)])));
    return leaks;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const here = [...path, key];
      if (CRYPTO_SUFFIXES.some((s) => key.endsWith(s))) {
        leaks.push(`crypto key at ${here.join(".")}`);
        continue;
      }
      if (SENSITIVE_KEYS.has(key)) {
        const isRedactedLeaf = (v: unknown) => v === null || v === "[encrypted]";
        const isRedactedDiff =
          value !== null &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          Object.entries(value as Record<string, unknown>).every(
            ([k, v]) => (k === "old" || k === "new") && isRedactedLeaf(v),
          );
        if (!isRedactedLeaf(value) && !isRedactedDiff) {
          leaks.push(`sensitive plaintext at ${here.join(".")}`);
        }
        continue;
      }
      leaks.push(...findLeaks(value, here));
    }
  }
  return leaks;
}

function assertNoMarkerLeaks(where: string, value: unknown) {
  const serialised =
    typeof value === "string" ? value : JSON.stringify(value ?? null);
  for (const m of FORBIDDEN_MARKERS) {
    expect(
      serialised.includes(m),
      `[${where}] leaked forbidden marker "${m}"`,
    ).toBe(false);
  }
}

// ---------------------------------------------------------------------
// Supabase-user-context stubs. `assertAdmin` calls
// `context.supabase.rpc("has_role", { _user_id, _role })`; we control
// its return value per test.
// ---------------------------------------------------------------------

type RpcOutcome =
  | { data: boolean; error: null }
  | { data: null; error: { message: string; code?: string; details?: string } };

function makeUserContext(userId: string | null, outcome: RpcOutcome) {
  const calls: Array<{ fn: string; args: unknown }> = [];
  const supabase = {
    rpc: async (fn: string, args: unknown) => {
      calls.push({ fn, args });
      return outcome;
    },
    // If the handler ever tries to read data through THIS client
    // (it doesn't — audit reads go through supabaseAdmin), it must
    // find no data anyway, and we'd notice via the calls[] log.
    from: () => {
      calls.push({ fn: "from", args: null });
      throw new Error("unexpected user-context .from() call");
    },
  };
  return { userId, supabase, calls };
}

// The admin-side audit reader — records whether it was invoked, so we
// can assert that an unauthorised handler never reaches this layer.
function makeAdminReader(opts?: { throwOnInvocation?: boolean }) {
  const state = { invoked: false, callCount: 0 };
  const admin: any = {
    from: (table: string) => {
      state.invoked = true;
      state.callCount++;
      if (opts?.throwOnInvocation) {
        throw new Error(
          `admin.from(${table}) called during an unauthorised request — authz gate failed`,
        );
      }
      const chain: any = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === "range" || prop === "limit") {
              return async () => ({
                data: DANGEROUS_ROWS,
                error: null,
                count: DANGEROUS_ROWS.length,
              });
            }
            if (prop === "then") {
              return (fn: (v: unknown) => unknown) =>
                fn({ data: DANGEROUS_ROWS, error: null, count: DANGEROUS_ROWS.length });
            }
            return () => chain;
          },
        },
      );
      return chain;
    },
  };
  return { admin, state };
}

// The composition of the real handler body (post-middleware, post-
// validation). Tests drive THIS, not the raw server-fn wrapper.
async function callGetAuditLogAsHandler(
  context: { userId: string | null; supabase: any },
  data: any,
  admin: any,
) {
  await assertAdmin(context);
  return runGetAuditLog(data, admin);
}

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

describe("getAuditLog authz — unauthenticated / missing-context requests", () => {
  it("context with no supabase client cannot invoke assertAdmin", async () => {
    // Real middleware would refuse this request before the handler
    // runs. Simulating it here proves the handler body wouldn't leak
    // data even if a future refactor accidentally called the handler
    // with an unauthenticated context.
    const badContext = { userId: null, supabase: undefined } as any;
    const { admin, state } = makeAdminReader({ throwOnInvocation: true });

    let caught: unknown;
    try {
      await callGetAuditLogAsHandler(badContext, {}, admin);
    } catch (e) {
      caught = e;
    }
    expect(caught, "must throw before touching admin reader").toBeTruthy();
    expect(state.invoked, "admin reader must never be called").toBe(false);
    assertNoMarkerLeaks("no-supabase", (caught as Error)?.message ?? "");
  });

  it("context with supabase but null userId → assertAdmin throws Forbidden, no audit fetch", async () => {
    const ctx = makeUserContext(null, { data: false, error: null });
    const { admin, state } = makeAdminReader({ throwOnInvocation: true });

    let caught: unknown;
    try {
      await callGetAuditLogAsHandler(ctx, {}, admin);
    } catch (e) {
      caught = e;
    }
    expect((caught as Error)?.message).toBe("Forbidden: admin role required.");
    expect(state.invoked).toBe(false);
    // has_role was called with _user_id: null — exactly one call, and
    // ONLY that call. No sneaky secondary lookups.
    expect(ctx.calls).toEqual([
      { fn: "has_role", args: { _user_id: null, _role: "admin" } },
    ]);
    assertNoMarkerLeaks("null-userId", (caught as Error).message);
  });
});

describe("getAuditLog authz — authenticated but non-admin users", () => {
  const NON_ADMIN_IDS = [
    "22222222-2222-2222-2222-222222222222", // clinician
    "33333333-3333-3333-3333-333333333333", // nurse
    "44444444-4444-4444-4444-444444444444", // random signed-in user
  ];

  for (const userId of NON_ADMIN_IDS) {
    it(`non-admin user ${userId.slice(0, 8)}… gets "Forbidden" and NO audit rows`, async () => {
      const ctx = makeUserContext(userId, { data: false, error: null });
      const { admin, state } = makeAdminReader({ throwOnInvocation: true });

      let caught: unknown;
      try {
        await callGetAuditLogAsHandler(ctx, { limit: 10 }, admin);
      } catch (e) {
        caught = e;
      }
      expect((caught as Error)?.message).toBe("Forbidden: admin role required.");
      expect(state.invoked, "admin reader must be untouched").toBe(false);
      expect(ctx.calls).toEqual([
        { fn: "has_role", args: { _user_id: userId, _role: "admin" } },
      ]);

      // The error surface itself carries no ciphertext, hash, or
      // plaintext markers — the response an unauthorised caller sees
      // is safe by construction.
      const surface = {
        message: (caught as Error).message,
        cause: (caught as any)?.cause,
      };
      assertNoMarkerLeaks(`non-admin ${userId}`, surface);
    });
  }

  it("filter arguments do not leak back to the caller in the forbidden error", async () => {
    // A hostile caller might submit filters shaped to make error text
    // echo them (e.g. an entity string that looks like ciphertext).
    // The friendly error must not quote the filter values.
    const ctx = makeUserContext(NON_ADMIN_IDS[0]!, { data: false, error: null });
    const { admin, state } = makeAdminReader({ throwOnInvocation: true });
    const filters = {
      entity: "H-AUTHZ-PLAIN-1", // fixture marker as entity
      clinician: "v1:HN-AUTHZ-CIPHER-1", // fixture marker as clinician
    };

    let caught: unknown;
    try {
      await callGetAuditLogAsHandler(ctx, filters, admin);
    } catch (e) {
      caught = e;
    }
    expect((caught as Error)?.message).toBe("Forbidden: admin role required.");
    expect(state.invoked).toBe(false);
    assertNoMarkerLeaks("echoed-filters", (caught as Error).message);
  });
});

describe("getAuditLog authz — has_role RPC failures", () => {
  it("RPC error → generic 'Permission check failed.' message; provider details never leak", async () => {
    const driverError = {
      message:
        "function has_role does not exist — hint: H-AUTHZ-PLAIN-1 leaked-detail",
      code: "42883",
      details: "hn-authz-hash-1",
    };
    const ctx = makeUserContext("22222222-2222-2222-2222-222222222222", {
      data: null,
      error: driverError,
    });
    const { admin, state } = makeAdminReader({ throwOnInvocation: true });

    let caught: unknown;
    try {
      await callGetAuditLogAsHandler(ctx, {}, admin);
    } catch (e) {
      caught = e;
    }
    expect((caught as Error)?.message).toBe("Permission check failed.");
    expect(state.invoked).toBe(false);
    const surface = JSON.stringify({
      message: (caught as Error).message,
      cause: (caught as any)?.cause,
    });
    assertNoMarkerLeaks("rpc-error", surface);
    expect(surface).not.toContain("42883");
    expect(surface.toLowerCase()).not.toContain("function has_role");
  });
});

describe("getAuditLog authz — admin caller reaches the reader and gets redacted rows", () => {
  it("admin user: assertAdmin passes, runGetAuditLog runs, response is fully redacted", async () => {
    const adminUserId = "99999999-9999-9999-9999-999999999999";
    const ctx = makeUserContext(adminUserId, { data: true, error: null });
    const { admin, state } = makeAdminReader();

    const page = await callGetAuditLogAsHandler(ctx, { limit: 50 }, admin);

    // Authorised path reached the reader exactly once (audit_log).
    expect(state.invoked, "admin reader MUST be called for an admin").toBe(true);
    expect(state.callCount).toBeGreaterThanOrEqual(1);
    // has_role was called with the correct arguments.
    expect(ctx.calls[0]).toEqual({
      fn: "rpc",
      args: { _user_id: adminUserId, _role: "admin" },
    });

    // Payload is well-formed and every dangerous marker is redacted.
    expect(page.rows.length).toBe(1);
    const leaks = findLeaks(page);
    expect(leaks, `admin response leaks: ${leaks.join(", ")}`).toEqual([]);
    assertNoMarkerLeaks("admin path", page);
  });
});
