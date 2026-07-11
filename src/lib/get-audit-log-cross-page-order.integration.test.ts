import { describe, it, expect } from "vitest";
import { runGetAuditLog, type AuditSortColumn } from "./admin.functions";

/**
 * Server-side integration: `getAuditLog` must return rows in the
 * requested order NOT ONLY inside a single page but ACROSS PAGE
 * BOUNDARIES — the last row of page N must sort correctly against
 * the first row of page N+1 under every (sortBy, sortDir) option.
 * At the same time, every row served on every page must be fully
 * redacted (no `_enc` / `_ciphertext` / `_nonce` / `_hash` keys,
 * no sensitive plaintext leaks).
 *
 * We drive the extracted `runGetAuditLog` helper against a
 * query-mimicking Supabase admin stub that honours `.order()` and
 * `.range()` on an in-memory dataset. Rows are loaded with
 * dangerous plaintext + crypto-suffix keys so any regression in
 * `redactAuditDiff` surfaces immediately.
 */

// ---------------------------------------------------------------------
// Fixture: 13 rows with distinct timestamps and a deliberate mix of
// action / entity values so ordering by non-time columns produces
// long identical-value runs that MUST resolve via the created_at
// tie-breaker the handler adds.
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

const USER = "11111111-1111-1111-1111-111111111111";

