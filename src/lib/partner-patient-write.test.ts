/**
 * Hub patient write handler core (updatePartnerPatient): scope, sanitised
 * replies, private errors, partial update and stale CAS. Synthetic Hub only.
 */
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { fakeHub } from "@/test-utils/fake-hub";
import { writePartnerPatient, type WriteCaller } from "./partner-patient-write.server";
import type { UpdatePartnerPatientInput } from "./partner-bed-board.functions";

const PT = "77777777-7777-4777-8777-777777777777";
const OTHER = "66666666-6666-4666-8666-666666666666";
const USER = "88888888-8888-4888-8888-888888888888";
const hubRow = {
  id: PT,
  full_name: "Synthetic Person",
  hospital_number: "SYN0001",
  age: 70,
  status: "admitted",
  bed: "1",
  admission_date: null,
  tep_in_place: false,
  dnacpr_decision: false,
  outstanding_tasks: "old",
  // Not part of the occupant DTO — must never reach the client.
  internal_audit_note: "LEAK-INTERNAL",
  nhs_number: "LEAK-NHS",
};
const caller = (allowed: boolean | "error" = true): WriteCaller => ({
  userId: USER,
  claims: { email: "clinician@synthetic.test" },
  checkClinical: async () => allowed,
});
function setup() {
  const hub = fakeHub([{ ...hubRow }, { ...hubRow, id: OTHER }]);
  const deps = { baseUrl: hub.deps.baseUrl, secret: hub.deps.secret, fetchImpl: hub.fetchImpl, timeoutMs: 200 };
  const posts = () => hub.calls.filter((c) => c.method === "POST");
  return { hub, deps, posts };
}
const input = (over: Partial<UpdatePartnerPatientInput> = {}): UpdatePartnerPatientInput =>
  ({ id: PT, expected_updated_at: "2026-11-16T10:00:00.000Z", outstanding_tasks: "new plan", ...over }) as UpdatePartnerPatientInput;
/** Wrap the fake Hub's POST reply. */
const replyWith = (hub: ReturnType<typeof fakeHub>, f: (status: number, body: any) => { status: number; body: unknown }) =>
  (async (url: RequestInfo | URL, init?: RequestInit) => {
    const res = await hub.fetchImpl(url, init);
    const out = f(res.status, await res.json().catch(() => null));
    return new Response(JSON.stringify(out.body), { status: out.status });
  }) as typeof fetch;

describe("Hub patient write handler", () => {
  it("no clinical access, or the check fails: nothing is signed or sent", async () => {
    const { deps, posts } = setup();
    expect(await writePartnerPatient(input(), caller(false), deps)).toEqual({ ok: false, error: "forbidden: clinical role required", status: 403 });
    expect(await writePartnerPatient(input(), caller("error"), deps)).toMatchObject({ ok: false, error: "Permission check failed — nothing was changed" });
    expect(await writePartnerPatient(input(), caller(), { ...deps, secret: "" })).toMatchObject({ ok: false });
    expect(posts()).toHaveLength(0);
  });

  it("valid partial update: only the allowlisted changed fields, signed with the caller as actor", async () => {
    const { hub, deps, posts } = setup();
    const r = await writePartnerPatient(
      { ...input(), wardable: true, unit_code: "OTHER-UNIT", desired_revision: "9" } as never,
      caller(),
      deps,
    );
    expect(r.ok).toBe(true);
    const call = posts()[0];
    expect(call.body).toEqual({ id: PT, expected_updated_at: "2026-11-16T10:00:00.000Z", outstanding_tasks: "new plan" });
    const actor = call.headers["x-actor"];
    expect(JSON.parse(actor)).toEqual({ id: USER, email: "clinician@synthetic.test", role: "clinician" });
    const expected = createHmac("sha256", hub.deps.secret).update(`${call.headers["x-timestamp"]}.${actor}.${JSON.stringify(call.body)}`).digest("hex");
    expect(call.headers["x-signature"]).toBe(expected);
    expect(hub.store.get(PT)!.outstanding_tasks).toBe("new plan");
    expect(hub.store.get(PT)!.full_name).toBe("Synthetic Person"); // untouched fields stay
  });

  it("success reply is reduced to the strict occupant DTO and must be for the same patient", async () => {
    const { hub, deps } = setup();
    const r = await writePartnerPatient(input(), caller(), deps);
    const text = JSON.stringify(r);
    expect(text).not.toContain("LEAK-INTERNAL");
    expect(text).not.toContain("LEAK-NHS");
    const wrong = replyWith(hub, (_s, b) => ({ status: 200, body: { patient: { ...b.patient, id: OTHER } } }));
    expect(await writePartnerPatient(input({ expected_updated_at: hub.store.get(PT)!.updated_at }), caller(), { ...deps, fetchImpl: wrong })).toEqual({
      ok: false,
      error: "ICU Handover Hub returned an unexpected response",
    });
  });

  it("stale CAS → 409 conflict; `current` is sanitised and dropped if it is another patient", async () => {
    const { hub, deps } = setup();
    hub.externalEdit(PT, { outstanding_tasks: "someone else" });
    const plain = await writePartnerPatient(input(), caller(), deps);
    expect(plain).toMatchObject({ ok: false, status: 409, conflict: undefined });
    expect(hub.store.get(PT)!.outstanding_tasks).toBe("someone else");

    const withCurrent = replyWith(hub, (s) => ({
      status: s,
      body: { current: { ...hub.store.get(PT) }, your_expected_updated_at: "2026-11-16T10:00:00.000Z", trace: "LEAK-TRACE" },
    }));
    const r = await writePartnerPatient(input(), caller(), { ...deps, fetchImpl: withCurrent });
    expect(r.ok === false && r.conflict?.current).toMatchObject({ id: PT, outstanding_tasks: "someone else" });
    expect(JSON.stringify(r)).not.toMatch(/LEAK-/);

    const otherCurrent = replyWith(hub, (s) => ({ status: s, body: { current: { ...hub.store.get(OTHER) } } }));
    const r2 = await writePartnerPatient(input(), caller(), { ...deps, fetchImpl: otherCurrent });
    expect(r2).toMatchObject({ ok: false, status: 409, conflict: undefined });
  });

  it("raw upstream errors are never echoed; revoked sharing and refusals use fixed text", async () => {
    const { hub, deps } = setup();
    const raw = (status: number) =>
      replyWith(hub, () => ({ status, body: { error: "LEAK-STACK at db.query(secret=synthetic-secret)", patient: hubRow } }));
    for (const [status, text] of [
      [500, "ICU Handover Hub is unavailable — nothing was changed"],
      [403, "ICU Handover Hub refused the update (no access to this patient)"],
      [401, "ICU Handover Hub refused the update (no access to this patient)"],
      [422, "ICU Handover Hub rejected the update"],
    ] as const) {
      const r = await writePartnerPatient(input(), caller(), { ...deps, fetchImpl: raw(status) });
      expect(r).toEqual({ ok: false, status, error: text });
    }
    hub.unshare(PT);
    expect(await writePartnerPatient(input(), caller(), deps)).toEqual({
      ok: false,
      status: 404,
      error: "This patient is no longer shared by ICU Handover Hub",
    });
    hub.control.hang = true;
    expect(await writePartnerPatient(input(), caller(), deps)).toEqual({
      ok: false,
      error: "ICU Handover Hub could not be reached — nothing was changed",
    });
  });
});
