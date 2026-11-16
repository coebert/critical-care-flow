/**
 * Referral → Hub handover prefill: complete preview → confirm → partial,
 * revision-checked Hub update, with conflict / stale / revoked / mismatch
 * recovery. Synthetic data, in-memory Hub, no network.
 */
import { describe, it, expect } from "vitest";
import { fakeHub } from "@/test-utils/fake-hub";
import {
  runPrefillApply,
  runPrefillPreview,
  type PrefillDeps,
  type ReferralRow,
} from "./partner-handover-prefill.server";
import { computePartnerHandoverPrefill, SOURCE_LABEL } from "./partner-handover-prefill-core";

const REF_ID = "11111111-1111-4111-8111-111111111111";
const PT_ID = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const OTHER_USER = "44444444-4444-4444-8444-444444444444";
const caller = (userId = USER) => ({ userId, actor: { id: userId, role: "clinician" as const } });
const hash = (hn: string) => `h:${hn.trim().toLowerCase()}`;

function referral(over: Partial<ReferralRow> = {}): ReferralRow {
  return {
    id: REF_ID,
    updated_at: "2026-11-16T09:00:00.000000+00:00",
    hospital_number_hash: hash("SYN0001"),
    past_medical_history_enc: "enc:Synthetic PMH",
    baseline_function_enc: "enc:Independent",
    reason_for_referral_enc: "enc:Synthetic reason",
    allergies: "None known",
    weight_kg: 70,
    anticipated_interventions: ["invasive_ventilation"],
    ceiling_of_care: null,
    resus_status: "dnacpr",
    dnacpr_respect: true,
    ...over,
  };
}

function setup(opts: { ref?: Partial<ReferralRow>; patient?: Record<string, unknown>; clinical?: boolean | "error" } = {}) {
  const hub = fakeHub([
    {
      id: PT_ID,
      full_name: "SP",
      hospital_number: " syn0001 ",
      tep_in_place: false,
      dnacpr_decision: false,
      past_medical_history: null,
      current_admission: "",
      current_management: "Existing Hub plan",
      ...opts.patient,
    },
  ]);
  let ref = referral(opts.ref);
  const audits: unknown[] = [];
  let clinical = opts.clinical ?? true;
  const deps: PrefillDeps = {
    checkClinical: async () => clinical,
    loadReferral: async (id) => (id === ref.id ? ref : null),
    decrypt: (enc) => {
      if (!enc.startsWith("enc:")) throw new Error("bad ciphertext");
      return enc.slice(4);
    },
    hashHospitalNumber: hash,
    tokenSecret: "synthetic-token-secret",
    hub: hub.deps,
    audit: async (e) => void audits.push(e),
  };
  return {
    hub,
    deps,
    audits,
    setRef: (r: Partial<ReferralRow>) => (ref = { ...ref, ...r }),
    revoke: () => (clinical = false),
  };
}

const ids = { referral_id: REF_ID, partner_patient_id: PT_ID };

