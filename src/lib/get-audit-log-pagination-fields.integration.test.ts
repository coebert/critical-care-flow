import { describe, it, expect } from "vitest";
import { runGetAuditLog } from "./admin.functions";

/**
 * Integration: `getAuditLog` pagination FIELD contract across sorts.
 *
 * The sibling suites `-cross-page-order` and `-pagination-sort-redaction`
 * assert row ORDERING and payload REDACTION respectively. This suite
 * pins down the numeric page-metadata contract — `total`, `limit`,
 * `offset`, `hasMore`, `nextOffset` — across every sort option and at
 * every page boundary:
 *
 *   - first page (offset=0)
 *   - interior page
 *   - last full page
 *   - final partial page
 *   - exactly-at-total page (offset === total)
 *   - past-the-end page (offset > total)
 *
 * For every case, the response must also be free of crypto-suffix keys
 * (`_enc` / `_ciphertext` / `_nonce` / `_hash`) and known-sensitive
 * plaintext values.
 */

// ---------------------------------------------------------------------
// Fixture — 23 rows so pages of 5 & 7 don't divide evenly, forcing us
// to exercise a genuine final-partial-page.
// ---------------------------------------------------------------------

const TOTAL_ROWS = 23;

function makeFixtureRows() {
  const rows: Array<{
    id: string;
    user_id: string;
    action: "create" | "update" | "delete";
    entity: string;
    entity_id: string;
    created_at: string;
    diff: Record<string, unknown>;
  }> = [];
  for (let i = 0; i < TOTAL_ROWS; i++) {
    const idx = String(i).padStart(3, "0");
    const action = (["create", "update", "delete"] as const)[i % 3];
    const entity = (["referral", "referral_note", "bed"] as const)[i % 3];
    rows.push({
      id: `aaaaaaaa-aaaa-aaaa-aaaa-${idx.padStart(12, "0")}`,
      user_id: "11111111-1111-1111-1111-111111111111",
      action,
      entity,
      entity_id: `eeeeeeee-eeee-eeee-eeee-${idx.padStart(12, "0")}`,
      // Distinct timestamps so ordering is unambiguous.
      created_at: new Date(2026, 6, 11, 10, 0, i).toISOString(),
      diff: {
        // Sensitive plaintext + crypto-suffix keys everywhere.
        hospital_number: `H-PAGE-${idx}`,
        hospital_number_enc: `v1:HN-PAGE-CIPHER-${idx}`,
        hospital_number_hash: `hn-page-hash-${idx}`,
        reason_for_referral: {
          old: `RR-PAGE-OLD-${idx}`,
          new: `RR-PAGE-NEW-${idx}`,
        },
        reason_for_referral_ciphertext: `rr-page-cipher-${idx}`,
        reason_for_referral_nonce: `IV-RR-PAGE-${idx}`,
        body: `NOTE-PAGE-BODY-${idx}`,
        body_ciphertext: `body-page-cipher-${idx}`,
        body_nonce: `IV-BODY-PAGE-${idx}`,
        allergies: {
          old: `AL-PAGE-OLD-${idx}`,
          new: `AL-PAGE-NEW-${idx}`,
        },
        status: "pending", // safe passthrough
        row_index: i, // safe passthrough — used for ordering assertions
      },
    });
  }
  return rows;
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
        leaks.push(`crypto key at ${here.join(".")}`);
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
          leaks.push(`sensitive plaintext at ${here.join(".")}`);
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
  expect(leaks, `[${where}] leaks: ${leaks.join(", ")}`).toEqual([]);
  const serialised = JSON.stringify(payload);
  // Fixture markers must never appear anywhere in the payload.
  expect(serialised).not.toMatch(/H-PAGE-\d{3}/);
  expect(serialised).not.toMatch(/HN-PAGE-CIPHER-\d{3}/);
  expect(serialised).not.toMatch(/hn-page-hash-\d{3}/);
  expect(serialised).not.toMatch(/RR-PAGE-(OLD|NEW)-\d{3}/);
  expect(serialised).not.toMatch(/rr-page-cipher-\d{3}/);
  expect(serialised).not.toMatch(/IV-RR-PAGE-\d{3}/);
  expect(serialised).not.toMatch(/NOTE-PAGE-BODY-\d{3}/);
  expect(serialised).not.toMatch(/body-page-cipher-\d{3}/);
  expect(serialised).not.toMatch(/IV-BODY-PAGE-\d{3}/);
  expect(serialised).not.toMatch(/AL-PAGE-(OLD|NEW)-\d{3}/);
}

