import { describe, it, expect } from "vitest";
import { runGetAuditLog, type AuditSortColumn } from "./admin.functions";

/**
 * Server-side integration: `getAuditLog` must return correctly redacted
 * rows on EVERY page and under EVERY sort order, even when combined
 * with the filter surface (entity / action / clinician / specialty /
 * from / to).
 *
 * We drive the extracted `runGetAuditLog` helper (the exact code the
 * server-fn `.handler` invokes after `assertAdmin` succeeds) with a
 * mocked Supabase admin client that:
 *
 *  - records every builder call (`.eq`, `.in`, `.gte`, `.lte`, `.order`,
 *    `.range`) so we can assert the emitted SQL shape matches the
 *    inputs (sortBy / sortDir / offset+limit slicing, and each active
 *    filter);
 *  - filters and sorts an in-memory dataset the same way PostgREST
 *    would, so page N gets a genuinely different slice than page N-1;
 *  - serves rows loaded with dangerous plaintext AND encrypted
 *    ciphertext/hash/nonce keys at multiple depths.
 *
 * For every (page × sort × filter) combination we assert that the
 * response contains no `_enc` / `_ciphertext` / `_nonce` / `_hash`
 * key at any depth, no sensitive plaintext column, and none of the
 * raw ciphertext / plaintext markers the mock served.
 */

// ---------------------------------------------------------------------
// Fixture: a synthetic audit_log with 12 rows spanning 3 clinicians,
// 3 entities, and 3 actions. Every diff carries dangerous keys.
// ---------------------------------------------------------------------

type Row = {
  id: string;
  user_id: string;
  action: "create" | "update" | "delete";
  entity: "referral" | "referral_note" | "user_role";
  entity_id: string;
  created_at: string;
  diff: unknown;
};

const CLINICIAN_A = "11111111-1111-1111-1111-111111111111";
const CLINICIAN_B = "22222222-2222-2222-2222-222222222222";
const CLINICIAN_C = "33333333-3333-3333-3333-333333333333";
const CLINICIANS = [CLINICIAN_A, CLINICIAN_B, CLINICIAN_C];
const ENTITIES = ["referral", "referral_note", "user_role"] as const;
const ACTIONS = ["create", "update", "delete"] as const;

function dangerousDiff(seed: number): unknown {
  return {
    hospital_number: `H-PLAIN-${seed}`,
    hospital_number_enc: `v1:HN-CIPHER-${seed}`,
    hospital_number_hash: `hn-hash-${seed}`,
    reason_for_referral: {
      old: `REASON-OLD-${seed}`,
      new: `REASON-NEW-${seed}`,
    },
    reason_for_referral_ciphertext: `rr-cipher-${seed}`,
    reason_for_referral_nonce: `IV-RR-${seed}`,
    nested: [
      {
        body: `NOTE-BODY-${seed}`,
        body_ciphertext: `body-cipher-${seed}`,
        body_nonce: `IV-BODY-${seed}`,
        deeper: {
          allergies: { old: `ALLERGY-OLD-${seed}`, new: `ALLERGY-NEW-${seed}` },
          unknown_future_enc: `v3:FUTURE-${seed}`,
          audit_wrapper: {
            nested_hash: `sha256:UNSEEN-${seed}`,
            patient_initials: `ZZ-${seed}`,
          },
        },
      },
    ],
    status: "pending",
  };
}

const ALL_ROWS: Row[] = Array.from({ length: 12 }, (_, i) => ({
  id: `row-${String(i).padStart(2, "0")}`,
  user_id: CLINICIANS[i % CLINICIANS.length],
  action: ACTIONS[i % ACTIONS.length],
  entity: ENTITIES[i % ENTITIES.length],
  entity_id: `ent-${i}`,
  // Distinct, monotonic timestamps so sort-order assertions are unambiguous.
  created_at: new Date(Date.UTC(2026, 6, 11, 10, i)).toISOString(),
  diff: dangerousDiff(i),
}));

