import { describe, it, expect } from "vitest";
import { assertAdmin } from "./auth-guards";
import { runGetAuditLog } from "./admin.functions";

/**
 * Integration test: the Audit tab is admin-only. Only signed-in team
 * members with the `admin` role may call `getAuditLog`; every other
 * team-member profile must be denied with the fixed friendly error and
 * must NEVER receive a single audit_log row or any referral field.
 *
 * This test drives the composition of the real server-fn handler body:
 *
 *   await assertAdmin(context);              // authz gate
 *   return runGetAuditLog(data, admin);      // reader (only if admin)
 *
 * A tripwire admin stub throws on ANY `.from(table)` call, so if the
 * authz gate ever leaks past for a non-admin role the test fails
 * loudly rather than silently returning data.
 */

// Rows a leak would expose — a real referral audit row and a referral
// data row shape. Neither may ever appear in a non-admin response.
const REFERRAL_ROW = {
  id: "aud00000-0000-0000-0000-000000000001",
  user_id: "u1111111-1111-1111-1111-111111111111",
  action: "update",
  entity: "referral",
  entity_id: "ref00000-0000-0000-0000-000000000001",
  created_at: "2026-07-11T10:00:00.000Z",
  diff: {
    status: { old: "pending", new: "accepted" },
    hospital_number: { old: "HN-TEAM-A", new: "HN-TEAM-B" },
    hospital_number_enc: { old: "cipher-a", new: "cipher-b" },
    reason_for_referral: { old: "RR-TEAM-A", new: "RR-TEAM-B" },
    reason_for_referral_nonce: { old: "iv-a", new: "iv-b" },
  },
};

const NOTE_ROW = {
  id: "aud00000-0000-0000-0000-000000000002",
  user_id: "u2222222-2222-2222-2222-222222222222",
  action: "create",
  entity: "referral_note",
  entity_id: "not00000-0000-0000-0000-000000000001",
  created_at: "2026-07-11T10:05:00.000Z",
  diff: {
    body: "NOTE-TEAM-BODY-plaintext",
    body_ciphertext: "cipher-note-team",
    body_nonce: "iv-note-team",
  },
};

const FORBIDDEN_MARKERS = [
  "HN-TEAM-A", "HN-TEAM-B",
  "cipher-a", "cipher-b",
  "RR-TEAM-A", "RR-TEAM-B",
  "iv-a", "iv-b",
  "NOTE-TEAM-BODY-plaintext",
  "cipher-note-team",
  "iv-note-team",
  // Also: raw entity_ids MUST NOT leak to non-admins.
  "ref00000-0000-0000-0000-000000000001",
  "not00000-0000-0000-0000-000000000001",
];

// Team-member profiles that MUST be denied.
const NON_ADMIN_MEMBERS = [
  { label: "clinician", userId: "aaaa1111-1111-1111-1111-111111111111" },
  { label: "nurse", userId: "bbbb2222-2222-2222-2222-222222222222" },
  { label: "viewer", userId: "cccc3333-3333-3333-3333-333333333333" },
  { label: "revoked-former-admin", userId: "dddd4444-4444-4444-4444-444444444444" },
];

// Session shapes that must be treated as unauthenticated.
const UNAUTHENTICATED_SESSIONS: Array<{
  label: string;
  ctx: { userId: string | null; supabase: any };
}> = [
  {
    label: "no session (undefined supabase)",
    ctx: { userId: null, supabase: undefined as any },
  },
  {
    label: "null userId with supabase present",
    ctx: {
      userId: null,
      supabase: {
        rpc: async () => ({ data: false, error: null }),
      },
    },
  },
];

function makeMemberContext(userId: string) {
  const calls: Array<{ fn: string; args: unknown }> = [];
  const ctx = {
    userId,
    supabase: {
      rpc: async (fn: string, args: unknown) => {
        calls.push({ fn, args });
        // Non-admin members: has_role('admin') returns false.
        return { data: false, error: null };
      },
      from: () => {
        throw new Error(
          "user-context .from() should never be reached in the audit-tab authz path",
        );
      },
    },
    calls,
  };
  return ctx;
}

// Tripwire admin: any table access explodes so a broken authz gate
// cannot silently return data.
function makeTripwireAdmin() {
  const state = { fromCalls: [] as string[] };
  const admin = {
    from: (table: string) => {
      state.fromCalls.push(table);
      throw new Error(
        `AUTHZ LEAK: admin.from("${table}") reached during a non-admin request`,
      );
    },
  };
  return { admin, state };
}

