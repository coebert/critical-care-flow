import { describe, it, expect } from "vitest";
import { runGetAuditLog } from "./admin.functions";

/**
 * Contract / snapshot tests for `getAuditLog`.
 *
 * These pin down the EXACT shape of the redacted response for a matrix
 * of valid filter combinations. Any future change that would let a
 * crypto-suffix key (`_enc`, `_ciphertext`, `_nonce`, `_hash`) or a
 * sensitive plaintext value escape via the API will flip a snapshot.
 *
 * The stub returns a fixed fixture regardless of filter arguments, so
 * every snapshot is deterministic; the filter's job in this suite is to
 * exercise the handler's response-assembly branches (page metadata,
 * sortBy/sortDir echoing, offset/limit passthrough, hasMore
 * calculation, total from count) without touching the redactor logic.
 *
 * Companion to the field-by-field sweep in the other integration
 * suites — this one asserts the WHOLE payload, key-set included.
 */

// ---------------------------------------------------------------------
// Deterministic fixture (dangerous values everywhere).
// ---------------------------------------------------------------------

const RAW_ROWS = [
  {
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    user_id: "11111111-1111-1111-1111-111111111111",
    action: "create",
    entity: "referral",
    entity_id: "rrrrrrrr-rrrr-rrrr-rrrr-rrrrrrrrrrrr",
    created_at: "2026-07-11T10:00:00.000Z",
    diff: {
      status: "pending",
      hospital_number: "H-SNAP-1",
      hospital_number_enc: "v1:HN-SNAP-CIPHER-1",
      hospital_number_hash: "hn-snap-hash-1",
      reason_for_referral: { old: "RR-SNAP-OLD-1", new: "RR-SNAP-NEW-1" },
      reason_for_referral_ciphertext: "rr-snap-cipher-1",
      reason_for_referral_nonce: "IV-RR-SNAP-1",
      patient_initials: "AA-SNAP-1",
      allergies: null,
      nested: [
        {
          body: "NOTE-SNAP-BODY-1",
          body_ciphertext: "body-snap-cipher-1",
          body_nonce: "IV-BODY-SNAP-1",
          untouched_field: "keep-me-1",
        },
      ],
    },
  },
  {
    id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    user_id: "22222222-2222-2222-2222-222222222222",
    action: "update",
    entity: "referral_note",
    entity_id: "nnnnnnnn-nnnn-nnnn-nnnn-nnnnnnnnnnnn",
    created_at: "2026-07-11T10:05:00.000Z",
    diff: {
      body: { old: "NOTE-SNAP-BODY-2-OLD", new: "NOTE-SNAP-BODY-2-NEW" },
      body_ciphertext: "body-snap-cipher-2",
      body_nonce: "IV-BODY-SNAP-2",
      author_id: "22222222-2222-2222-2222-222222222222",
    },
  },
];

// Every marker below MUST be absent from the serialised response.
const FORBIDDEN_MARKERS = [
  "H-SNAP-1",
  "v1:HN-SNAP-CIPHER-1",
  "hn-snap-hash-1",
  "RR-SNAP-OLD-1",
  "RR-SNAP-NEW-1",
  "rr-snap-cipher-1",
  "IV-RR-SNAP-1",
  "AA-SNAP-1",
  "NOTE-SNAP-BODY-1",
  "body-snap-cipher-1",
  "IV-BODY-SNAP-1",
  "NOTE-SNAP-BODY-2-OLD",
  "NOTE-SNAP-BODY-2-NEW",
  "body-snap-cipher-2",
  "IV-BODY-SNAP-2",
];

const CRYPTO_SUFFIXES = ["_enc", "_ciphertext", "_nonce", "_hash"];

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

function assertNoCryptoKeys(where: string, payload: unknown) {
  const keys = collectKeys(payload);
  const bad = [...keys].filter((k) => CRYPTO_SUFFIXES.some((s) => k.endsWith(s)));
  expect(bad, `[${where}] crypto-suffix keys leaked: ${bad.join(", ")}`).toEqual([]);
}

function assertNoMarkers(where: string, payload: unknown) {
  const serialised = JSON.stringify(payload);
  for (const m of FORBIDDEN_MARKERS) {
    expect(
      serialised.includes(m),
      `[${where}] response contained forbidden marker "${m}"`,
    ).toBe(false);
  }
}

