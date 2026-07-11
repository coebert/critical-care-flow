import { describe, it, expect } from "vitest";
import { runGetAuditLog } from "./admin.functions";

/**
 * Server-side integration: `getAuditLog` must degrade gracefully when
 * fed pathological-but-schema-passable filter values — malformed
 * UUIDs, punctuation-heavy clinician names, whitespace-only-once-you-
 * ignore-zod-trimming, reversed from/to windows, from == to, dates in
 * the far past/future, and SQL-wildcard / injection-shaped names.
 *
 * The `auditLogInputSchema` in the server fn (zod) rejects genuinely
 * invalid inputs before the handler runs — this test simulates that
 * rejection layer explicitly (parsing with an equivalent zod schema),
 * then exercises the handler with the awkward-but-valid inputs that
 * zod DOES let through. In every case the response must be:
 *   - well-formed (page metadata present, no throws leaking DB shapes);
 *   - fully redacted (no `_enc` / `_ciphertext` / `_nonce` / `_hash`
 *     keys, no sensitive plaintext, no fixture markers);
 *   - stable — the query builder receives filter arguments unchanged
 *     (no interpretation, no interpolation into raw SQL).
 */

import { z } from "zod";

// Local mirror of the server-fn's zod schema — used only to confirm
// bad shapes are rejected at the boundary before ever reaching the
// handler. Keep in sync with `auditLogInputSchema` in admin.functions.ts.
const AUDIT_SORT_COLUMNS = ["created_at", "action", "entity"] as const;
const AUDIT_ACTIONS = ["create", "update", "delete"] as const;
const auditLogInputSchemaMirror = z
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
// Fixture rows loaded with dangerous plaintext + crypto-suffix keys.
// ---------------------------------------------------------------------

const RAW_ROWS = [
  {
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    user_id: "11111111-1111-1111-1111-111111111111",
    action: "create",
    entity: "referral",
    entity_id: "r1",
    created_at: "2026-07-11T10:00:00.000Z",
    diff: {
      hospital_number: "H-PLAIN-1",
      hospital_number_enc: "v1:HN-CIPHER-1",
      hospital_number_hash: "hn-hash-1",
      reason_for_referral: { old: "R-OLD-1", new: "R-NEW-1" },
      reason_for_referral_ciphertext: "rr-cipher-1",
      reason_for_referral_nonce: "IV-RR-1",
      nested: [
        {
          body: "NOTE-BODY-1",
          body_ciphertext: "body-cipher-1",
          body_nonce: "IV-BODY-1",
          deeper: {
            allergies: { old: "AL-OLD-1", new: "AL-NEW-1" },
            unknown_future_enc: "v3:FUTURE-1",
            audit_wrapper: {
              nested_hash: "sha256:UNSEEN-1",
              patient_initials: "ZZ-1",
            },
          },
        },
      ],
      status: "pending",
    },
  },
  {
    id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    user_id: "11111111-1111-1111-1111-111111111111",
    action: "update",
    entity: "referral_note",
    entity_id: "n1",
    created_at: "2026-07-11T10:05:00.000Z",
    diff: {
      body: "NOTE-BODY-2",
      body_ciphertext: "body-cipher-2",
      body_nonce: "IV-BODY-2",
    },
  },
];

const FORBIDDEN_MARKERS = [
  "H-PLAIN-1",
  "v1:HN-CIPHER-1",
  "hn-hash-1",
  "R-OLD-1",
  "R-NEW-1",
  "rr-cipher-1",
  "IV-RR-1",
  "NOTE-BODY-1",
  "body-cipher-1",
  "IV-BODY-1",
  "AL-OLD-1",
  "AL-NEW-1",
  "v3:FUTURE-1",
  "sha256:UNSEEN-1",
  "ZZ-1",
  "NOTE-BODY-2",
  "body-cipher-2",
  "IV-BODY-2",
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
        leaks.push(`crypto key leaked at ${here.join(".")}`);
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

function assertClean(where: string, payload: unknown) {
  const leaks = findLeaks(payload);
  expect(
    leaks,
    `[${where}] leaked ${leaks.length} field(s):\n  ${leaks.join("\n  ")}`,
  ).toEqual([]);
  const serialised = JSON.stringify(payload);
  for (const m of FORBIDDEN_MARKERS) {
    expect(
      serialised.includes(m),
      `[${where}] response contained forbidden marker "${m}"`,
    ).toBe(false);
  }
}

function assertPageShape(where: string, page: any) {
  expect(page, `[${where}] page missing`).toBeTruthy();
  expect(Array.isArray(page.rows), `[${where}] rows not array`).toBe(true);
  expect(typeof page.hasMore).toBe("boolean");
  expect(typeof page.nextOffset).toBe("number");
  expect(typeof page.total).toBe("number");
  expect(typeof page.limit).toBe("number");
  expect(typeof page.offset).toBe("number");
  expect(["created_at", "action", "entity"]).toContain(page.sortBy);
  expect(["asc", "desc"]).toContain(page.sortDir);
}

// Recording query-builder stub — captures every builder call verbatim
// so we can assert the exact filter values passed to Supabase (no
// interpretation, no interpolation into raw SQL).
function makeRecordingAdmin(opts: {
  profilesResult?: { data: Array<{ id: string }> | null; error: unknown };
  auditResult?: { data: typeof RAW_ROWS | null; error: unknown; count: number };
}) {
  const calls: Array<{ table: string; ops: Array<[string, unknown[]]> }> = [];

  function makeChain(table: string, terminal: unknown) {
    const ops: Array<[string, unknown[]]> = [];
    const record: any = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "range" || prop === "limit") {
            return async (...args: unknown[]) => {
              ops.push([prop, args]);
              return terminal;
            };
          }
          if (prop === "then") {
            return (fn: (v: unknown) => unknown) => fn(terminal);
          }
          return (...args: unknown[]) => {
            ops.push([prop, args]);
            return record;
          };
        },
      },
    );
    calls.push({ table, ops });
    return record;
  }

  const auditResult =
    opts.auditResult ?? { data: RAW_ROWS, error: null, count: RAW_ROWS.length };
  const profilesResult =
    opts.profilesResult ?? { data: [], error: null };

  const admin = {
    from: (table: string) => {
      if (table === "audit_log") return makeChain(table, auditResult);
      if (table === "profiles") return makeChain(table, profilesResult);
      if (table === "referrals") return makeChain(table, { data: [], error: null });
      return makeChain(table, { data: [], error: null });
    },
  };
  return { admin, calls };
}

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