// ---------------------------------------------------------------------
// Supabase-admin stub — implements .order() / .range() with in-memory
// sort + slice so page metadata is genuinely exercised.
//
// Notes on `.range(from, to)`: PostgREST semantics are INCLUSIVE at
// both ends, and the handler passes `range(offset, offset + limit)` —
// i.e. it deliberately requests one extra row so it can compute
// `hasMore` from `list.length > limit`. Our stub mirrors that.
// ---------------------------------------------------------------------

function makeAdmin(dataset: ReturnType<typeof makeFixtureRows>) {
  function makeAuditChain() {
    let sortCol = "created_at";
    let sortAsc = false;
    let secondarySort: { col: string; asc: boolean } | null = null;
    let orderCallCount = 0;

    const chain: any = {
      select: () => chain,
      order: (col: string, opts: { ascending: boolean }) => {
        orderCallCount++;
        if (orderCallCount === 1) {
          sortCol = col;
          sortAsc = opts.ascending;
        } else {
          secondarySort = { col, asc: opts.ascending };
        }
        return chain;
      },
      eq: () => chain,
      in: () => chain,
      gte: () => chain,
      lte: () => chain,
      range: async (from: number, to: number) => {
        const sorted = [...dataset].sort((a: any, b: any) => {
          const av = a[sortCol];
          const bv = b[sortCol];
          const primary = av < bv ? -1 : av > bv ? 1 : 0;
          if (primary !== 0) return sortAsc ? primary : -primary;
          if (secondarySort) {
            const av2 = (a as any)[secondarySort.col];
            const bv2 = (b as any)[secondarySort.col];
            const s = av2 < bv2 ? -1 : av2 > bv2 ? 1 : 0;
            return secondarySort.asc ? s : -s;
          }
          return 0;
        });
        // PostgREST range is inclusive on both ends.
        const slice = sorted.slice(from, to + 1);
        return { data: slice, error: null, count: dataset.length };
      },
    };
    return chain;
  }

  return {
    from: (table: string) => {
      if (table === "audit_log") return makeAuditChain();
      const empty: any = {
        select: () => empty,
        ilike: () => empty,
        eq: () => empty,
        in: () => empty,
        limit: async () => ({ data: [], error: null }),
      };
      return empty;
    },
  } as any;
}

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

const SORTS: Array<{ sortBy: "created_at" | "action" | "entity"; sortDir: "asc" | "desc" }> = [
  { sortBy: "created_at", sortDir: "desc" },
  { sortBy: "created_at", sortDir: "asc" },
  { sortBy: "action", sortDir: "asc" },
  { sortBy: "action", sortDir: "desc" },
  { sortBy: "entity", sortDir: "asc" },
  { sortBy: "entity", sortDir: "desc" },
];