describe("handover prefill: fresh preview → confirm → Hub partial update", () => {
  it("previews only blank Hub fields, with labelled referral text, using a narrow signed GET", async () => {
    const t = setup();
    const p = await runPrefillPreview(ids, caller(), t.deps);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.fields.map((f) => f.field)).toEqual(["past_medical_history", "current_admission"]);
    expect(p.skipped_fields).toEqual(["current_management"]);
    expect(p.link_basis).toBe("hospital_number");
    for (const f of p.fields) expect(f.value.startsWith(SOURCE_LABEL)).toBe(true);
    // Narrow identity GET only; no write during preview.
    expect(t.hub.calls).toHaveLength(1);
    const get = t.hub.calls[0];
    expect(get.method).toBe("GET");
    expect(get.url.pathname).toBe("/api/public/bridge/patients");
    expect([...get.url.searchParams.entries()]).toEqual([["id", PT_ID]]);
    expect(get.headers["x-signature"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("applies after confirm with a partial patch + mandatory expected_updated_at, no name, no TEP/DNACPR", async () => {
    const t = setup();
    const p = await runPrefillPreview(ids, caller(), t.deps);
    if (!p.ok) throw new Error(p.message);
    const before = t.hub.store.get(PT_ID)!.updated_at;
    const a = await runPrefillApply({ ...ids, token: p.token }, caller(), t.deps);
    expect(a).toMatchObject({ ok: true, applied_fields: ["past_medical_history", "current_admission"] });
    const post = t.hub.calls.find((c) => c.method === "POST")!;
    expect(Object.keys(post.body!).sort()).toEqual(
      ["current_admission", "expected_updated_at", "id", "past_medical_history"].sort(),
    );
    expect(post.body!.expected_updated_at).toBe(before);
    expect(post.body).not.toHaveProperty("full_name");
    // Existing nonblank field and explicit false decisions untouched.
    const after = t.hub.store.get(PT_ID)!;
    expect(after.current_management).toBe("Existing Hub plan");
    expect(after.tep_in_place).toBe(false);
    expect(after.dnacpr_decision).toBe(false);
    expect(t.audits).toHaveLength(1);
  });

  it("rejects a stale preview when the Hub patient changed after preview, then recovers after reload", async () => {
    const t = setup();
    const p1 = await runPrefillPreview(ids, caller(), t.deps);
    if (!p1.ok) throw new Error();
    t.hub.externalEdit(PT_ID, { outstanding_tasks: "someone else" });
    const a1 = await runPrefillApply({ ...ids, token: p1.token }, caller(), t.deps);
    expect(a1).toMatchObject({ ok: false, code: "stale_preview" });
    expect(t.hub.calls.some((c) => c.method === "POST")).toBe(false);
    const p2 = await runPrefillPreview(ids, caller(), t.deps);
    if (!p2.ok) throw new Error();
    const a2 = await runPrefillApply({ ...ids, token: p2.token }, caller(), t.deps);
    expect(a2.ok).toBe(true);
  });

  it("rejects a stale preview when the referral changed after preview", async () => {
    const t = setup();
    const p = await runPrefillPreview(ids, caller(), t.deps);
    if (!p.ok) throw new Error();
    t.setRef({ updated_at: "2026-11-16T09:05:00.000000+00:00" });
    expect(await runPrefillApply({ ...ids, token: p.token }, caller(), t.deps)).toMatchObject({ code: "stale_preview" });
  });

  it("returns an explicit conflict when the Hub CAS fails at apply, and nothing is written", async () => {
    const t = setup();
    const p = await runPrefillPreview(ids, caller(), t.deps);
    if (!p.ok) throw new Error();
    t.hub.control.beforePost = () => t.hub.externalEdit(PT_ID, { outstanding_tasks: "race" });
    const a = await runPrefillApply({ ...ids, token: p.token }, caller(), t.deps);
    expect(a).toMatchObject({ ok: false, code: "conflict" });
    expect(t.hub.store.get(PT_ID)!.past_medical_history).toBeNull();
    expect(t.audits).toHaveLength(0);
  });

  it("binds the preview to the caller and the exact ids", async () => {
    const t = setup();
    const p = await runPrefillPreview(ids, caller(), t.deps);
    if (!p.ok) throw new Error();
    expect(await runPrefillApply({ ...ids, token: p.token }, caller(OTHER_USER), t.deps)).toMatchObject({ code: "invalid_preview" });
    expect(await runPrefillApply({ ...ids, token: p.token + "x" }, caller(), t.deps)).toMatchObject({ code: "invalid_preview" });
    expect(
      await runPrefillApply({ ...ids, partner_patient_id: "55555555-5555-4555-8555-555555555555", token: p.token }, caller(), t.deps),
    ).toMatchObject({ code: "invalid_preview" });
  });

  it("revoked sharing between preview and apply → not_shared, no write", async () => {
    const t = setup();
    const p = await runPrefillPreview(ids, caller(), t.deps);
    if (!p.ok) throw new Error();
    t.hub.unshare(PT_ID);
    const a = await runPrefillApply({ ...ids, token: p.token }, caller(), t.deps);
    expect(a).toMatchObject({ ok: false, code: "not_shared" });
    expect(t.hub.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("revoked clinical role → forbidden before any Hub request", async () => {
    const t = setup();
    const p = await runPrefillPreview(ids, caller(), t.deps);
    if (!p.ok) throw new Error();
    t.revoke();
    const n = t.hub.calls.length;
    expect(await runPrefillApply({ ...ids, token: p.token }, caller(), t.deps)).toMatchObject({ code: "forbidden" });
    expect(t.hub.calls.length).toBe(n);
  });

  it("blocks when the link cannot be verified, and when it mismatches — never guessing from initials/age", async () => {
    const noHn = setup({ patient: { hospital_number: null, full_name: "SP" } });
    expect(await runPrefillPreview(ids, caller(), noHn.deps)).toMatchObject({ ok: false, code: "link_unverified" });
    const wrong = setup({ patient: { hospital_number: "SYN9999" } });
    const w = await runPrefillPreview(ids, caller(), wrong.deps);
    expect(w).toMatchObject({ ok: false, code: "link_mismatch" });
    if (!w.ok) expect(w.message).not.toMatch(/SYN|Synthetic/);
    const otherRef = setup({ patient: { source_referral_id: "66666666-6666-4666-8666-666666666666" } });
    expect(await runPrefillPreview(ids, caller(), otherRef.deps)).toMatchObject({ code: "link_mismatch" });
    const linked = setup({ patient: { source_referral_id: REF_ID, hospital_number: null } });
    expect(await runPrefillPreview(ids, caller(), linked.deps)).toMatchObject({ ok: true, link_basis: "source_referral" });
  });

  it("fails clearly on a decrypt error — no partial preview and no write", async () => {
    const t = setup({ ref: { baseline_function_enc: "corrupt" } });
    const p = await runPrefillPreview(ids, caller(), t.deps);
    expect(p).toMatchObject({ ok: false, code: "decrypt_failed" });
    expect(t.hub.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("Hub outage → partner_unavailable, and a timeout is bounded", async () => {
    const t = setup();
    t.hub.control.down = true;
    expect(await runPrefillPreview(ids, caller(), t.deps)).toMatchObject({ code: "partner_unavailable" });
    t.hub.control.down = false;
    t.hub.control.hang = true;
    const started = Date.now();
    expect(await runPrefillPreview(ids, caller(), t.deps)).toMatchObject({ code: "partner_unavailable" });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("prefill mapping never makes a clinical decision", () => {
  const base = {
    past_medical_history: null,
    baseline_function: null,
    reason_for_referral: null,
    allergies: null,
    weight_kg: null,
    anticipated_interventions: null,
    ceiling_of_care: null,
    resus_status: null,
    dnacpr_respect: null,
  };
  it("ReSPECT/DNACPR form presence alone does not set a DNACPR decision; nothing touches TEP/DNACPR", () => {
    const plan = computePartnerHandoverPrefill({ ...base, dnacpr_respect: true }, {});
    expect(Object.keys(plan.patch)).toEqual(["current_management"]);
    expect(plan.patch.current_management).toMatch(/form presence only/);
    for (const k of ["tep_in_place", "dnacpr_decision", "tep_details", "dnacpr_details"]) {
      expect(plan.patch).not.toHaveProperty(k);
    }
  });
  it("interventions / ceiling / undocumented status do not imply a completed TEP", () => {
    const plan = computePartnerHandoverPrefill(
      { ...base, anticipated_interventions: ["invasive_ventilation"], ceiling_of_care: "full", resus_status: "not_documented" },
      { tep_in_place: false },
    );
    expect(plan.patch).not.toHaveProperty("tep_in_place");
    expect(plan.patch.current_management).toMatch(/Not documented/);
  });
  it("never overwrites nonblank Hub fields; whitespace counts as blank", () => {
    const plan = computePartnerHandoverPrefill(
      { ...base, past_medical_history: "A", reason_for_referral: "B" },
      { past_medical_history: "kept", current_admission: "   " },
    );
    expect(plan.skipped_fields).toEqual(["past_medical_history"]);
    expect(plan.applied_fields).toEqual(["current_admission"]);
  });
});