describe("getAuditLog — schema rejects genuinely invalid filter values at the boundary", () => {
  const BAD_INPUTS: Array<[string, unknown]> = [
    ["limit = 0", { limit: 0 }],
    ["limit negative", { limit: -5 }],
    ["limit non-integer", { limit: 3.5 }],
    ["limit above cap", { limit: 999 }],
    ["offset negative", { offset: -1 }],
    ["offset above cap", { offset: 10_000_000 }],
    ["sortBy unknown", { sortBy: "diff" }],
    ["sortDir unknown", { sortDir: "sideways" }],
    ["action unknown", { action: "purge" }],
    ["entity empty", { entity: "   " }],
    ["entity too long", { entity: "x".repeat(65) }],
    ["clinician empty", { clinician: "" }],
    ["clinician whitespace-only", { clinician: "     " }],
    ["clinician too long", { clinician: "y".repeat(121) }],
    ["specialty empty", { specialty: "" }],
    ["from not datetime", { from: "yesterday" }],
    ["from partial date", { from: "2026-07-11" }],
    ["to junk", { to: "not-a-time" }],
  ];

  for (const [label, input] of BAD_INPUTS) {
    it(`schema rejects: ${label}`, () => {
      const result = auditLogInputSchemaMirror.safeParse(input);
      expect(
        result.success,
        `schema unexpectedly accepted ${label} = ${JSON.stringify(input)}`,
      ).toBe(false);
      // Zod error bodies never contain any of our fixture markers.
      if (!result.success) {
        const err = JSON.stringify(result.error.issues);
        for (const m of FORBIDDEN_MARKERS) {
          expect(err.includes(m), `zod error surface leaked "${m}"`).toBe(false);
        }
      }
    });
  }
});

