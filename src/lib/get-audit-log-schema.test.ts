import { describe, it, expect } from "vitest";
import { z } from "zod";
import { redactAuditDiff } from "./audit-redact";

/**
 * Server-side schema validation for `getAuditLog`'s output contract.
 *
 * `getAuditLog` (src/lib/admin.functions.ts) pipes every row's `diff`
 * through `redactAuditDiff` before returning the payload:
 *
 *   const redacted = list.slice(0, limit).map((r) => ({
 *     ...r,
 *     diff: redactAuditDiff(r.diff),
 *   }));
 *
 * This test locks that contract as a schema: given the exact raw rows a
 * malicious/legacy DB could hand back — ciphertext columns, hash/nonce
 * columns, sensitive plaintext, and nested `{ old, new }` diffs — the
 * post-redaction rows must pass a schema that forbids any of those
 * shapes. If someone removes `redactAuditDiff` from the handler, changes
 * its call site, or bypasses it for a new field, this test fails.
 */

// A JSON-value schema that recursively rejects any object key ending in
// a crypto suffix, and rejects any known-sensitive plaintext key whose
// value is not the literal "[encrypted]" placeholder (or null, which
// legitimately passes through).
const CRYPTO_SUFFIXES = ["_enc", "_ciphertext", "_nonce", "_hash"];
const SENSITIVE_PLAINTEXT_KEYS = new Set([
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

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

const redactedValue: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(redactedValue),
    z.record(z.string(), redactedValue).superRefine((obj, ctx) => {
      for (const [key, value] of Object.entries(obj)) {
        if (CRYPTO_SUFFIXES.some((s) => key.endsWith(s))) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: `crypto-suffix key "${key}" leaked into getAuditLog output`,
          });
          continue;
        }
        if (!SENSITIVE_PLAINTEXT_KEYS.has(key)) continue;
        // Sensitive column: value must be "[encrypted]", null, or an
        // { old, new } pair where each side is "[encrypted]" or null.
        const isRedacted = (v: unknown) => v === null || v === "[encrypted]";
        if (isRedacted(value)) continue;
        if (
          value &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          ("old" in (value as object) || "new" in (value as object))
        ) {
          const branch = value as { old?: unknown; new?: unknown };
          const oldOk = !("old" in branch) || isRedacted(branch.old);
          const newOk = !("new" in branch) || isRedacted(branch.new);
          if (oldOk && newOk) continue;
        }
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `sensitive column "${key}" carried unredacted plaintext into getAuditLog output`,
        });
      }
    }),
  ]),
);

const redactedAuditRow = z.object({
  id: z.string(),
  user_id: z.string().nullable(),
  action: z.string(),
  entity: z.string(),
  entity_id: z.string().nullable(),
  diff: redactedValue,
  created_at: z.string(),
});

// Simulate the exact transform `getAuditLog` applies to raw DB rows so
// this test binds to the same function the handler uses. If the handler
// ever stops calling redactAuditDiff, this simulation still passes but
// a companion assertion below re-imports the handler wiring at build
// time; see "handler wires redactor" test.
function applyGetAuditLogRedaction<T extends { diff: unknown }>(rows: T[]): T[] {
  return rows.map((r) => ({ ...r, diff: redactAuditDiff(r.diff) }));
}

// A representative corpus of raw audit_log rows the DB could return.
// Every one contains at least one field that MUST be scrubbed before
// the Audit tab sees it.
const RAW_ROWS = [
  {
    id: "00000000-0000-0000-0000-000000000001",
    user_id: "aa",
    action: "create",
    entity: "referral",
    entity_id: "r1",
    created_at: "2026-07-11T10:00:00.000Z",
    diff: {
      hospital_number_enc: "v1:AAAA-CIPHERTEXT",
      hospital_number_hash: "deadbeef1234",
      reason_for_referral_ciphertext: "…base64…",
      reason_for_referral_nonce: "IV",
      hospital_number: "H12345",
      reason_for_referral: "SEPSIS — plaintext",
      past_medical_history: "COPD, HTN",
      status: "pending",
    },
  },
  {
    id: "00000000-0000-0000-0000-000000000002",
    user_id: "bb",
    action: "update",
    entity: "referral",
    entity_id: "r2",
    created_at: "2026-07-11T10:05:00.000Z",
    diff: {
      reason_for_referral: { old: "old plaintext", new: "new plaintext" },
      past_medical_history: { old: null, new: "diabetes" },
      status: { old: "pending", new: "accepted" },
      hospital_number_enc: { old: "v1:X", new: "v1:Y" },
    },
  },
  {
    id: "00000000-0000-0000-0000-000000000003",
    user_id: null,
    action: "update",
    entity: "referral_note",
    entity_id: "n1",
    created_at: "2026-07-11T10:10:00.000Z",
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
    // Fabricated future encrypted columns not in today's allowlist —
    // still must be dropped purely by the crypto suffix contract.
    id: "00000000-0000-0000-0000-000000000004",
    user_id: "cc",
    action: "update",
    entity: "patient",
    entity_id: "p1",
    created_at: "2026-07-11T10:15:00.000Z",
    diff: {
      brand_new_field_ciphertext: "…",
      future_column_enc: "v2:ZZZ",
      unknown_thing_nonce: "IV",
      totally_new_hash: "sha256:abc",
      status: "reviewed",
    },
  },
];

describe("getAuditLog output schema validation", () => {
  it("every returned row's diff passes the redacted-diff schema", () => {
    const redactedRows = applyGetAuditLogRedaction(RAW_ROWS);

    for (const row of redactedRows) {
      const result = redactedAuditRow.safeParse(row);
      if (!result.success) {
        throw new Error(
          `Row ${row.id} failed redacted-schema:\n${JSON.stringify(result.error.issues, null, 2)}\nActual diff:\n${JSON.stringify(row.diff, null, 2)}`,
        );
      }
    }
  });

  it("raw rows FAIL the same schema — proving the schema is meaningful", () => {
    // Sanity check: without redaction, the corpus MUST be rejected.
    // If this passes accidentally, the schema is toothless.
    let anyRawRejected = false;
    for (const raw of RAW_ROWS) {
      const result = redactedAuditRow.safeParse(raw);
      if (!result.success) {
        anyRawRejected = true;
        break;
      }
    }
    expect(anyRawRejected).toBe(true);
  });

  it("handler in admin.functions still wires redactAuditDiff into the response", async () => {
    // Static-source check: fail loudly if someone removes the redaction
    // call from getAuditLog. Cheaper and more deterministic than trying
    // to invoke the full server-fn pipeline in a unit test.
    const fs = await import("node:fs/promises");
    const src = await fs.readFile("src/lib/admin.functions.ts", "utf8");
    expect(src).toMatch(/redactAuditDiff\s*\(\s*r\.diff\s*\)/);
    // And the import must be present, not tree-shaken.
    expect(src).toMatch(/from\s+["']\.\/audit-redact["']/);
  });
});
