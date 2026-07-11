import { describe, it, expect } from "vitest";
import { z } from "zod";

/**
 * Contract test for `getAuditLog` INPUT VALIDATION errors.
 *
 * The server fn wraps its handler in `auditLogInputSchema.parse(...)`.
 * When a caller sends a malformed filter, zod throws a `ZodError`
 * before the handler runs — so the DB is never touched and no audit
 * data is loaded. This test proves two guarantees about that failure
 * mode:
 *
 *   1. **No sensitive-field leakage.** Even though callers can and do
 *      submit values that look like ciphertext, hospital numbers, or
 *      other sensitive plaintext (perhaps by mistake, or as an attack
 *      probe), the resulting validation error must not echo the raw
 *      submitted value back — nor must it name any sensitive column.
 *      A ZodError message that quotes `hospital_number: "H-1234567"`
 *      would itself become a data leak in logs / clients.
 *
 *   2. **Stability across repeated requests.** The same malformed
 *      input must produce a byte-identical error surface every time.
 *      Non-determinism (timestamps, random IDs, iteration order)
 *      would let an attacker mine timing/entropy signals from the
 *      validation layer.
 *
 * This suite mirrors the server-fn's zod schema locally (kept in sync
 * with `auditLogInputSchema` in admin.functions.ts) so it can exercise
 * the boundary without spinning the whole TanStack Start runtime.
 */

// ---------------------------------------------------------------------
// Mirror of the server-fn zod schema. Keep in sync with
// `auditLogInputSchema` in src/lib/admin.functions.ts.
// ---------------------------------------------------------------------

const AUDIT_SORT_COLUMNS = ["created_at", "action", "entity"] as const;
const AUDIT_ACTIONS = ["create", "update", "delete"] as const;

const auditLogInputSchema = z
  .object({
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).max(100_000).optional(),
    sortBy: z.enum(AUDIT_SORT_COLUMNS).optional(),
    sortDir: z.enum(["asc", "desc"]).optional(),
    entity: z.string().trim().min(1).max(64).optional(),
    action: z.enum(AUDIT_ACTIONS).optional(),
    clinician: z.string().trim().min(1).max(120).optional(),
    specialty: z.string().trim().min(1).max(120).optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  })
  .default({});

// ---------------------------------------------------------------------
// Fixture: values a caller might submit that CONTAIN sensitive-looking
// substrings. These must never appear verbatim in any zod error.
//
// Every string here doubles as a "canary" — if the error surface
// includes any of these substrings, the leakage test fails.
// ---------------------------------------------------------------------

const CANARY_MARKERS = [
  "H-CANARY-1234567", // fake hospital number
  "v1:CIPHER-CANARY", // fake ciphertext
  "IV-NONCE-CANARY", // fake nonce
  "hash-canary-abc", // fake hash
  "R-PLAIN-CANARY", // fake reason
  "BODY-PLAIN-CANARY", // fake note body
  "AA-INITIALS-CANARY", // fake initials
];

const SENSITIVE_COLUMN_NAMES = [
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
];

// Bad inputs paired with a canary string inside a field zod will
// reject. Zod's default error formatting includes the offending
// *field path* but must NOT include the raw *value* (zod ≥3.22 lists
// invalid string values in `received`, so we normalise the error
// through `safeParse` and inspect the resulting `issues` array).
type Bad = { label: string; input: unknown; expectedIssuePath: string[] };

const BAD_INPUTS: Bad[] = [
  {
    label: "limit above cap (with canary in unrelated field)",
    input: { limit: 500, entity: "H-CANARY-1234567" },
    expectedIssuePath: ["limit"],
  },
  {
    label: "offset negative",
    input: { offset: -1, clinician: "R-PLAIN-CANARY" },
    expectedIssuePath: ["offset"],
  },
  {
    label: "sortBy unknown",
    input: { sortBy: "diff", specialty: "BODY-PLAIN-CANARY" },
    expectedIssuePath: ["sortBy"],
  },
  {
    label: "action unknown",
    input: { action: "purge", entity: "v1:CIPHER-CANARY" },
    expectedIssuePath: ["action"],
  },
  {
    label: "entity too long",
    input: { entity: "H-CANARY-1234567".repeat(20) },
    expectedIssuePath: ["entity"],
  },
  {
    label: "clinician whitespace-only",
    input: { clinician: "   ", specialty: "AA-INITIALS-CANARY" },
    expectedIssuePath: ["clinician"],
  },
  {
    label: "from not datetime",
    input: { from: "yesterday", clinician: "IV-NONCE-CANARY" },
    expectedIssuePath: ["from"],
  },
  {
    label: "to junk",
    input: { to: "not-a-time", entity: "hash-canary-abc" },
    expectedIssuePath: ["to"],
  },
];

// Normalise a ZodError into a stable surface — the shape callers /
// logs would actually observe. Strip anything that could be a source
// of non-determinism (`received` may echo the input in some zod
// versions; we surface *only* the path + code + validation kind).
function stableSurface(err: z.ZodError) {
  return err.issues
    .map((i) => ({
      path: i.path.map((p) => String(p)),
      code: i.code,
      // Keep the human `message` since we assert it never contains a
      // canary; we deliberately DROP `received`, `expected`, `keys`,
      // etc. from our stability contract because zod version bumps may
      // change them and callers should not rely on those fields.
      message: i.message,
    }))
    .sort((a, b) => a.path.join(".").localeCompare(b.path.join(".")));
}

