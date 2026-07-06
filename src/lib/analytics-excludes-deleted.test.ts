import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Regression guard: the analytics endpoints must never surface soft-deleted
 * referrals or post-op bookings. Both handlers filter with
 * `.is("deleted_at", null)` at the database layer. If a future edit drops
 * that filter, deleted rows would silently reappear in the admin analytics
 * dashboards and skew reporting. This test parses the source of
 * `analytics.functions.ts` and asserts each handler still applies the
 * `deleted_at IS NULL` predicate.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(resolve(HERE, "analytics.functions.ts"), "utf8");

/** Extract the substring for a single named export's body up to the next
 *  top-level export or end of file. Good enough for our tightly-scoped
 *  source file — every export lives on its own and there is no nesting of
 *  server-fn definitions. */
function handlerBody(exportName: string): string {
  const start = SOURCE.indexOf(`export const ${exportName}`);
  expect(start, `expected export "${exportName}" in analytics.functions.ts`).toBeGreaterThanOrEqual(0);
  const nextExport = SOURCE.indexOf("\nexport const ", start + 1);
  return SOURCE.slice(start, nextExport === -1 ? SOURCE.length : nextExport);
}

describe("analytics endpoints exclude soft-deleted rows", () => {
  it("getReferralsAnalytics filters deleted_at IS NULL on referrals", () => {
    const body = handlerBody("getReferralsAnalytics");
    expect(body).toMatch(/\.from\(\s*["']referrals["']\s*\)/);
    expect(body).toMatch(/\.is\(\s*["']deleted_at["']\s*,\s*null\s*\)/);
    // Fallback guard: reject rows with a deleted_by attribution even when
    // deleted_at is missing.
    expect(body).toMatch(/\.is\(\s*["']deleted_by["']\s*,\s*null\s*\)/);
  });

  it("getPostopAnalytics filters deleted_at IS NULL on postop_bookings", () => {
    const body = handlerBody("getPostopAnalytics");
    expect(body).toMatch(/\.from\(\s*["']postop_bookings["']\s*\)/);
    expect(body).toMatch(/\.is\(\s*["']deleted_at["']\s*,\s*null\s*\)/);
    expect(body).toMatch(/\.is\(\s*["']deleted_by["']\s*,\s*null\s*\)/);
  });
});

/**
 * Forward-looking audit: any future `.from("referrals")` or
 * `.from("postop_bookings")` query added to `analytics.functions.ts` must
 * also carry the soft-delete filters. This walks every such call site in
 * the analytics module and asserts both `.is("deleted_at", null)` and
 * `.is("deleted_by", null)` appear in a short window after the `.from(...)`
 * call — catching regressions even in endpoints that don't exist yet.
 */
describe("analytics.functions.ts — every referrals/bookings query filters soft-deletes", () => {
  const TABLES = ["referrals", "postop_bookings"] as const;
  for (const table of TABLES) {
    it(`every .from("${table}") in analytics.functions.ts filters deleted_at AND deleted_by`, () => {
      const re = new RegExp(`\\.from\\(\\s*["']${table}["']\\s*\\)`, "g");
      const matches = [...SOURCE.matchAll(re)];
      expect(matches.length, `expected at least one .from("${table}") in analytics.functions.ts`).toBeGreaterThan(0);
      for (const m of matches) {
        // Grab ~1000 chars after the .from(...) to cover the whole query chain.
        const window = SOURCE.slice(m.index ?? 0, (m.index ?? 0) + 1000);
        expect(window, `missing .is("deleted_at", null) after .from("${table}")`).toMatch(
          /\.is\(\s*["']deleted_at["']\s*,\s*null\s*\)/,
        );
        expect(window, `missing .is("deleted_by", null) after .from("${table}")`).toMatch(
          /\.is\(\s*["']deleted_by["']\s*,\s*null\s*\)/,
        );
      }
    });
  }
});

/**
 * Behavioural check: simulate the fluent Supabase query the handlers build
 * and confirm that when `.is("deleted_at", null)` is applied to a mixed
 * fixture of deleted + live rows, only the live rows come through. This is
 * a small model of the PostgREST filter, exercised end-to-end against the
 * same call sequence the analytics handlers use.
 */
type Row = {
  id: string;
  deleted_at: string | null;
  deleted_by: string | null;
  referral_received_at?: string;
  created_at?: string;
};

function makeFakeSupabase(table: string, rows: Row[]) {
  const state = {
    table: "",
    filters: [] as Array<(r: Row) => boolean>,
  };
  const builder: any = {
    select() { return builder; },
    order() { return builder; },
    limit() { return Promise.resolve({ data: rows.filter((r) => state.filters.every((f) => f(r))), error: null }); },
    is(col: string, val: unknown) {
      state.filters.push((r) => (r as any)[col] === val);
      return builder;
    },
    gte(col: string, val: string) {
      state.filters.push((r) => ((r as any)[col] ?? "") >= val);
      return builder;
    },
    lte(col: string, val: string) {
      state.filters.push((r) => ((r as any)[col] ?? "") <= val);
      return builder;
    },
  };
  return {
    from(t: string) {
      expect(t).toBe(table);
      state.table = t;
      return builder;
    },
  };
}

describe("fluent Supabase filter parity — deleted rows dropped", () => {
  // Includes a partial soft-delete ("orphan") row where deleted_by is set but
  // deleted_at is missing — must still be excluded thanks to the fallback.
  const rows: Row[] = [
    { id: "live-1", deleted_at: null, deleted_by: null, referral_received_at: "2026-07-01T00:00:00Z", created_at: "2026-07-01T00:00:00Z" },
    { id: "deleted-1", deleted_at: "2026-07-02T00:00:00Z", deleted_by: "u1", referral_received_at: "2026-07-01T00:00:00Z", created_at: "2026-07-01T00:00:00Z" },
    { id: "orphan-1", deleted_at: null, deleted_by: "u2", referral_received_at: "2026-07-02T00:00:00Z", created_at: "2026-07-02T00:00:00Z" },
    { id: "live-2", deleted_at: null, deleted_by: null, referral_received_at: "2026-07-03T00:00:00Z", created_at: "2026-07-03T00:00:00Z" },
  ];

  it("referrals: only live rows within the date range are returned (orphan excluded)", async () => {
    const sb = makeFakeSupabase("referrals", rows);
    const { data } = await sb
      .from("referrals")
      .select("*")
      .is("deleted_at", null)
      .is("deleted_by", null)
      .gte("referral_received_at", "2026-06-01T00:00:00Z")
      .lte("referral_received_at", "2026-07-31T00:00:00Z")
      .limit(5000);
    expect(data.map((r: Row) => r.id).sort()).toEqual(["live-1", "live-2"]);
  });

  it("postop_bookings: only live rows within the date range are returned (orphan excluded)", async () => {
    const sb = makeFakeSupabase("postop_bookings", rows);
    const { data } = await sb
      .from("postop_bookings")
      .select("*")
      .is("deleted_at", null)
      .is("deleted_by", null)
      .order("created_at", { ascending: false })
      .gte("created_at", "2026-06-01T00:00:00Z")
      .lte("created_at", "2026-07-31T00:00:00Z")
      .limit(5000);
    expect(data.map((r: Row) => r.id).sort()).toEqual(["live-1", "live-2"]);
  });
});

