import { describe, it, expect } from "vitest";
import { runGetAuditLog } from "./admin.functions";

/**
 * End-to-end-ish integration test for the create → update audit flow.
 *
 * Simulates what the DB writes when a referral is created and then
 * updated: two audit_log rows for the same entity_id, both carrying
 * sensitive plaintext + crypto-suffix keys in `diff`. Verifies that
 * `getAuditLog`:
 *
 *   1. Returns BOTH rows (create + update) for the referral.
 *   2. Orders them newest-first by default (the update row on top).
 *   3. The update row's diff still redacts every sensitive field and
 *      strips every `_enc` / `_ciphertext` / `_nonce` / `_hash` key,
 *      including the `{ old, new }` update shape.
 *   4. Filtering by `action=update` isolates the update row and it
 *      remains fully redacted.
 *   5. No sensitive plaintext or crypto-suffix keys appear anywhere in
 *      either response.
 */

const REFERRAL_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const CLINICIAN_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";

// Sensitive plaintext markers — MUST NOT appear in any response.
const CREATE_MARKERS = [
  "H-CREATE-42",
  "cipher-hn-create",
  "hash-hn-create",
  "RR-CREATE-PLAINTEXT",
  "cipher-rr-create",
  "iv-rr-create",
  "AC-CREATE",
];

const UPDATE_MARKERS = [
  "H-CREATE-42", // hospital_number.old
  "H-UPDATED-99", // hospital_number.new
  "cipher-hn-old",
  "cipher-hn-new",
  "hash-hn-old",
  "hash-hn-new",
  "RR-OLD-PLAINTEXT",
  "RR-NEW-PLAINTEXT",
  "cipher-rr-old",
  "cipher-rr-new",
  "iv-rr-old",
  "iv-rr-new",
  "AC-OLD",
  "AC-NEW",
];

const ALL_MARKERS = [...new Set([...CREATE_MARKERS, ...UPDATE_MARKERS])];
const CRYPTO_SUFFIXES = ["_enc", "_ciphertext", "_nonce", "_hash"];

// Row the DB would write for the INSERT trigger.
const CREATE_ROW = {
  id: "aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa",
  user_id: CLINICIAN_ID,
  action: "create",
  entity: "referral",
  entity_id: REFERRAL_ID,
  created_at: "2026-07-11T09:00:00.000Z",
  diff: {
    status: "pending",
    hospital_number: "H-CREATE-42",
    hospital_number_enc: "cipher-hn-create",
    hospital_number_hash: "hash-hn-create",
    reason_for_referral: "RR-CREATE-PLAINTEXT",
    reason_for_referral_ciphertext: "cipher-rr-create",
    reason_for_referral_nonce: "iv-rr-create",
    patient_initials: "AC-CREATE",
    allergies: null,
  },
};