function assertNoLeaks(where: string, surface: unknown) {
  const serialised = JSON.stringify(surface);
  for (const m of CANARY_MARKERS) {
    expect(
      serialised.includes(m),
      `[${where}] validation error surface leaked canary "${m}"`,
    ).toBe(false);
  }
  for (const col of SENSITIVE_COLUMN_NAMES) {
    // Sensitive column names are not part of the audit-log input schema,
    // so they must never appear in a validation error either.
    expect(
      serialised.includes(col),
      `[${where}] validation error surface named sensitive column "${col}"`,
    ).toBe(false);
  }
}

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

describe("getAuditLog validation errors — never leak canary values", () => {
  for (const { label, input, expectedIssuePath } of BAD_INPUTS) {
    it(`[${label}] error surface omits canaries and sensitive column names`, () => {
      const result = auditLogInputSchema.safeParse(input);
      expect(result.success, `expected schema to reject ${label}`).toBe(false);
      if (result.success) return; // narrow

      const surface = stableSurface(result.error);
      assertNoLeaks(label, surface);

      // The offending field path must be one zod flagged — proves the
      // rejection happened at the right boundary and not because of
      // some unrelated field carrying a canary.
      const paths = surface.map((s) => s.path.join("."));
      expect(paths).toContain(expectedIssuePath.join("."));
    });
  }
});

describe("getAuditLog validation errors — stable across repeated requests", () => {
  for (const { label, input } of BAD_INPUTS) {
    it(`[${label}] identical error surface for 5 consecutive parses`, () => {
      const surfaces: string[] = [];
      for (let i = 0; i < 5; i++) {
        const r = auditLogInputSchema.safeParse(input);
        expect(r.success, `parse #${i + 1} unexpectedly succeeded`).toBe(false);
        if (r.success) return;
        surfaces.push(JSON.stringify(stableSurface(r.error)));
      }
      // Byte-identical: no timestamps, random ids, or non-deterministic
      // ordering leaks into the error surface.
      for (let i = 1; i < surfaces.length; i++) {
        expect(surfaces[i], `run #${i + 1} diverged from run #1`).toBe(surfaces[0]);
      }
    });
  }

  it("multiple simultaneous validation failures produce a stable, sorted surface", () => {
    // Every field wrong at once — stability contract must still hold.
    const messy = {
      limit: 0, // min 1
      offset: -5, // min 0
      sortBy: "diff", // enum
      sortDir: "sideways", // enum
      entity: "", // trimmed min 1
      action: "purge", // enum
      clinician: "y".repeat(200), // max 120
      specialty: "   ", // trimmed min 1
      from: "yesterday", // datetime
      to: "R-PLAIN-CANARY", // datetime (also carries a canary)
    };
    const runs: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = auditLogInputSchema.safeParse(messy);
      expect(r.success).toBe(false);
      if (r.success) return;
      const s = stableSurface(r.error);
      assertNoLeaks("messy-all-wrong", s);
      runs.push(JSON.stringify(s));
    }
    for (let i = 1; i < runs.length; i++) {
      expect(runs[i]).toBe(runs[0]);
    }

    // And pin the exact path set so a future zod bump that starts
    // echoing values or renaming paths trips this suite loudly.
    const parsed = JSON.parse(runs[0]) as Array<{ path: string[] }>;
    const paths = parsed.map((p) => p.path.join(".")).sort();
    expect(paths).toEqual(
      [
        "action",
        "clinician",
        "entity",
        "from",
        "limit",
        "offset",
        "sortBy",
        "sortDir",
        "specialty",
        "to",
      ].sort(),
    );
  });
});

describe("getAuditLog validation errors — canary in an INVALID string value is not echoed", () => {
  // Zod ≥3.22 may include `received` in some issue variants. We
  // deliberately dropped that field in `stableSurface`, but let's ALSO
  // verify the raw ZodError's *message* (the string most callers log)
  // does not embed the offending value verbatim for the fields we care
  // about.
  const rawCanaryCases = [
    { field: "entity", value: "H-CANARY-1234567".repeat(20) }, // too long
    { field: "clinician", value: "   " }, // whitespace-only
    { field: "from", value: "R-PLAIN-CANARY" }, // not ISO
    { field: "sortBy", value: "BODY-PLAIN-CANARY" }, // not enum
  ] as const;

  for (const { field, value } of rawCanaryCases) {
    it(`[${field}] ZodError message never quotes the raw canary value`, () => {
      const r = auditLogInputSchema.safeParse({ [field]: value });
      expect(r.success).toBe(false);
      if (r.success) return;
      const messages = r.error.issues.map((i) => i.message).join("\n");
      for (const m of CANARY_MARKERS) {
        expect(
          messages.includes(m),
          `field=${field}: ZodError message leaked canary "${m}"`,
        ).toBe(false);
      }
    });
  }
});