// Real-admin stub returns the dangerous rows; the redaction pipeline
// must scrub them before they reach the caller.
function makeAdminReader(rows: Array<Record<string, unknown>>) {
  const state = { fromCalls: [] as string[] };
  const admin: any = {
    from: (table: string) => {
      state.fromCalls.push(table);
      const chain: any = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === "range" || prop === "limit") {
              return async () => ({
                data: rows,
                error: null,
                count: rows.length,
              });
            }
            if (prop === "then") {
              return (fn: (v: unknown) => unknown) =>
                fn({ data: rows, error: null, count: rows.length });
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

async function runHandler(
  ctx: { userId: string | null; supabase: any },
  data: any,
  admin: any,
) {
  await assertAdmin(ctx);
  return runGetAuditLog(data, admin);
}

function assertNoMarkerLeaks(where: string, payload: unknown) {
  const serialised =
    typeof payload === "string" ? payload : JSON.stringify(payload ?? null);
  for (const m of FORBIDDEN_MARKERS) {
    expect(
      serialised.includes(m),
      `[${where}] leaked forbidden marker "${m}"`,
    ).toBe(false);
  }
}

describe("Audit tab access — only authenticated admin team members", () => {
  for (const { label, ctx } of UNAUTHENTICATED_SESSIONS) {
    it(`unauthenticated session (${label}) is denied and receives no audit or referral data`, async () => {
      const { admin, state } = makeTripwireAdmin();

      let caught: unknown;
      let result: unknown;
      try {
        result = await runHandler(ctx, { limit: 50 }, admin);
      } catch (e) {
        caught = e;
      }

      expect(caught, "unauthenticated request MUST throw").toBeTruthy();
      expect(result, "no payload may be returned").toBeUndefined();
      expect(
        state.fromCalls,
        "audit reader must never be touched for unauthenticated caller",
      ).toEqual([]);
      assertNoMarkerLeaks(`unauth:${label}`, (caught as Error)?.message ?? "");
    });
  }

  for (const { label, userId } of NON_ADMIN_MEMBERS) {
    it(`authenticated non-admin team member (${label}) is denied and receives NO referral or audit rows`, async () => {
      const ctx = makeMemberContext(userId);
      const { admin, state } = makeTripwireAdmin();

      let caught: unknown;
      let result: unknown;
      try {
        result = await runHandler(ctx, { entity: "referral", limit: 25 }, admin);
      } catch (e) {
        caught = e;
      }

      expect((caught as Error)?.message).toBe(
        "Forbidden: admin role required.",
      );
      expect(result, "denied caller must not receive any payload").toBeUndefined();

      // Reader tripwire never fired → no audit_log / referral / profiles
      // query ever executed against the admin client.
      expect(
        state.fromCalls,
        `no table access allowed for ${label}, got: ${state.fromCalls.join(",")}`,
      ).toEqual([]);

      // Exactly one authz probe was made — the has_role RPC — with
      // the correct arguments; no other lookups happen.
      expect(ctx.calls).toEqual([
        { fn: "has_role", args: { _user_id: userId, _role: "admin" } },
      ]);

      // The error surface visible to the caller carries nothing from
      // the dangerous rows — not even entity_ids or ciphertext.
      const surface = {
        message: (caught as Error).message,
        cause: (caught as any)?.cause ?? null,
      };
      assertNoMarkerLeaks(`non-admin:${label}`, surface);
    });
  }

  it("admin team member reaches the audit reader and receives a redacted payload", async () => {
    const adminUserId = "eeee5555-5555-5555-5555-555555555555";
    const calls: Array<{ fn: string; args: unknown }> = [];
    const ctx = {
      userId: adminUserId,
      supabase: {
        rpc: async (fn: string, args: unknown) => {
          calls.push({ fn, args });
          return { data: true, error: null };
        },
        from: () => {
          throw new Error("user-context .from() should not be used by getAuditLog");
        },
      },
    };
    const { admin, state } = makeAdminReader([REFERRAL_ROW, NOTE_ROW]);

    const page = await runHandler(ctx, { limit: 50 }, admin);

    // Admin reached the reader.
    expect(state.fromCalls.length).toBeGreaterThan(0);
    expect(calls).toEqual([
      { fn: "has_role", args: { _user_id: adminUserId, _role: "admin" } },
    ]);

    // Shape is right: both dangerous rows returned but redaction has
    // scrubbed every sensitive plaintext + crypto-suffix key.
    expect(page.rows).toHaveLength(2);
    const serialised = JSON.stringify(page);
    for (const marker of [
      "HN-TEAM-A", "HN-TEAM-B",
      "cipher-a", "cipher-b",
      "RR-TEAM-A", "RR-TEAM-B",
      "iv-a", "iv-b",
      "NOTE-TEAM-BODY-plaintext",
      "cipher-note-team",
      "iv-note-team",
    ]) {
      expect(
        serialised.includes(marker),
        `admin response leaked marker "${marker}" (redaction failure)`,
      ).toBe(false);
    }
  });
});