function dangerousDiff(seed: number): unknown {
  return {
    hospital_number: `H-PLAIN-${seed}`,
    hospital_number_enc: `v1:HN-CIPHER-${seed}`,
    hospital_number_hash: `hn-hash-${seed}`,
    reason_for_referral: { old: `R-OLD-${seed}`, new: `R-NEW-${seed}` },
    reason_for_referral_ciphertext: `rr-cipher-${seed}`,
    reason_for_referral_nonce: `IV-RR-${seed}`,
    nested: [
      {
        body: `NOTE-BODY-${seed}`,
        body_ciphertext: `body-cipher-${seed}`,
        body_nonce: `IV-BODY-${seed}`,
        deeper: {
          allergies: { old: `AL-OLD-${seed}`, new: `AL-NEW-${seed}` },
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

const ACTIONS: Row["action"][] = ["create", "update", "delete"];
const ENTITIES: Row["entity"][] = ["referral", "referral_note", "user_role"];

const DATASET: Row[] = Array.from({ length: 13 }, (_, i) => ({
  id: `row-${String(i).padStart(2, "0")}`,
  user_id: USER,
  action: ACTIONS[i % ACTIONS.length],
  entity: ENTITIES[Math.floor(i / 2) % ENTITIES.length],
  entity_id: `ent-${i}`,
  // Distinct, monotonically-increasing timestamps so the tie-breaker is well-defined.
  created_at: new Date(Date.UTC(2026, 6, 11, 10, i)).toISOString(),
  diff: dangerousDiff(i),
}));

const FORBIDDEN_MARKERS: string[] = [];
for (let i = 0; i < DATASET.length; i++) {
  FORBIDDEN_MARKERS.push(
    `H-PLAIN-${i}`,
    `v1:HN-CIPHER-${i}`,
    `hn-hash-${i}`,
    `R-OLD-${i}`,
    `R-NEW-${i}`,
    `rr-cipher-${i}`,
    `IV-RR-${i}`,
    `NOTE-BODY-${i}`,
    `body-cipher-${i}`,
    `IV-BODY-${i}`,
    `AL-OLD-${i}`,
    `AL-NEW-${i}`,
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
// Query-mimicking Supabase admin stub honouring order + range.
// Matches PostgREST semantics: multiple .order() calls chain as a
// composite sort key (later calls are secondary sort columns).
// ---------------------------------------------------------------------

function makeAdmin(rows: Row[]) {
  const calls: Array<{ table: string; ops: Array<[string, unknown[]]> }> = [];

  function auditBuilder(record: { table: string; ops: Array<[string, unknown[]]> }) {
    const orders: Array<{ column: string; ascending: boolean }> = [];
    const push = (op: string, args: unknown[]) => record.ops.push([op, args]);

    const chain: any = {
      select(cols: string, opts?: unknown) {
        push("select", [cols, opts]);
        return chain;
      },
      order(column: string, o?: { ascending?: boolean }) {
        push("order", [column, o]);
        orders.push({ column, ascending: o?.ascending ?? true });
        return chain;
      },
      eq(column: string, value: unknown) {
        push("eq", [column, value]);
        return chain;
      },
      in(column: string, values: unknown[]) {
        push("in", [column, values]);
        return chain;
      },
      gte(column: string, value: string) {
        push("gte", [column, value]);
        return chain;
      },
      lte(column: string, value: string) {
        push("lte", [column, value]);
        return chain;
      },
      async range(from: number, to: number) {
        push("range", [from, to]);
        const sorted = [...rows].sort((a, b) => {
          for (const { column, ascending } of orders) {
            const av = (a as any)[column];
            const bv = (b as any)[column];
            if (av < bv) return ascending ? -1 : 1;
            if (av > bv) return ascending ? 1 : -1;
          }
          return 0;
        });
        return {
          data: sorted.slice(from, to + 1),
          error: null,
          count: sorted.length,
        };
      },
    };
    return chain;
  }

  const admin = {
    from(table: string) {
      const record = { table, ops: [] as Array<[string, unknown[]]> };
      calls.push(record);
      if (table === "audit_log") return auditBuilder(record);
      return {
        select: () => ({
          ilike: () => ({
            limit: async () => ({ data: [], error: null }),
          }),
          in: () => ({}),
        }),
      };
    },
  };
  return { admin, calls };
}

// A stable comparator that mirrors the handler's stated ordering: the
// requested column, then created_at DESC as a tie-breaker for the
// non-time sorts. Purely a test oracle.
function makeComparator(sortBy: AuditSortColumn, sortDir: "asc" | "desc") {
  return (a: Row, b: Row) => {
    const av = (a as any)[sortBy];
    const bv = (b as any)[sortBy];
    if (av < bv) return sortDir === "asc" ? -1 : 1;
    if (av > bv) return sortDir === "asc" ? 1 : -1;
    if (sortBy !== "created_at") {
      // Tie-breaker: created_at DESC (added by the handler).
      if (a.created_at < b.created_at) return 1;
      if (a.created_at > b.created_at) return -1;
    }
    return 0;
  };
}

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

describe("getAuditLog — ordered results across page boundaries, always redacted", () => {
  const SORTS: Array<[AuditSortColumn, "asc" | "desc"]> = [
    ["created_at", "desc"],
    ["created_at", "asc"],
    ["action", "asc"],
    ["action", "desc"],
    ["entity", "asc"],
    ["entity", "desc"],
  ];

  for (const [sortBy, sortDir] of SORTS) {
    it(`sort=${sortBy}/${sortDir}: full order preserved across every page boundary`, async () => {
      const LIMIT = 4; // 13 rows → pages of 4/4/4/1
      const cmp = makeComparator(sortBy, sortDir);
      const expectedFullOrder = [...DATASET].sort(cmp);

      const collected: typeof expectedFullOrder = [];
      let offset = 0;
      let previousLast: (typeof expectedFullOrder)[number] | null = null;
      let pageNumber = 0;

      // eslint-disable-next-line no-constant-condition
      while (true) {
        pageNumber++;
        expect(pageNumber, `${sortBy}/${sortDir} paginated too many times`).toBeLessThan(20);
        const { admin, calls } = makeAdmin(DATASET);
        const page = await runGetAuditLog(
          { limit: LIMIT, offset, sortBy, sortDir } as any,
          admin,
        );

        // Handler emitted the requested ORDER + secondary tie-breaker.
        const audit = calls.find((c) => c.table === "audit_log")!;
        const orderOps = audit.ops.filter(([m]) => m === "order");
        expect(orderOps[0][1][0]).toBe(sortBy);
        expect((orderOps[0][1][1] as any).ascending).toBe(sortDir === "asc");
        if (sortBy !== "created_at") {
          // Tie-breaker on created_at is added for non-time sorts.
          const secondary = orderOps[1];
          expect(secondary, "expected secondary .order() call for non-time sort").toBeTruthy();
          expect(secondary[1][0]).toBe("created_at");
        }

        // Response echoes the requested pagination parameters.
        expect(page.limit).toBe(LIMIT);
        expect(page.offset).toBe(offset);
        expect(page.sortBy).toBe(sortBy);
        expect(page.sortDir).toBe(sortDir);
        expect(page.total).toBe(DATASET.length);

        // Rows within the page are ordered.
        for (let i = 1; i < page.rows.length; i++) {
          const prev = page.rows[i - 1] as any;
          const curr = page.rows[i] as any;
          expect(
            cmp(prev, curr) <= 0,
            `${sortBy}/${sortDir}: intra-page order broken at page ${pageNumber} index ${i} ` +
              `(prev.${sortBy}=${prev[sortBy]} > curr.${sortBy}=${curr[sortBy]})`,
          ).toBe(true);
        }

        // ACROSS-PAGE boundary: last row of previous page must
        // sort <= first row of this page under the same comparator.
        if (previousLast && page.rows.length > 0) {
          const first = page.rows[0] as any;
          expect(
            cmp(previousLast as any, first) <= 0,
            `${sortBy}/${sortDir}: cross-page order broken between page ${pageNumber - 1} → ${pageNumber}: ` +
              `${(previousLast as any)[sortBy]} vs ${first[sortBy]}`,
          ).toBe(true);
        }

        // Every row on this page is fully redacted.
        assertClean(`sort=${sortBy}/${sortDir} page@offset=${offset}`, page);

        collected.push(...(page.rows as any));
        if (page.rows.length > 0) previousLast = page.rows[page.rows.length - 1] as any;
        if (!page.hasMore || page.rows.length < LIMIT) break;
        offset += LIMIT;
      }

      // Assembled traversal matches the expected global order by id.
      expect(collected.length).toBe(DATASET.length);
      expect(collected.map((r) => r.id)).toEqual(expectedFullOrder.map((r) => r.id));
    });
  }
});