describe("getAuditLog — pathological but schema-passable inputs: stable + redacted", () => {
  it("malformed-UUID clinician (wrong hex length) falls to name branch and stays redacted", async () => {
    const bogusUuid = "1234-nope-not-a-uuid-really"; // fails UUID_RE
    const { admin, calls } = makeRecordingAdmin({});
    const page = await runGetAuditLog({ clinician: bogusUuid } as any, admin);

    // Name-branch: profiles.ilike(full_name, %bogus%) fires.
    const profiles = calls.find((c) => c.table === "profiles");
    expect(profiles, "profiles lookup must run for non-UUID clinician").toBeTruthy();
    const ilikeOp = profiles!.ops.find(([m]) => m === "ilike");
    expect(ilikeOp?.[1][0]).toBe("full_name");
    // The filter arg was passed to the query builder VERBATIM — no
    // interpretation, no interpolation into raw SQL.
    expect(String(ilikeOp?.[1][1] ?? "")).toBe(`%${bogusUuid}%`);

    // Profiles returned []; handler substitutes sentinel zero UUID.
    const audit = calls.find((c) => c.table === "audit_log")!;
    const inOp = audit.ops.find(([m]) => m === "in");
    expect(inOp?.[1][1]).toEqual(["00000000-0000-0000-0000-000000000000"]);

    assertPageShape("malformed UUID clinician", page);
    assertClean("malformed UUID clinician", page);
  });

  it("UUID-shaped clinician that matches nothing stays on UUID branch, empty and clean", async () => {
    // Valid UUID shape but not in DB. Handler must NOT hit profiles.
    const nonExistentUuid = "deadbeef-dead-beef-dead-beefdeadbeef";
    const { admin, calls } = makeRecordingAdmin({
      auditResult: { data: [], error: null, count: 0 },
    });
    const page = await runGetAuditLog({ clinician: nonExistentUuid } as any, admin);

    expect(calls.some((c) => c.table === "profiles")).toBe(false);
    const audit = calls.find((c) => c.table === "audit_log")!;
    const inOp = audit.ops.find(([m]) => m === "in");
    expect(inOp?.[1][0]).toBe("user_id");
    expect(inOp?.[1][1]).toEqual([nonExistentUuid]);

    expect(page.rows).toEqual([]);
    assertPageShape("non-existent UUID clinician", page);
    assertClean("non-existent UUID clinician", page);
  });

  it("SQL-injection / wildcard-shaped clinician name is passed verbatim to ilike, response redacted", async () => {
    const evil = "%'; DROP TABLE audit_log; --";
    const { admin, calls } = makeRecordingAdmin({});
    const page = await runGetAuditLog({ clinician: evil } as any, admin);

    const profiles = calls.find((c) => c.table === "profiles")!;
    const ilikeOp = profiles.ops.find(([m]) => m === "ilike");
    // supabase-js parameterises this — we just verify the handler
    // hands the value to the builder unchanged, not spliced into SQL.
    expect(ilikeOp?.[1][0]).toBe("full_name");
    expect(String(ilikeOp?.[1][1] ?? "")).toBe(`%${evil}%`);

    assertPageShape("wildcard/injection clinician", page);
    assertClean("wildcard/injection clinician", page);
  });

  it("reversed from/to (from > to) is passed through and yields a redacted page", async () => {
    // Zod accepts both as valid datetimes; ordering is a runtime concern.
    // A real PostgREST query with from > to returns zero rows; our stub
    // still returns fixture rows so we prove the handler redacts anyway.
    const from = "2026-08-01T00:00:00.000Z";
    const to = "2026-01-01T00:00:00.000Z";
    const { admin, calls } = makeRecordingAdmin({});
    const page = await runGetAuditLog({ from, to } as any, admin);

    const audit = calls.find((c) => c.table === "audit_log")!;
    const gte = audit.ops.find(([m]) => m === "gte");
    const lte = audit.ops.find(([m]) => m === "lte");
    // Handler passes both bounds unmodified — it does NOT silently
    // swap them, which would mask a caller bug.
    expect(gte?.[1]).toEqual(["created_at", from]);
    expect(lte?.[1]).toEqual(["created_at", to]);

    assertPageShape("reversed from/to", page);
    assertClean("reversed from/to", page);
  });

  it("from === to (zero-width window) is stable and redacted", async () => {
    const t = "2026-07-11T10:00:00.000Z";
    const { admin, calls } = makeRecordingAdmin({});
    const page = await runGetAuditLog({ from: t, to: t } as any, admin);

    const audit = calls.find((c) => c.table === "audit_log")!;
    expect(audit.ops.find(([m]) => m === "gte")?.[1]).toEqual(["created_at", t]);
    expect(audit.ops.find(([m]) => m === "lte")?.[1]).toEqual(["created_at", t]);
    assertPageShape("zero-width window", page);
    assertClean("zero-width window", page);
  });

  it("far-future from and far-past to are passed through, still redacted", async () => {
    const from = "9999-12-31T23:59:59.999Z";
    const to = "1970-01-01T00:00:00.000Z";
    const { admin } = makeRecordingAdmin({});
    const page = await runGetAuditLog({ from, to } as any, admin);
    assertPageShape("edge dates", page);
    assertClean("edge dates", page);
  });

  it("stacking every filter at once (entity+action+clinician+specialty+from+to) stays clean", async () => {
    const { admin, calls } = makeRecordingAdmin({
      profilesResult: {
        data: [{ id: "11111111-1111-1111-1111-111111111111" }],
        error: null,
      },
      // referrals lookup returns nothing → sentinel entity_id.
    });
    const page = await runGetAuditLog(
      {
        entity: "referral",
        action: "create",
        clinician: "Dr O'Brien-Smith", // punctuation
        specialty: "Cardio/Thoracic (adult)",
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-12-31T23:59:59.999Z",
        limit: 25,
        offset: 0,
        sortBy: "entity",
        sortDir: "asc",
      } as any,
      admin,
    );

    // Both resolver tables were consulted.
    expect(calls.some((c) => c.table === "profiles")).toBe(true);
    expect(calls.some((c) => c.table === "referrals")).toBe(true);
    const audit = calls.find((c) => c.table === "audit_log")!;
    // eq('entity','referral') AND eq('action','create') AND range bounds
    // AND user_id/entity_id .in() filters all landed.
    const eqs = audit.ops.filter(([m]) => m === "eq").map(([, a]) => a);
    expect(eqs).toEqual(
      expect.arrayContaining([["action", "create"]]),
    );
    // 'entity' may appear as eq twice (once from `entity` filter, once
    // from the specialty branch forcing entity='referral'); both fine.
    expect(eqs.some(([col, v]) => col === "entity" && v === "referral")).toBe(true);

    assertPageShape("stacked filters", page);
    assertClean("stacked filters", page);
  });
});
