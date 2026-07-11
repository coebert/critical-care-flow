import { describe, it, expect } from "vitest";
import { runGetAuditLog } from "./admin.functions";

/**
 * Integration test: updating a referral's `decline_reason` produces an
 * audit_log row whose diff correctly reflects the decline_reason change
 * (non-sensitive, safe to echo) while every sensitive plaintext column
 * carried alongside on the same UPDATE is fully redacted, every crypto
 * suffix key is stripped, and NO caller-supplied filter value is echoed
 * back into the response (defence against a caller trying to smuggle
 * PHI through a filter input expecting to see it reflected).
 */

const REFERRAL_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const CLINICIAN_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";

// The legitimate business change on this UPDATE.
const OLD_DECLINE_REASON = "capacity_full";
const NEW_DECLINE_REASON = "not_medically_appropriate";

// Sensitive plaintext that came along on the same UPDATE row and MUST
// never appear un-redacted in the returned diff.
const SENSITIVE_MARKERS = [
  "H-DECLINE-77",
  "H-DECLINE-88",
  "cipher-hn-old",
  "cipher-hn-new",
  "hash-hn-old",
  "hash-hn-new",
  "RR-DECLINE-OLD",
  "RR-DECLINE-NEW",
  "cipher-rr-old",
  "cipher-rr-new",
  "iv-rr-old",
  "iv-rr-new",
  "AD-OLD",
  "AD-NEW",
];

// Values a caller might smuggle into filter inputs hoping the API echoes
// them back in the response. None of these are legitimate filter data.
const CALLER_SMUGGLED_MARKERS = [
  "SMUGGLED-CLINICIAN-NAME",
  "SMUGGLED-SPECIALTY-STRING",
  "SMUGGLED-ENTITY-MARKER",
];

const CRYPTO_SUFFIXES = ["_enc", "_ciphertext", "_nonce", "_hash"];

const UPDATE_ROW = {
  id: "11111111-2222-3333-4444-555555555555",
  user_id: CLINICIAN_ID,
  action: "update",
  entity: "referral",
  entity_id: REFERRAL_ID,
  created_at: "2026-07-11T12:00:00.000Z",
  diff: {
    status: { old: "pending", new: "declined" },
    // Non-sensitive change — the actual business event under test.
    decline_reason: { old: OLD_DECLINE_REASON, new: NEW_DECLINE_REASON },
    // Sensitive fields that piggy-backed on the same UPDATE.
    hospital_number: { old: "H-DECLINE-77", new: "H-DECLINE-88" },
    hospital_number_enc: { old: "cipher-hn-old", new: "cipher-hn-new" },
    hospital_number_hash: { old: "hash-hn-old", new: "hash-hn-new" },
    reason_for_referral: { old: "RR-DECLINE-OLD", new: "RR-DECLINE-NEW" },
    reason_for_referral_ciphertext: {
      old: "cipher-rr-old",
      new: "cipher-rr-new",
    },
    reason_for_referral_nonce: { old: "iv-rr-old", new: "iv-rr-new" },
    patient_initials: { old: "AD-OLD", new: "AD-NEW" },
  },
};

function collectKeys(node: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) {
    for (const v of node) collectKeys(v, out);
    return out;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out.add(k);
      collectKeys(v, out);
    }
  }
  return out;
}

function makeAdmin(rows: Array<typeof UPDATE_ROW>) {
  function auditChain() {
    const state: { entity?: string; action?: string } = {};
    const chain: any = {
      select: () => chain,
      eq: (col: string, val: string) => {
        if (col === "entity") state.entity = val;
        if (col === "action") state.action = val;
        return chain;
      },
      in: () => chain,
      ilike: () => chain,
      gte: () => chain,
      lte: () => chain,
      order: () => chain,
      range: async (from: number, to: number) => {
        const filtered = rows.filter(
          (r) =>
            (!state.entity || r.entity === state.entity) &&
            (!state.action || r.action === state.action),
        );
        return {
          data: filtered.slice(from, to + 1),
          error: null,
          count: filtered.length,
        };
      },
    };
    return chain;
  }

  function emptyChain() {
    const chain: any = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "range" || prop === "limit")
            return async () => ({ data: [], error: null });
          if (prop === "then")
            return (fn: (v: unknown) => unknown) =>
              fn({ data: [], error: null });
          return () => chain;
        },
      },
    );
    return chain;
  }

  return {
    from: (table: string) => (table === "audit_log" ? auditChain() : emptyChain()),
  };
}

describe("getAuditLog — decline_reason update flow", () => {
  it("returns the correct updated audit record with decline_reason echoed and all sensitive fields redacted", async () => {
    const admin = makeAdmin([UPDATE_ROW]);
    const page = await runGetAuditLog(
      { entity: "referral", action: "update" },
      admin,
    );

    expect(page.total).toBe(1);
    expect(page.rows).toHaveLength(1);
    const [row] = page.rows;

    // Correct updated record surfaced.
    expect(row.action).toBe("update");
    expect(row.entity).toBe("referral");
    expect(row.entity_id).toBe(REFERRAL_ID);

    // Non-sensitive decline_reason change is preserved verbatim so the
    // Audit tab can show WHAT changed, but every sensitive column is
    // redacted and every crypto-suffix key is stripped.
    expect(row.diff).toEqual({
      status: { old: "pending", new: "declined" },
      decline_reason: { old: OLD_DECLINE_REASON, new: NEW_DECLINE_REASON },
      hospital_number: { old: "[encrypted]", new: "[encrypted]" },
      reason_for_referral: { old: "[encrypted]", new: "[encrypted]" },
      patient_initials: { old: "[encrypted]", new: "[encrypted]" },
    });

    // No crypto-suffix keys anywhere in the response.
    const keys = collectKeys(page);
    const badKeys = [...keys].filter((k) =>
      CRYPTO_SUFFIXES.some((s) => k.endsWith(s)),
    );
    expect(badKeys, "crypto-suffix keys leaked into response").toEqual([]);

    // No sensitive plaintext marker appears in the serialised response.
    const serialised = JSON.stringify(page);
    for (const marker of SENSITIVE_MARKERS) {
      expect(
        serialised.includes(marker),
        `sensitive marker "${marker}" leaked into diff`,
      ).toBe(false);
    }
  });

  it("does not echo caller-supplied filter values back into the response, even when they carry sensitive-looking strings", async () => {
    const admin = makeAdmin([UPDATE_ROW]);
    const page = await runGetAuditLog(
      {
        entity: "referral",
        action: "update",
        clinician: CALLER_SMUGGLED_MARKERS[0],
        specialty: CALLER_SMUGGLED_MARKERS[1],
      },
      // Layer a profiles/referrals empty resolver so the clinician/specialty
      // lookups return nothing (which zeros the result set) — the important
      // assertion is that the smuggled STRINGS never appear in the payload.
      {
        from: (table: string) => {
          if (table === "audit_log") return admin.from("audit_log");
          return admin.from("profiles");
        },
      },
    );

    const serialised = JSON.stringify(page);
    for (const marker of CALLER_SMUGGLED_MARKERS) {
      expect(
        serialised.includes(marker),
        `caller-supplied filter "${marker}" was echoed into the response`,
      ).toBe(false);
    }
  });
});