// Query-builder stub that always returns the same fixture, ignoring
// filters. That's the point: response shape is what we're pinning.
function makeAdmin(overrides?: {
  auditRows?: typeof RAW_ROWS;
  count?: number;
  profiles?: Array<{ id: string }>;
  referrals?: Array<{ id: string }>;
}) {
  const rows = overrides?.auditRows ?? RAW_ROWS;
  const count = overrides?.count ?? rows.length;
  const profiles = overrides?.profiles ?? [];
  const referrals = overrides?.referrals ?? [];

  function makeChain(terminal: unknown) {
    const record: any = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "range" || prop === "limit") {
            return async () => terminal;
          }
          if (prop === "then") {
            return (fn: (v: unknown) => unknown) => fn(terminal);
          }
          return () => record;
        },
      },
    );
    return record;
  }

  return {
    from: (table: string) => {
      if (table === "audit_log")
        return makeChain({ data: rows, error: null, count });
      if (table === "profiles") return makeChain({ data: profiles, error: null });
      if (table === "referrals")
        return makeChain({ data: referrals, error: null });
      return makeChain({ data: [], error: null });
    },
  };
}

// ---------------------------------------------------------------------
// Contract snapshot: canonical redacted rows.
//
// This is the reference shape. Every combination test below asserts
// that its `rows` equal this canonical array — the filters only affect
// page metadata (limit/offset/sortBy/sortDir), not the row shape.
// ---------------------------------------------------------------------

const EXPECTED_ROWS = [
  {
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    user_id: "11111111-1111-1111-1111-111111111111",
    action: "create",
    entity: "referral",
    entity_id: "rrrrrrrr-rrrr-rrrr-rrrr-rrrrrrrrrrrr",
    created_at: "2026-07-11T10:00:00.000Z",
    diff: {
      status: "pending",
      hospital_number: "[encrypted]",
      reason_for_referral: { old: "[encrypted]", new: "[encrypted]" },
      patient_initials: "[encrypted]",
      allergies: null,
      nested: [
        {
          body: "[encrypted]",
          untouched_field: "keep-me-1",
        },
      ],
    },
  },
  {
    id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    user_id: "22222222-2222-2222-2222-222222222222",
    action: "update",
    entity: "referral_note",
    entity_id: "nnnnnnnn-nnnn-nnnn-nnnn-nnnnnnnnnnnn",
    created_at: "2026-07-11T10:05:00.000Z",
    diff: {
      body: { old: "[encrypted]", new: "[encrypted]" },
      author_id: "22222222-2222-2222-2222-222222222222",
    },
  },
];

// Filter combinations that MUST all yield the same redacted rows.
// Each entry is: [label, filters, expectedPageMeta].
type PageMeta = {
  limit: number;
  offset: number;
  sortBy: "created_at" | "action" | "entity";
  sortDir: "asc" | "desc";
  hasMore: boolean;
  nextOffset: number;
  total: number;
};

const COMBINATIONS: Array<[string, any, PageMeta]> = [
  [
    "defaults (no filters)",
    {},
    { limit: 50, offset: 0, sortBy: "created_at", sortDir: "desc", hasMore: false, nextOffset: 50, total: 2 },
  ],
  [
    "entity=referral",
    { entity: "referral" },
    { limit: 50, offset: 0, sortBy: "created_at", sortDir: "desc", hasMore: false, nextOffset: 50, total: 2 },
  ],
  [
    "action=update",
    { action: "update" },
    { limit: 50, offset: 0, sortBy: "created_at", sortDir: "desc", hasMore: false, nextOffset: 50, total: 2 },
  ],
  [
    "clinician=UUID (direct user_id)",
    { clinician: "11111111-1111-1111-1111-111111111111" },
    { limit: 50, offset: 0, sortBy: "created_at", sortDir: "desc", hasMore: false, nextOffset: 50, total: 2 },
  ],
  [
    "clinician=name (ilike branch)",
    { clinician: "Dr Smith" },
    { limit: 50, offset: 0, sortBy: "created_at", sortDir: "desc", hasMore: false, nextOffset: 50, total: 2 },
  ],
  [
    "specialty",
    { specialty: "cardiology" },
    { limit: 50, offset: 0, sortBy: "created_at", sortDir: "desc", hasMore: false, nextOffset: 50, total: 2 },
  ],
  [
    "date window",
    {
      from: "2026-07-11T00:00:00.000Z",
      to: "2026-07-11T23:59:59.999Z",
    },
    { limit: 50, offset: 0, sortBy: "created_at", sortDir: "desc", hasMore: false, nextOffset: 50, total: 2 },
  ],
  [
    "custom paging + sort (limit=10, offset=20, sortBy=action asc)",
    { limit: 10, offset: 20, sortBy: "action", sortDir: "asc" },
    { limit: 10, offset: 20, sortBy: "action", sortDir: "asc", hasMore: false, nextOffset: 30, total: 2 },
  ],
  [
    "sortBy=entity desc",
    { sortBy: "entity", sortDir: "desc" },
    { limit: 50, offset: 0, sortBy: "entity", sortDir: "desc", hasMore: false, nextOffset: 50, total: 2 },
  ],
  [
    "all filters stacked",
    {
      entity: "referral",
      action: "create",
      clinician: "Dr Smith",
      specialty: "cardiology",
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-12-31T23:59:59.999Z",
      limit: 25,
      offset: 0,
      sortBy: "created_at",
      sortDir: "desc",
    },
    { limit: 25, offset: 0, sortBy: "created_at", sortDir: "desc", hasMore: false, nextOffset: 25, total: 2 },
  ],
];