describe("getAuditLog pagination fields — correct across every sort option", () => {
  const dataset = makeFixtureRows();

  for (const { sortBy, sortDir } of SORTS) {
    const label = `${sortBy} ${sortDir}`;

    it(`[${label}] limit=5 boundaries: first / interior / last-full / final-partial`, async () => {
      const admin = makeAdmin(dataset);
      const limit = 5;

      // 23 rows / 5 per page → pages of 5,5,5,5,3
      const boundaries: Array<{
        offset: number;
        expectedRows: number;
        expectedHasMore: boolean;
      }> = [
        { offset: 0, expectedRows: 5, expectedHasMore: true }, // first
        { offset: 5, expectedRows: 5, expectedHasMore: true }, // interior
        { offset: 10, expectedRows: 5, expectedHasMore: true }, // interior
        { offset: 15, expectedRows: 5, expectedHasMore: true }, // last full
        { offset: 20, expectedRows: 3, expectedHasMore: false }, // partial final
      ];

      let seenIds: string[] = [];
      for (const b of boundaries) {
        const page = await runGetAuditLog(
          { limit, offset: b.offset, sortBy, sortDir },
          admin,
        );

        // Numeric contract.
        expect(page.limit, `[${label} @${b.offset}] limit echoed`).toBe(limit);
        expect(page.offset, `[${label} @${b.offset}] offset echoed`).toBe(b.offset);
        expect(page.sortBy).toBe(sortBy);
        expect(page.sortDir).toBe(sortDir);
        expect(page.total, `[${label} @${b.offset}] total`).toBe(TOTAL_ROWS);
        expect(page.rows.length, `[${label} @${b.offset}] row count`).toBe(
          b.expectedRows,
        );
        expect(page.hasMore, `[${label} @${b.offset}] hasMore`).toBe(
          b.expectedHasMore,
        );
        // nextOffset MUST be a simple `offset + limit` cursor so
        // repeated ?offset=nextOffset walks the full dataset without
        // gaps or overlaps.
        expect(page.nextOffset, `[${label} @${b.offset}] nextOffset`).toBe(
          b.offset + limit,
        );

        // No id shows up twice across page boundaries.
        for (const r of page.rows) {
          expect(
            seenIds.includes(r.id),
            `[${label} @${b.offset}] id ${r.id} appeared on a previous page`,
          ).toBe(false);
          seenIds.push(r.id);
        }

        assertClean(`${label} @${b.offset}`, page);
      }

      // The 5 pages together must cover every row exactly once.
      expect(seenIds.length).toBe(TOTAL_ROWS);
      expect(new Set(seenIds).size).toBe(TOTAL_ROWS);
    });

    it(`[${label}] limit=7 non-divisor boundaries: 7+7+7+2 partial final`, async () => {
      const admin = makeAdmin(dataset);
      const limit = 7;
      const boundaries: Array<{
        offset: number;
        expectedRows: number;
        expectedHasMore: boolean;
      }> = [
        { offset: 0, expectedRows: 7, expectedHasMore: true },
        { offset: 7, expectedRows: 7, expectedHasMore: true },
        { offset: 14, expectedRows: 7, expectedHasMore: true },
        { offset: 21, expectedRows: 2, expectedHasMore: false }, // partial final
      ];

      let seen = 0;
      for (const b of boundaries) {
        const page = await runGetAuditLog(
          { limit, offset: b.offset, sortBy, sortDir },
          admin,
        );
        expect(page.limit).toBe(limit);
        expect(page.offset).toBe(b.offset);
        expect(page.total).toBe(TOTAL_ROWS);
        expect(page.rows.length).toBe(b.expectedRows);
        expect(page.hasMore).toBe(b.expectedHasMore);
        expect(page.nextOffset).toBe(b.offset + limit);
        seen += page.rows.length;
        assertClean(`${label} l=7 @${b.offset}`, page);
      }
      expect(seen).toBe(TOTAL_ROWS);
    });

    it(`[${label}] boundary offsets: offset===total and offset>total return zero rows, total unchanged`, async () => {
      const admin = makeAdmin(dataset);

      const atTotal = await runGetAuditLog(
        { limit: 10, offset: TOTAL_ROWS, sortBy, sortDir },
        admin,
      );
      expect(atTotal.rows).toEqual([]);
      expect(atTotal.hasMore).toBe(false);
      expect(atTotal.total).toBe(TOTAL_ROWS);
      expect(atTotal.limit).toBe(10);
      expect(atTotal.offset).toBe(TOTAL_ROWS);
      expect(atTotal.nextOffset).toBe(TOTAL_ROWS + 10);
      assertClean(`${label} offset===total`, atTotal);

      const pastEnd = await runGetAuditLog(
        { limit: 10, offset: TOTAL_ROWS + 500, sortBy, sortDir },
        admin,
      );
      expect(pastEnd.rows).toEqual([]);
      expect(pastEnd.hasMore).toBe(false);
      expect(pastEnd.total).toBe(TOTAL_ROWS);
      expect(pastEnd.limit).toBe(10);
      expect(pastEnd.offset).toBe(TOTAL_ROWS + 500);
      expect(pastEnd.nextOffset).toBe(TOTAL_ROWS + 510);
      assertClean(`${label} past-end`, pastEnd);
    });

    it(`[${label}] limit larger than dataset returns all rows in one page, hasMore=false`, async () => {
      const admin = makeAdmin(dataset);
      const page = await runGetAuditLog(
        { limit: 200, offset: 0, sortBy, sortDir },
        admin,
      );
      expect(page.limit).toBe(200);
      expect(page.offset).toBe(0);
      expect(page.total).toBe(TOTAL_ROWS);
      expect(page.rows.length).toBe(TOTAL_ROWS);
      expect(page.hasMore).toBe(false);
      expect(page.nextOffset).toBe(200);
      assertClean(`${label} limit=200`, page);
    });

    it(`[${label}] limit=1 walks every row exactly once with hasMore flipping on the final row`, async () => {
      const admin = makeAdmin(dataset);
      const seen: string[] = [];
      for (let offset = 0; offset < TOTAL_ROWS; offset++) {
        const page = await runGetAuditLog(
          { limit: 1, offset, sortBy, sortDir },
          admin,
        );
        expect(page.limit).toBe(1);
        expect(page.offset).toBe(offset);
        expect(page.total).toBe(TOTAL_ROWS);
        expect(page.rows.length).toBe(1);
        expect(page.nextOffset).toBe(offset + 1);
        const isLast = offset === TOTAL_ROWS - 1;
        expect(page.hasMore, `[${label} @${offset}] hasMore`).toBe(!isLast);
        seen.push(page.rows[0]!.id);
        assertClean(`${label} limit=1 @${offset}`, page);
      }
      expect(new Set(seen).size).toBe(TOTAL_ROWS);
    });
  }
});
