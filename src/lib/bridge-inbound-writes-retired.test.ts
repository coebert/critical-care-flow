/**
 * Inbound mirror WRITES are retired. CCC owns referrals, investigations and
 * microbiology (the Hub PULLS them read-only via ?sync=1); the Hub owns
 * patients and placement, so CCC's local copies are never written by the
 * bridge either. A correctly signed POST must get a truthful refusal and
 * cause ZERO database calls — no read-then-upsert race, no audit row, no
 * row echoed back. Real HMAC verification with a synthetic secret; the
 * database is a recording fake. No network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { signWith } from "@/lib/bridge-hmac.server";

const calls: string[] = [];
// Synthetic row: the caller's expected revision, then a concurrent native
// CCC edit lands 1 µs later before any upsert would run.
const row = { id: "00000000-0000-4000-8000-000000000001", updated_at: "2026-11-16T10:00:00.123456Z" };
vi.mock("@/integrations/supabase/client.server", () => {
  const builder = (table: string) => {
    const b: any = {};
    for (const m of ["select", "eq", "is", "order", "limit", "gt"]) b[m] = () => (calls.push(`${table}.${m}`), b);
    b.maybeSingle = () => {
      calls.push(`${table}.maybeSingle`);
      const snapshot = { ...row };
      row.updated_at = "2026-11-16T10:00:00.123457Z"; // concurrent edit
      return Promise.resolve({ data: snapshot, error: null });
    };
    for (const m of ["insert", "upsert", "update", "delete"]) b[m] = () => (calls.push(`${table}.${m}`), b);
    b.single = () => (calls.push(`${table}.single`), Promise.resolve({ data: { id: row.id }, error: null }));
    b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(ok);
    return b;
  };
  return { supabaseAdmin: { from: builder, rpc: () => (calls.push("rpc"), Promise.resolve({ data: null, error: null })) } };
});

import { Route as Referrals } from "@/routes/api/public/bridge/referrals";
import { Route as Investigations } from "@/routes/api/public/bridge/investigations";
import { Route as Microbiology } from "@/routes/api/public/bridge/microbiology";
import { Route as Patients } from "@/routes/api/public/bridge/patients";
import { Route as Beds } from "@/routes/api/public/bridge/beds";
import { Route as Occupancies } from "@/routes/api/public/bridge/bed_occupancies";
import { Route as Outliers } from "@/routes/api/public/bridge/bed_outliers";
import { Route as TransfersOut } from "@/routes/api/public/bridge/bed_transfers_out";

const SECRET = "synthetic-bridge-secret";
type H = { options: { server: { handlers: Record<string, (a: { request: Request }) => Promise<Response>> } } };

function signedPost(path: string, body: unknown, opts: { role?: string; tamper?: boolean } = {}) {
  const rawBody = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const actor = JSON.stringify({ id: "synthetic-sync", role: opts.role ?? "admin" });
  let signature = signWith(SECRET, { timestamp, actor, rawBody });
  if (opts.tamper) signature = signature.slice(0, -4) + "0000";
  return new Request(`https://ccc.synthetic.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-timestamp": timestamp, "x-actor": actor, "x-signature": signature },
    body: rawBody,
  });
}
const post = async (route: unknown, req: Request) => {
  const res = await (route as H).options.server.handlers.POST({ request: req });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const referralBody = {
  record: { id: row.id, referral_received_at: "2026-11-16T09:00:00Z", status: "pending", age: 70 },
  expected_updated_at: "2026-11-16T10:00:00.123456Z",
};

const ROUTES: [string, unknown][] = [
  ["referrals", Referrals],
  ["investigations", Investigations],
  ["microbiology", Microbiology],
  ["patients", Patients],
  ["beds", Beds],
  ["bed_occupancies", Occupancies],
  ["bed_outliers", Outliers],
  ["bed_transfers_out", TransfersOut],
];

beforeEach(() => {
  calls.length = 0;
  row.updated_at = "2026-11-16T10:00:00.123456Z";
  vi.stubEnv("HANDOVER_API_SECRET", SECRET);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("retired inbound mirror writes", () => {
  it("referral POST whose revision goes stale mid-request is refused, not upserted", async () => {
    const r = await post(Referrals, signedPost("/api/public/bridge/referrals", referralBody));
    expect(r.status).toBe(410);
    expect(r.body).toMatchObject({ error: "inbound_mirror_write_retired", resource: "referrals", mutations: 0 });
    expect(calls).toEqual([]);
    expect(row.updated_at).toBe("2026-11-16T10:00:00.123456Z");
  });

  it("referral POST without expected_updated_at is refused too", async () => {
    const r = await post(Referrals, signedPost("/api/public/bridge/referrals", referralBody.record));
    expect(r.status).toBe(410);
    expect(calls).toEqual([]);
  });

  it.each(ROUTES)("%s POST: signed admin caller gets 410 and no database call", async (name, route) => {
    const r = await post(route, signedPost(`/api/public/bridge/${name}`, { record: { id: row.id }, expected_updated_at: row.updated_at }));
    expect(r.status).toBe(410);
    expect(r.body).toMatchObject({ error: "inbound_mirror_write_retired", resource: name, mutations: 0 });
    expect(r.body).not.toHaveProperty("current");
    expect(r.body).not.toHaveProperty("record");
    expect(calls).toEqual([]);
  });

  it.each(ROUTES)("%s POST: tampered signature still gets 401 (refusal stays authenticated)", async (name, route) => {
    const r = await post(route, signedPost(`/api/public/bridge/${name}`, { record: {} }, { tamper: true }));
    expect(r.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("unsigned POST gets 400 missing_signed_headers", async () => {
    const r = await post(Referrals, new Request("https://ccc.synthetic.test/api/public/bridge/referrals", { method: "POST", body: "{}" }));
    expect(r).toMatchObject({ status: 400, body: { error: "missing_signed_headers" } });
    expect(calls).toEqual([]);
  });

  it("an unknown actor role is refused before the retirement notice", async () => {
    const r = await post(Referrals, signedPost("/api/public/bridge/referrals", referralBody, { role: "viewer" }));
    expect(r).toMatchObject({ status: 400, body: { error: "invalid_actor" } });
  });
});