describe("getAuditLog — contract snapshot for redacted response shape", () => {
  for (const [label, filters, meta] of COMBINATIONS) {
    it(`[${label}] response matches canonical redacted shape`, async () => {
      const admin = makeAdmin({
        profiles: [{ id: "11111111-1111-1111-1111-111111111111" }],
        referrals: [
          { id: "rrrrrrrr-rrrr-rrrr-rrrr-rrrrrrrrrrrr" },
        ],
      });
      const page = await runGetAuditLog(filters, admin);

      // Exact page-metadata contract.
      expect({
        limit: page.limit,
        offset: page.offset,
        sortBy: page.sortBy,
        sortDir: page.sortDir,
        hasMore: page.hasMore,
        nextOffset: page.nextOffset,
        total: page.total,
      }).toEqual(meta);

      // Exact row shape contract — no extra keys, no missing keys, no
      // crypto suffixes, sensitive values replaced with "[encrypted]".
      expect(page.rows).toEqual(EXPECTED_ROWS);

      // Belt-and-braces sweeps.
      assertNoCryptoKeys(label, page);
      assertNoMarkers(label, page);

      // Inline snapshot pins the top-level payload keys.
      expect(Object.keys(page).sort()).toMatchInlineSnapshot(`
        [
          "hasMore",
          "limit",
          "nextOffset",
          "offset",
          "rows",
          "sortBy",
          "sortDir",
          "total",
        ]
      `);

      // Inline snapshot pins the per-row keys.
      expect(page.rows.map((r) => Object.keys(r).sort())).toMatchInlineSnapshot(`
        [
          [
            "action",
            "created_at",
            "diff",
            "entity",
            "entity_id",
            "id",
            "user_id",
          ],
          [
            "action",
            "created_at",
            "diff",
            "entity",
            "entity_id",
            "id",
            "user_id",
          ],
        ]
      `);
    });
  }

  it("empty dataset preserves shape and pins the empty-response snapshot", async () => {
    const admin = makeAdmin({ auditRows: [], count: 0 });
    const page = await runGetAuditLog({}, admin);
    expect(page).toMatchInlineSnapshot(`
      {
        "hasMore": false,
        "limit": 50,
        "nextOffset": 50,
        "offset": 0,
        "rows": [],
        "sortBy": "created_at",
        "sortDir": "desc",
        "total": 0,
      }
    `);
    assertNoCryptoKeys("empty", page);
    assertNoMarkers("empty", page);
  });

  it("canonical rows snapshot pins full redacted structure", async () => {
    const admin = makeAdmin({
      profiles: [{ id: "11111111-1111-1111-1111-111111111111" }],
      referrals: [{ id: "rrrrrrrr-rrrr-rrrr-rrrr-rrrrrrrrrrrr" }],
    });
    const page = await runGetAuditLog({}, admin);
    expect(page.rows).toMatchInlineSnapshot(`
      [
        {
          "action": "create",
          "created_at": "2026-07-11T10:00:00.000Z",
          "diff": {
            "allergies": null,
            "hospital_number": "[encrypted]",
            "nested": [
              {
                "body": "[encrypted]",
                "untouched_field": "keep-me-1",
              },
            ],
            "patient_initials": "[encrypted]",
            "reason_for_referral": {
              "new": "[encrypted]",
              "old": "[encrypted]",
            },
            "status": "pending",
          },
          "entity": "referral",
          "entity_id": "rrrrrrrr-rrrr-rrrr-rrrr-rrrrrrrrrrrr",
          "id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          "user_id": "11111111-1111-1111-1111-111111111111",
        },
        {
          "action": "update",
          "created_at": "2026-07-11T10:05:00.000Z",
          "diff": {
            "author_id": "22222222-2222-2222-2222-222222222222",
            "body": {
              "new": "[encrypted]",
              "old": "[encrypted]",
            },
          },
          "entity": "referral_note",
          "entity_id": "nnnnnnnn-nnnn-nnnn-nnnn-nnnnnnnnnnnn",
          "id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
          "user_id": "22222222-2222-2222-2222-222222222222",
        },
      ]
    `);
  });
});
