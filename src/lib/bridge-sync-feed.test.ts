/**
 * Versioned `?sync=1` bridge feed: paging, snapshot fence, cursors,
 * tombstones, microbiology mapping and failures. Synthetic rows only.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakePostgrest } from "@/test-utils/fake-postgrest";
import {
  RESOURCE_CONFIG,
  encodeCursor,
  referralResourceConfig,
  serveSyncPage,
  type SyncResource,
} from "./bridge-sync-feed.server";

const SECRET = "synthetic-sync-secret";
const NOW = new Date("2026-11-16T12:00:00.000Z");
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ts = (sec: number, micros = 0) =>
  `${new Date(Date.parse("2026-11-16T10:00:00Z") + sec * 1000).toISOString().slice(0, 19)}.${String(micros).padStart(6, "0")}+00:00`;

function patientRows(n: number, sameTimestampEvery = 1) {
  return Array.from({ length: n }, (_, i) => ({
    id: uuid(i + 1),
    full_name: `S${i}`,
    status: "admitted",
    created_at: ts(0),
    updated_at: ts(Math.floor(i / sameTimestampEvery)),
    created_by: "should-not-leak",
  }));
}

async function page(resource: SyncResource, cfg: Parameters<typeof serveSyncPage>[1], db: unknown, qs: string) {
  return serveSyncPage(resource, cfg, new URL(`https://ccc.synthetic.test/api/public/bridge/${resource}?sync=1${qs}`), {
    db: db as never,
    secret: SECRET,
    now: () => NOW,
    log: () => undefined,
  });
}

async function drain(resource: SyncResource, cfg: Parameters<typeof serveSyncPage>[1], db: unknown, qs = "", onPage?: (i: number) => void) {
  const all: Record<string, unknown>[] = [];
  const sizes: number[] = [];
  let cursor: string | null = null;
  let snapshot: unknown = null;
  for (let i = 0; i < 100; i++) {
    onPage?.(i);
    const r = await page(resource, cfg, db, `${qs}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    expect(r.status).toBe(200);
    const body = r.body as { records: Record<string, unknown>[]; snapshot_at: string; schema_version: number; pagination: { next_cursor: string | null; complete: boolean } };
    expect(body.schema_version).toBe(1);
    if (snapshot === null) snapshot = body.snapshot_at;
    expect(body.snapshot_at).toBe(snapshot);
    expect(body.pagination.complete).toBe(body.pagination.next_cursor === null);
    all.push(...body.records);
    sizes.push(body.records.length);
    if (body.pagination.complete) return { all, sizes, snapshot };
    cursor = body.pagination.next_cursor;
  }
  throw new Error("did not complete");
}

describe("sync=1 envelope and paging", () => {
  it(">500 rows page in stable (updated_at,id) order with no loss or duplicates", async () => {
    const f = fakePostgrest({ patients: patientRows(1203) });
    const { all, sizes } = await drain("patients", RESOURCE_CONFIG.patients, f.db, "&limit=500");
    expect(sizes).toEqual([500, 500, 203]);
    expect(new Set(all.map((r) => r.id)).size).toBe(1203);
    expect(all[0]).not.toHaveProperty("created_by");
    // limit+1 is requested so a full final page is not mistaken for "more".
    expect(f.queries[0].ops).toContainEqual(["limit", 501]);
  });

  it("an exactly-full page is complete with next_cursor null", async () => {
    const f = fakePostgrest({ patients: patientRows(10) });
    const r = await page("patients", RESOURCE_CONFIG.patients, f.db, "&limit=10");
    expect((r.body as any).pagination).toEqual({ next_cursor: null, complete: true });
  });

  it("many rows sharing one updated_at across page boundaries are neither lost nor repeated", async () => {
    const f = fakePostgrest({ patients: patientRows(37, 37) });
    const { all, sizes } = await drain("patients", RESOURCE_CONFIG.patients, f.db, "&limit=5");
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(37);
    expect(new Set(all.map((r) => r.id)).size).toBe(37);
  });

  it("rows updated after the snapshot fence never appear in that snapshot", async () => {
    const rows = patientRows(6);
    const f = fakePostgrest({ patients: rows });
    const late = { ...rows[0], id: uuid(999), updated_at: "2026-11-16T12:00:00.000001+00:00" };
    const { all } = await drain("patients", RESOURCE_CONFIG.patients, f.db, "&limit=2", (i) => {
      if (i === 1) f.tables.patients.push(late);
    });
    expect(all.map((r) => r.id)).not.toContain(uuid(999));
    expect(all).toHaveLength(6);
  });

  it("the cursor keeps the first request's filters and snapshot", async () => {
    const rows = patientRows(9).map((r, i) => ({ ...r, status: i % 3 === 0 ? "discharged" : "admitted" }));
    const f = fakePostgrest({ patients: rows });
    const first = await page("patients", RESOURCE_CONFIG.patients, f.db, "&limit=2&status=admitted");
    const cursor = (first.body as any).pagination.next_cursor as string;
    const next = await page("patients", RESOURCE_CONFIG.patients, f.db, `&limit=2&cursor=${encodeURIComponent(cursor)}`);
    expect((next.body as any).records.every((r: any) => r.status === "admitted")).toBe(true);
    const changed = await page("patients", RESOURCE_CONFIG.patients, f.db, `&status=discharged&cursor=${encodeURIComponent(cursor)}`);
    expect(changed).toMatchObject({ status: 400, body: { error: "cursor_filter_mismatch" } });
  });
});

describe("validation", () => {
  const f = fakePostgrest({ patients: patientRows(3) });
  it.each([
    ["&limit=0", "invalid_limit"],
    ["&limit=-1", "invalid_limit"],
    ["&limit=abc", "invalid_limit"],
    ["&limit=501", "invalid_limit"],
    ["&since=yesterday", "invalid_since"],
    ["&status=admitted),or(id.gt.0", "invalid_status"],
    ["&cursor=not-a-cursor", "invalid_cursor"],
    ["&cursor=abc.def", "invalid_cursor"],
  ])("%s → 400 %s", async (qs, error) => {
    const r = await page("patients", RESOURCE_CONFIG.patients, f.db, qs);
    expect(r).toMatchObject({ status: 400, body: { error } });
  });

  it("rejects a tampered cursor, a cursor for another resource and a forged injection value", async () => {
    const good = encodeCursor({ v: 1, r: "patients", s: NOW.toISOString(), u: ts(1), i: uuid(1), f: {} }, SECRET);
    const [p, s] = good.split(".");
    const tampered = `${Buffer.from(JSON.stringify({ v: 1, r: "patients", s: NOW.toISOString(), u: ts(1), i: uuid(2), f: {} })).toString("base64url")}.${s}`;
    expect((await page("patients", RESOURCE_CONFIG.patients, f.db, `&cursor=${tampered}`)).status).toBe(400);
    expect((await page("investigations", RESOURCE_CONFIG.investigations, f.db, `&cursor=${good}`)).status).toBe(400);
    const forged = encodeCursor({ v: 1, r: "patients", s: NOW.toISOString(), u: 'x",id.gt.0', i: uuid(1), f: {} } as never, SECRET);
    expect((await page("patients", RESOURCE_CONFIG.patients, f.db, `&cursor=${forged}`)).status).toBe(400);
    expect(p.length).toBeGreaterThan(0);
  });

  it("investigations reject a non-UUID patient_id", async () => {
    const r = await page("investigations", RESOURCE_CONFIG.investigations, f.db, "&patient_id=1;drop");
    expect(r).toMatchObject({ status: 400, body: { error: "invalid_patient_id" } });
  });

  it("database errors return a generic 500 and never log row contents", async () => {
    const g = fakePostgrest({ patients: patientRows(1) });
    g.state.fail = true;
    const log = vi.fn();
    const r = await serveSyncPage("patients", RESOURCE_CONFIG.patients, new URL("https://x.test/?sync=1"), {
      db: g.db as never,
      secret: SECRET,
      log,
    });
    expect(r).toMatchObject({ status: 500, body: { error: "query_failed" } });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret row contents/);
    expect(JSON.stringify(r.body)).not.toMatch(/secret row contents/);
  });
});

describe("referrals", () => {
  const cfg = referralResourceConfig(["id", "age", "status", "current_ward"]);
  beforeEach(() => undefined);
  it("include created_at/updated_at and soft-deleted tombstones with no identifiers or ciphertext", async () => {
    const f = fakePostgrest({
      referrals: [
        { id: uuid(1), age: 70, status: "pending", current_ward: "W1", created_at: ts(0), updated_at: ts(1), deleted_at: null, hospital_number_enc: "ct", patient_initials: "AB" },
        { id: uuid(2), age: 50, status: "accepted", current_ward: "W2", created_at: ts(0), updated_at: ts(2), deleted_at: ts(2), hospital_number_enc: "ct2", patient_initials: "CD" },
      ],
    });
    const r = await page("referrals", cfg, f.db, "");
    const recs = (r.body as any).records;
    expect(recs[0]).toEqual({ id: uuid(1), age: 70, status: "pending", current_ward: "W1", created_at: ts(0), updated_at: ts(1), deleted_at: null });
    expect(recs[1]).toEqual({ id: uuid(2), updated_at: ts(2), deleted_at: ts(2) });
    expect(JSON.stringify(recs)).not.toMatch(/ct2|CD|_enc/);
  });

  it("serializes live records with an explicit deleted_at:null and minimal tombstones, exactly, across signed pages", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      id: uuid(i + 1),
      age: 40 + i,
      status: "pending",
      current_ward: `W${i}`,
      created_at: ts(0),
      updated_at: ts(1), // identical timestamps: id breaks ties
      deleted_at: i % 2 === 1 ? ts(1) : null,
      hospital_number_enc: `ct${i}`,
      patient_initials: "ZZ",
    }));
    const f = fakePostgrest({ referrals: rows });
    const p1 = await page("referrals", cfg, f.db, "&limit=2");
    const b1 = p1.body as any;
    expect(Object.keys(b1).sort()).toEqual(["pagination", "records", "schema_version", "snapshot_at"]);
    expect(b1.schema_version).toBe(1);
    expect(b1.snapshot_at).toBe(NOW.toISOString());
    expect(b1.pagination.complete).toBe(false);
    expect(typeof b1.pagination.next_cursor).toBe("string");
    expect(JSON.stringify(b1.records)).toBe(
      JSON.stringify([
        { id: uuid(1), age: 40, status: "pending", current_ward: "W0", created_at: ts(0), updated_at: ts(1), deleted_at: null },
        { id: uuid(2), updated_at: ts(1), deleted_at: ts(1) },
      ]),
    );
    // Tampered cursor is refused; the genuine one continues the same snapshot.
    const bad = await page("referrals", cfg, f.db, `&limit=2&cursor=${encodeURIComponent(b1.pagination.next_cursor + "x")}`);
    expect(bad).toMatchObject({ status: 400, body: { error: "invalid_cursor" } });
    const { all, sizes, snapshot } = await drain("referrals", cfg, f.db, "&limit=2");
    expect(snapshot).toBe(NOW.toISOString());
    expect(sizes).toEqual([2, 2, 1]);
    expect(all.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    for (const r of all) {
      if (r.deleted_at === null) expect(Object.keys(r).sort()).toEqual(["age", "created_at", "current_ward", "deleted_at", "id", "status", "updated_at"]);
      else expect(Object.keys(r).sort()).toEqual(["deleted_at", "id", "updated_at"]);
    }
  });
});

describe("microbiology canonical v1 mapping", () => {
  const row = {
    id: uuid(1),
    patient_id: uuid(50),
    organism: "Synthetic organism",
    sample_type: "Blood culture",
    sensitivities: { amoxicillin: "R" },
    sampled_at: ts(0),
    reported_at: ts(5),
    notes: "Synthetic note",
    created_at: ts(0),
    updated_at: ts(5),
  };
  it("maps only exact original fields into a labelled narrative", async () => {
    const f = fakePostgrest({ microbiology: [row] });
    const r = await page("microbiology", RESOURCE_CONFIG.microbiology, f.db, "");
    const rec = (r.body as any).records[0];
    expect(rec).toMatchObject({
      id: row.id,
      patient_id: row.patient_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
      specimen_type: "Blood culture",
      result_at: row.reported_at,
      mapping: "ccc.microbiology.v1",
      imported_from: "critical_care_connect",
    });
    expect(rec.findings).toContain("Imported from Critical Care Connect");
    expect(rec.findings).toContain("Organism: Synthetic organism");
    expect(rec.findings).toContain('{"amoxicillin":"R"}');
    expect(rec.findings).toContain("Notes: Synthetic note");
    expect(rec.findings).toContain(`Sampled at: ${row.sampled_at}`);
  });
  it("a missing required original field makes the feed an explicit error, not a silent omission", async () => {
    const f = fakePostgrest({ microbiology: [row, { ...row, id: uuid(2), sample_type: null }] });
    const r = await page("microbiology", RESOURCE_CONFIG.microbiology, f.db, "");
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ error: "incomplete_source_records", invalid: [{ id: uuid(2), missing: ["sample_type"] }] });
    expect(JSON.stringify(r.body)).not.toMatch(/Synthetic organism/);
  });
  it("sampled_at is never invented when absent", async () => {
    const f = fakePostgrest({ microbiology: [{ ...row, sampled_at: null, notes: null }] });
    const rec = ((await page("microbiology", RESOURCE_CONFIG.microbiology, f.db, "")).body as any).records[0];
    expect(rec.findings).not.toMatch(/Sampled at|Notes:/);
  });
});
