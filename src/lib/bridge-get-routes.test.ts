/**
 * The four bridge GET routes: default behaviour stays backward compatible,
 * `?sync=1` returns the versioned envelope. Signature verification and the
 * database are replaced with synthetic fakes.
 */
import { describe, it, expect, vi } from "vitest";
import { fakePostgrest } from "@/test-utils/fake-postgrest";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T = (s: number) => `2026-11-16T10:00:0${s}.000000+00:00`;
const fake = fakePostgrest({
  referrals: [
    { id: uuid(1), age: 60, status: "pending", created_at: T(0), updated_at: T(1), deleted_at: null, hospital_number_enc: "ct" },
    { id: uuid(2), age: 61, status: "pending", created_at: T(0), updated_at: T(2), deleted_at: T(2), hospital_number_enc: "ct" },
  ],
  patients: [{ id: uuid(3), full_name: "SP", status: "admitted", created_at: T(0), updated_at: T(1) }],
  investigations: [{ id: uuid(4), patient_id: uuid(3), category: "bloods", findings: "x", result_at: T(1), created_at: T(0), updated_at: T(1) }],
  microbiology: [
    { id: uuid(5), patient_id: uuid(3), organism: "o", sample_type: "s", sensitivities: {}, reported_at: T(1), created_at: T(0), updated_at: T(1) },
  ],
});
vi.mock("@/lib/bridge-verify.server", () => ({
  verifyBridgeRequest: async () => ({ actor: { id: "sync", role: "system" }, rawBody: "", secretUsed: "current" }),
  parseBridgeBody: () => ({ error: "unused" }),
  pickAllowed: () => ({ error: "unused", unexpected: [] }),
}));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: fake.db }));
vi.mock("@/lib/bridge-hmac.server", () => ({ getBridgeSecrets: () => ({ current: "synthetic", previous: null }) }));

import { Route as ReferralsRoute } from "@/routes/api/public/bridge/referrals";
import { Route as PatientsRoute } from "@/routes/api/public/bridge/patients";
import { Route as InvestigationsRoute } from "@/routes/api/public/bridge/investigations";
import { Route as MicroRoute } from "@/routes/api/public/bridge/microbiology";

type R = { options: { server: { handlers: { GET: (a: { request: Request }) => Promise<Response> } } } };
const get = async (route: unknown, path: string) => {
  const res = await (route as R).options.server.handlers.GET({ request: new Request(`https://ccc.synthetic.test${path}`) });
  return { status: res.status, body: await res.json() };
};

describe("bridge GET routes", () => {
  it("default referrals GET keeps the {records} shape, excludes deleted rows, and now includes created_at/updated_at", async () => {
    const r = await get(ReferralsRoute, "/api/public/bridge/referrals");
    expect(Object.keys(r.body)).toEqual(["records"]);
    expect(r.body.records.map((x: any) => x.id)).toEqual([uuid(1)]);
    expect(r.body.records[0]).toHaveProperty("created_at", T(0));
    expect(r.body.records[0]).toHaveProperty("updated_at", T(1));
    expect(r.body.records[0]).not.toHaveProperty("hospital_number_enc");
  });

  it.each([
    ["referrals", ReferralsRoute, 2],
    ["patients", PatientsRoute, 1],
    ["investigations", InvestigationsRoute, 1],
    ["microbiology", MicroRoute, 1],
  ])("%s ?sync=1 returns the versioned envelope", async (name, route, n) => {
    const r = await get(route, `/api/public/bridge/${name}?sync=1`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ schema_version: 1, pagination: { next_cursor: null, complete: true } });
    expect(typeof r.body.snapshot_at).toBe("string");
    expect(r.body.records).toHaveLength(n);
  });
});