// Row the DB would write for the UPDATE trigger — { old, new } shape.
const UPDATE_ROW = {
  id: "bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb",
  user_id: CLINICIAN_ID,
  action: "update",
  entity: "referral",
  entity_id: REFERRAL_ID,
  created_at: "2026-07-11T09:30:00.000Z",
  diff: {
    status: { old: "pending", new: "accepted" },
    hospital_number: { old: "H-CREATE-42", new: "H-UPDATED-99" },
    hospital_number_enc: { old: "cipher-hn-old", new: "cipher-hn-new" },
    hospital_number_hash: { old: "hash-hn-old", new: "hash-hn-new" },
    reason_for_referral: {
      old: "RR-OLD-PLAINTEXT",
      new: "RR-NEW-PLAINTEXT",
    },
    reason_for_referral_ciphertext: {
      old: "cipher-rr-old",
      new: "cipher-rr-new",
    },
    reason_for_referral_nonce: { old: "iv-rr-old", new: "iv-rr-new" },
    patient_initials: { old: "AC-OLD", new: "AC-NEW" },
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

function assertClean(label: string, payload: unknown, markers: string[]) {
  const keys = collectKeys(payload);
  const badKeys = [...keys].filter((k) =>
    CRYPTO_SUFFIXES.some((s) => k.endsWith(s)),
  );
  expect(badKeys, `[${label}] crypto-suffix keys leaked`).toEqual([]);

  const serialised = JSON.stringify(payload);
  for (const m of markers) {
    expect(
      serialised.includes(m),
      `[${label}] response contained forbidden marker "${m}"`,
    ).toBe(false);
  }
}

// Minimal admin stub: filters `audit_log` rows by `action` when the
// handler asks for it, orders by created_at desc, and returns fixed
// slices. Empty responses for `profiles`/`referrals` — the handler
// only uses those to resolve clinician filters, which we don't set.
function makeAdmin(rows: Array<typeof CREATE_ROW | typeof UPDATE_ROW>) {
  function auditChain() {
    const state: { action?: string; sortDesc: boolean } = { sortDesc: true };
    const chain: any = {
      select: () => chain,
      eq: (col: string, val: string) => {
        if (col === "action") state.action = val;
        return chain;
      },
      in: () => chain,
      ilike: () => chain,
      gte: () => chain,
      lte: () => chain,
      order: (_col: string, opts?: { ascending?: boolean }) => {
        state.sortDesc = !(opts?.ascending ?? false);
        return chain;
      },
      range: async (from: number, to: number) => {
        let filtered = rows.filter(
          (r) => !state.action || r.action === state.action,
        );
        filtered = [...filtered].sort((a, b) =>
          state.sortDesc
            ? b.created_at.localeCompare(a.created_at)
            : a.created_at.localeCompare(b.created_at),
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
    from: (table: string) => {
      if (table === "audit_log") return auditChain();
      return emptyChain();
    },
  };
}

describe("getAuditLog — create + update referral flow", () => {
  it("returns both audit entries newest-first with the update row fully redacted", async () => {
    const admin = makeAdmin([CREATE_ROW, UPDATE_ROW]);
    const page = await runGetAuditLog({ entity: "referral" }, admin);

    expect(page.total).toBe(2);
    expect(page.rows).toHaveLength(2);
    expect(page.rows.map((r) => r.action)).toEqual(["update", "create"]);
    expect(page.rows.every((r) => r.entity_id === REFERRAL_ID)).toBe(true);

    const update = page.rows[0];
    const create = page.rows[1];

    // Update row: { old, new } sensitive fields redacted, crypto keys gone.
    expect(update.diff).toEqual({
      status: { old: "pending", new: "accepted" },
      hospital_number: { old: "[encrypted]", new: "[encrypted]" },
      reason_for_referral: { old: "[encrypted]", new: "[encrypted]" },
      patient_initials: { old: "[encrypted]", new: "[encrypted]" },
    });

    // Create row: scalar sensitive fields redacted, crypto keys gone.
    expect(create.diff).toEqual({
      status: "pending",
      hospital_number: "[encrypted]",
      reason_for_referral: "[encrypted]",
      patient_initials: "[encrypted]",
      allergies: null,
    });

    assertClean("create+update page", page, ALL_MARKERS);
  });

  it("filtering by action=update isolates the update row and keeps redaction intact", async () => {
    const admin = makeAdmin([CREATE_ROW, UPDATE_ROW]);
    const page = await runGetAuditLog(
      { entity: "referral", action: "update" },
      admin,
    );

    expect(page.total).toBe(1);
    expect(page.rows).toHaveLength(1);
    const [row] = page.rows;
    expect(row.action).toBe("update");
    expect(row.entity_id).toBe(REFERRAL_ID);

    expect(row.diff).toEqual({
      status: { old: "pending", new: "accepted" },
      hospital_number: { old: "[encrypted]", new: "[encrypted]" },
      reason_for_referral: { old: "[encrypted]", new: "[encrypted]" },
      patient_initials: { old: "[encrypted]", new: "[encrypted]" },
    });

    assertClean("update-only page", page, UPDATE_MARKERS);
  });

  it("ascending sort still returns both rows in stable order with redaction intact", async () => {
    const admin = makeAdmin([CREATE_ROW, UPDATE_ROW]);
    const page = await runGetAuditLog(
      { entity: "referral", sortBy: "created_at", sortDir: "asc" },
      admin,
    );

    expect(page.rows.map((r) => r.action)).toEqual(["create", "update"]);
    assertClean("asc page", page, ALL_MARKERS);
  });
});
