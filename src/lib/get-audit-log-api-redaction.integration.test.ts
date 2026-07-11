import { describe, it, expect } from "vitest";
import { runGetAuditLog } from "./admin.functions";

/**
 * Integration test: `getAuditLog`'s handler (via the extracted
 * `runGetAuditLog` helper the server-fn wraps) redacts ciphertext,
 * nonce, and hash fields — plus every sensitive plaintext column —
 * BEFORE the response leaves the server. No UI-side redaction needed.
 *
 * A mocked Supabase admin client returns a corpus of raw `audit_log`
 * rows loaded with every crypto-suffix column shape we know about,
 * plus fabricated future ones. The assertion walks the entire returned
 * payload and fails if ANY key ends in `_enc`, `_ciphertext`, `_nonce`,
 * or `_hash`, or if any sensitive plaintext column survives unredacted.
 */

const RAW_ROWS = [
  {
    id: "00000000-0000-0000-0000-000000000001",
    user_id: "aa",
    action: "create",
    entity: "referral",
    entity_id: "r1",
    created_at: "2026-07-11T10:00:00.000Z",
    diff: {
      hospital_number_enc: "v1:CIPHERTEXT",
      hospital_number_hash: "deadbeef",
      reason_for_referral_ciphertext: "…base64…",
      reason_for_referral_nonce: "IV-XYZ",
      hospital_number: "H12345",
      reason_for_referral: "SEPSIS plaintext",
      past_medical_history: "COPD, HTN",
      status: "pending",
    },
  },
  {
    id: "00000000-0000-0000-0000-000000000002",
    user_id: "bb",
    action: "update",
    entity: "referral_note",
    entity_id: "n1",
    created_at: "2026-07-11T10:05:00.000Z",
    diff: {
      body: "confidential clinical note body",
      body_ciphertext: "…",
      body_nonce: "…",
      changes: [
        { patient_initials: "AB", note: "safe" },
        { proposed_procedure: "laparotomy", other: "keep" },
      ],
    },
  },
  {
    id: "00000000-0000-0000-0000-000000000003",
    user_id: "cc",
    action: "update",
    entity: "patient",
    entity_id: "p1",
    created_at: "2026-07-11T10:10:00.000Z",
    diff: {
      brand_new_field_ciphertext: "…",
      future_column_enc: "v2:ZZZ",
      unknown_thing_nonce: "IV",
      totally_new_hash: "sha256:abc",
      status: "reviewed",
    },
  },
];

// Chainable stub matching the query-builder surface `runGetAuditLog` uses.
function makeAdmin(rows: typeof RAW_ROWS) {
  const chain: any = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "range") {
          return async () => ({ data: rows, error: null, count: rows.length });
        }
        if (prop === "limit") {
          return async () => ({ data: rows, error: null });
        }
        if (prop === "then") {
          return (fn: (v: unknown) => unknown) =>
            fn({ data: rows, error: null, count: rows.length });
        }
        return () => chain;
      },
    },
  );
  return { from: () => chain };
}

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
        leaks.push(`crypto key leaked: ${here.join(".")}`);
        continue;
      }
      if (SENSITIVE_KEYS.has(key)) {
        const isRedacted =
          value === null ||
          value === "[encrypted]" ||
          (value !== null &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            Object.entries(value as Record<string, unknown>).every(
              ([k, v]) =>
                (k === "old" || k === "new") &&
                (v === null || v === "[encrypted]"),
            ));
        if (!isRedacted) {
          leaks.push(
            `sensitive plaintext leaked at ${here.join(".")}: ${JSON.stringify(value)}`,
          );
        }
        continue;
      }
      leaks.push(...findLeaks(value, here));
    }
  }
  return leaks;
}

describe("getAuditLog API response is redacted at the server, not the UI", () => {
  it("never returns ciphertext / nonce / hash keys or sensitive plaintext", async () => {
    const admin = makeAdmin(RAW_ROWS);
    const page = await runGetAuditLog({} as any, admin);

    expect(Array.isArray(page.rows)).toBe(true);
    expect(page.rows.length).toBe(RAW_ROWS.length);

    const leaks = findLeaks(page.rows);
    expect(
      leaks,
      `getAuditLog leaked ${leaks.length} forbidden field(s):\n  ${leaks.join("\n  ")}`,
    ).toEqual([]);

    const serialised = JSON.stringify(page);
    for (const marker of [
      "v1:CIPHERTEXT",
      "v2:ZZZ",
      "sha256:abc",
      "IV-XYZ",
      "deadbeef",
      "confidential clinical note body",
      "SEPSIS plaintext",
      "laparotomy",
    ]) {
      expect(
        serialised.includes(marker),
        `getAuditLog response contained forbidden marker "${marker}"`,
      ).toBe(false);
    }
  });

  it("sanity: the fixture WOULD trip the leak scanner without redaction", () => {
    const leaks = findLeaks(RAW_ROWS);
    expect(leaks.length).toBeGreaterThan(0);
  });
});