// Every distinct string value that must NOT appear in the response.
const FORBIDDEN_MARKERS: string[] = [];
for (let i = 0; i < ALL_ROWS.length; i++) {
  FORBIDDEN_MARKERS.push(
    `H-PLAIN-${i}`,
    `v1:HN-CIPHER-${i}`,
    `hn-hash-${i}`,
    `REASON-OLD-${i}`,
    `REASON-NEW-${i}`,
    `rr-cipher-${i}`,
    `IV-RR-${i}`,
    `NOTE-BODY-${i}`,
    `body-cipher-${i}`,
    `IV-BODY-${i}`,
    `ALLERGY-OLD-${i}`,
    `ALLERGY-NEW-${i}`,
    `v3:FUTURE-${i}`,
    `sha256:UNSEEN-${i}`,
    `ZZ-${i}`,
  );
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

// ---------------------------------------------------------------------
// Query-mimicking Supabase admin stub.
// ---------------------------------------------------------------------

type Filter =
  | { kind: "eq"; column: string; value: unknown }
  | { kind: "in"; column: string; values: unknown[] }
  | { kind: "gte"; column: string; value: string }
  | { kind: "lte"; column: string; value: string };

type OrderSpec = { column: string; ascending: boolean };

function makeAdmin(opts: {
  profilesFor?: (needle: string) => Array<{ id: string }>;
  referralsFor?: (needle: string) => Array<{ id: string }>;
}) {
  const calls: Array<{ table: string; ops: Array<[string, unknown[]]> }> = [];

  function auditBuilder(record: { table: string; ops: Array<[string, unknown[]]> }) {
    const filters: Filter[] = [];
    const orders: OrderSpec[] = [];
    const push = (op: string, args: unknown[]) => record.ops.push([op, args]);

    const chain: any = {
      select(_cols: string, _opts?: unknown) {
        push("select", [_cols, _opts]);
        return chain;
      },
      order(column: string, o?: { ascending?: boolean }) {
        push("order", [column, o]);
        orders.push({ column, ascending: o?.ascending ?? true });
        return chain;
      },
      eq(column: string, value: unknown) {
        push("eq", [column, value]);
        filters.push({ kind: "eq", column, value });
        return chain;
      },
      in(column: string, values: unknown[]) {
        push("in", [column, values]);
        filters.push({ kind: "in", column, values });
        return chain;
      },
      gte(column: string, value: string) {
        push("gte", [column, value]);
        filters.push({ kind: "gte", column, value });
        return chain;
      },
      lte(column: string, value: string) {
        push("lte", [column, value]);
        filters.push({ kind: "lte", column, value });
        return chain;
      },
      async range(from: number, to: number) {
        push("range", [from, to]);
        // Apply filters
        let rows = ALL_ROWS.filter((r) => {
          for (const f of filters) {
            if (f.kind === "eq" && (r as any)[f.column] !== f.value) return false;
            if (f.kind === "in" && !f.values.includes((r as any)[f.column])) return false;
            if (f.kind === "gte" && String((r as any)[f.column]) < f.value) return false;
            if (f.kind === "lte" && String((r as any)[f.column]) > f.value) return false;
          }
          return true;
        });
        // Apply orders (stable sort chain)
        const total = rows.length;
        for (let i = orders.length - 1; i >= 0; i--) {
          const { column, ascending } = orders[i];
          rows = [...rows].sort((a, b) => {
            const av = (a as any)[column];
            const bv = (b as any)[column];
            if (av < bv) return ascending ? -1 : 1;
            if (av > bv) return ascending ? 1 : -1;
            return 0;
          });
        }
        // Slice: handler uses range(offset, offset+limit) → limit+1 rows
        const slice = rows.slice(from, to + 1);
        return { data: slice, error: null, count: total };
      },
    };
    return chain;
  }

  function simpleBuilder(
    record: { table: string; ops: Array<[string, unknown[]]> },
    resolver: (needle: string | null) => Array<{ id: string }>,
  ) {
    let needle: string | null = null;
    const chain: any = {
      select(cols: string) {
        record.ops.push(["select", [cols]]);
        return chain;
      },
      ilike(column: string, pattern: string) {
        record.ops.push(["ilike", [column, pattern]]);
        needle = pattern.replace(/%/g, "");
        return chain;
      },
      async limit(n: number) {
        record.ops.push(["limit", [n]]);
        return { data: resolver(needle), error: null };
      },
    };
    return chain;
  }

  const admin = {
    from(table: string) {
      const record = { table, ops: [] as Array<[string, unknown[]]> };
      calls.push(record);
      if (table === "audit_log") return auditBuilder(record);
      if (table === "profiles") {
        return simpleBuilder(record, (n) =>
          opts.profilesFor ? opts.profilesFor(n ?? "") : [],
        );
      }
      if (table === "referrals") {
        return simpleBuilder(record, (n) =>
          opts.referralsFor ? opts.referralsFor(n ?? "") : [],
        );
      }
      return simpleBuilder(record, () => []);
    },
  };
  return { admin, calls };
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

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

describe("getAuditLog — redaction across pagination, sort orders, and filters", () => {
  const SORTS: Array<[AuditSortColumn, "asc" | "desc"]> = [
    ["created_at", "desc"],
    ["created_at", "asc"],
    ["action", "asc"],
    ["action", "desc"],
    ["entity", "asc"],
    ["entity", "desc"],
  ];

  it("paginates through every page under each sort order and returns fully redacted rows", async () => {
    const LIMIT = 3;
    for (const [sortBy, sortDir] of SORTS) {
      const seenIds = new Set<string>();
      let offset = 0;
      let iteration = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        iteration++;
        expect(iteration, `${sortBy}/${sortDir} paginated too many times`).toBeLessThan(20);
        const { admin, calls } = makeAdmin({});
        const page = await runGetAuditLog(
          { limit: LIMIT, offset, sortBy, sortDir } as any,
          admin,
        );

        // Response shape reflects the requested slice + sort.
        expect(page.limit).toBe(LIMIT);
        expect(page.offset).toBe(offset);
        expect(page.sortBy).toBe(sortBy);
        expect(page.sortDir).toBe(sortDir);
        expect(page.rows.length).toBeLessThanOrEqual(LIMIT);

        // The audit_log query received the requested sort + range.
        const audit = calls.find((c) => c.table === "audit_log")!;
        const orderOps = audit.ops.filter(([m]) => m === "order");
        expect(orderOps[0][1][0]).toBe(sortBy);
        expect((orderOps[0][1][1] as any).ascending).toBe(sortDir === "asc");
        const rangeOp = audit.ops.find(([m]) => m === "range")!;
        expect(rangeOp[1]).toEqual([offset, offset + LIMIT]);

        // Rows returned on this page are internally ordered as requested.
        for (let i = 1; i < page.rows.length; i++) {
          const prev = (page.rows[i - 1] as any)[sortBy];
          const curr = (page.rows[i] as any)[sortBy];
          if (sortDir === "asc") expect(prev <= curr).toBe(true);
          else expect(prev >= curr).toBe(true);
        }

        // Every row is fully redacted.
        assertClean(
          `sort=${sortBy}/${sortDir} page@offset=${offset}`,
          page,
        );

        for (const r of page.rows) seenIds.add(r.id);
        if (!page.hasMore || page.rows.length === 0) break;
        offset += LIMIT;
      }
      // Full traversal covered the entire dataset.
      expect(seenIds.size).toBe(ALL_ROWS.length);
    }
  });

  it("returns redacted rows across pages when combined with entity+action+date filters", async () => {
    const LIMIT = 2;
    const from = ALL_ROWS[2].created_at;
    const to = ALL_ROWS[10].created_at;
    let offset = 0;
    let iteration = 0;
    let totalSeen = 0;
    while (true) {
      iteration++;
      expect(iteration).toBeLessThan(20);
      const { admin, calls } = makeAdmin({});
      const page = await runGetAuditLog(
        {
          limit: LIMIT,
          offset,
          sortBy: "created_at",
          sortDir: "asc",
          entity: "referral",
          action: "create",
          from,
          to,
        } as any,
        admin,
      );

      // Filters landed on the query builder.
      const audit = calls.find((c) => c.table === "audit_log")!;
      const eqs = audit.ops.filter(([m]) => m === "eq").map(([, a]) => a);
      expect(eqs).toEqual(
        expect.arrayContaining([["entity", "referral"], ["action", "create"]]),
      );
      const gte = audit.ops.find(([m]) => m === "gte")!;
      const lte = audit.ops.find(([m]) => m === "lte")!;
      expect(gte[1]).toEqual(["created_at", from]);
      expect(lte[1]).toEqual(["created_at", to]);

      // Every row still matches the filter shape.
      for (const r of page.rows) {
        expect(r.entity).toBe("referral");
        expect(r.action).toBe("create");
        expect(r.created_at >= from && r.created_at <= to).toBe(true);
      }

      assertClean(`filtered page@offset=${offset}`, page);

      totalSeen += page.rows.length;
      if (!page.hasMore || page.rows.length === 0) break;
      offset += LIMIT;
    }
    // Sanity: we actually paged through something under the filter.
    expect(totalSeen).toBeGreaterThan(0);
  });

  it("clinician-name filter combined with pagination redacts every page", async () => {
    const { admin, calls } = makeAdmin({
      profilesFor: () => [{ id: CLINICIAN_A }, { id: CLINICIAN_B }],
    });
    const page1 = await runGetAuditLog(
      { limit: 2, offset: 0, sortBy: "created_at", sortDir: "desc", clinician: "Dr Smith" } as any,
      admin,
    );
    expect(calls.some((c) => c.table === "profiles")).toBe(true);
    for (const r of page1.rows) {
      expect([CLINICIAN_A, CLINICIAN_B]).toContain(r.user_id);
    }
    assertClean("clinician-name page 1", page1);

    if (page1.hasMore) {
      const { admin: admin2 } = makeAdmin({
        profilesFor: () => [{ id: CLINICIAN_A }, { id: CLINICIAN_B }],
      });
      const page2 = await runGetAuditLog(
        { limit: 2, offset: 2, sortBy: "created_at", sortDir: "desc", clinician: "Dr Smith" } as any,
        admin2,
      );
      // Rows are strictly different across pages.
      const p1ids = new Set(page1.rows.map((r) => r.id));
      for (const r of page2.rows) expect(p1ids.has(r.id)).toBe(false);
      assertClean("clinician-name page 2", page2);
    }
  });
});
