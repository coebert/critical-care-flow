/**
 * Server-only: preview → confirm → apply for the referral → Hub handover
 * prefill. Every step re-checks the caller's clinical role, reads the Hub
 * patient FRESH (GET /patients?id=), verifies the referral ↔ patient link
 * server-side, and binds the apply to the exact previewed revisions, fields
 * and caller via a signed, short-lived token.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  fetchHubPatient,
  patchHubPatient,
  isUuid,
  type HubActor,
  type HubDeps,
  type HubPatient,
} from "./hub-client.server";
import {
  PREFILL_FIELD_LABEL,
  PREFILL_MESSAGES,
  computePartnerHandoverPrefill,
  type PrefillApplyResult,
  type PrefillFailureCode,
  type PrefillPreviewResult,
  type ReferralPrefillSource,
} from "./partner-handover-prefill-core";

export const PREVIEW_TTL_MS = 10 * 60_000;

export type ReferralRow = {
  id: string;
  updated_at: string;
  hospital_number_hash: string | null;
  past_medical_history_enc: string | null;
  baseline_function_enc: string | null;
  reason_for_referral_enc: string | null;
  allergies: string | null;
  weight_kg: number | null;
  anticipated_interventions: string[] | null;
  ceiling_of_care: string | null;
  resus_status: string | null;
  dnacpr_respect: boolean | null;
};

export type PrefillDeps = {
  checkClinical: () => Promise<boolean | "error">;
  loadReferral: (id: string) => Promise<ReferralRow | null | "error">;
  /** Must throw on any decryption failure. */
  decrypt: (enc: string) => string | null;
  hashHospitalNumber: (hn: string) => string | null;
  tokenSecret: string;
  hub?: HubDeps;
  now?: () => number;
  audit?: (entry: { referral_id: string; partner_patient_id: string; applied_fields: string[] }) => Promise<void>;
};

type Caller = { userId: string; actor: HubActor };
type Fail = { ok: false; code: PrefillFailureCode; message: string };
const fail = (code: PrefillFailureCode): Fail => ({ ok: false, code, message: PREFILL_MESSAGES[code] });

// ---- token --------------------------------------------------------------
type TokenBody = { v: 1; sub: string; ref: string; pt: string; sr: string; tr: string; fh: string; exp: number };
const b64u = (b: Buffer) => b.toString("base64url");
const tokenKey = (secret: string) => `${secret}:handover-prefill-preview:v1`;

export function signPreviewToken(body: TokenBody, secret: string): string {
  const payload = b64u(Buffer.from(JSON.stringify(body), "utf8"));
  const sig = b64u(createHmac("sha256", tokenKey(secret)).update(payload).digest());
  return `${payload}.${sig}`;
}

export function verifyPreviewToken(token: unknown, secret: string): TokenBody | null {
  if (typeof token !== "string" || token.length > 2048) return null;
  const [payload, sig, extra] = token.split(".");
  if (!payload || !sig || extra !== undefined) return null;
  const expected = createHmac("sha256", tokenKey(secret)).update(payload).digest();
  let given: Buffer;
  try {
    given = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as TokenBody;
    if (body?.v !== 1 || typeof body.exp !== "number") return null;
    return body;
  } catch {
    return null;
  }
}

const patchHash = (patch: Record<string, string>) =>
  createHash("sha256")
    .update(JSON.stringify(Object.keys(patch).sort().map((k) => [k, patch[k]])))
    .digest("hex");

// ---- shared steps -------------------------------------------------------
type Resolved = { referral: ReferralRow; patient: HubPatient; source: ReferralPrefillSource; basis: "source_referral" | "hospital_number" };

export function verifyLink(
  referral: Pick<ReferralRow, "id" | "hospital_number_hash">,
  patient: HubPatient,
  hash: (hn: string) => string | null,
): { ok: true; basis: "source_referral" | "hospital_number" } | Fail {
  const src = patient.source_referral_id;
  if (typeof src === "string" && src.trim()) {
    return src === referral.id ? { ok: true, basis: "source_referral" } : fail("link_mismatch");
  }
  const hn = typeof patient.hospital_number === "string" ? patient.hospital_number.trim() : "";
  if (!hn || !referral.hospital_number_hash) return fail("link_unverified");
  return hash(hn) === referral.hospital_number_hash ? { ok: true, basis: "hospital_number" } : fail("link_mismatch");
}

async function resolve(
  referralId: string,
  partnerPatientId: string,
  caller: Caller,
  deps: PrefillDeps,
): Promise<Resolved | Fail> {
  const allowed = await deps.checkClinical();
  if (allowed !== true) return fail("forbidden");
  if (!isUuid(referralId) || !isUuid(partnerPatientId)) return fail("invalid_preview");

  const referral = await deps.loadReferral(referralId);
  if (referral === "error" || !referral) return fail("referral_not_found");

  const hub = await fetchHubPatient(partnerPatientId, caller.actor, deps.hub);
  if (hub.kind === "not_configured") return fail("not_configured");
  if (hub.kind === "not_shared" || hub.kind === "forbidden") return fail("not_shared");
  if (hub.kind !== "ok") return fail("partner_unavailable");

  const link = verifyLink(referral, hub.patient, deps.hashHospitalNumber);
  if (!link.ok) return link;

  let source: ReferralPrefillSource;
  try {
    const dec = (enc: string | null) => (enc ? deps.decrypt(enc) : null);
    source = {
      past_medical_history: dec(referral.past_medical_history_enc),
      baseline_function: dec(referral.baseline_function_enc),
      reason_for_referral: dec(referral.reason_for_referral_enc),
      allergies: referral.allergies ?? null,
      weight_kg: referral.weight_kg ?? null,
      anticipated_interventions: referral.anticipated_interventions ?? null,
      ceiling_of_care: referral.ceiling_of_care ?? null,
      resus_status: referral.resus_status ?? null,
      dnacpr_respect: referral.dnacpr_respect ?? null,
    };
  } catch {
    // Never a partial, silent success.
    return fail("decrypt_failed");
  }
  return { referral, patient: hub.patient, source, basis: link.basis };
}

export async function runPrefillPreview(
  input: { referral_id: string; partner_patient_id: string },
  caller: Caller,
  deps: PrefillDeps,
): Promise<PrefillPreviewResult> {
  const r = await resolve(input.referral_id, input.partner_patient_id, caller, deps);
  if ("ok" in r) return r;
  const plan = computePartnerHandoverPrefill(r.source, r.patient);
  const now = (deps.now ?? Date.now)();
  const exp = now + PREVIEW_TTL_MS;
  const token = signPreviewToken(
    {
      v: 1,
      sub: caller.userId,
      ref: r.referral.id,
      pt: r.patient.id,
      sr: r.referral.updated_at,
      tr: r.patient.updated_at,
      fh: patchHash(plan.patch as Record<string, string>),
      exp,
    },
    deps.tokenSecret,
  );
  return {
    ok: true,
    token,
    fields: plan.applied_fields.map((f) => ({ field: f, label: PREFILL_FIELD_LABEL[f], value: plan.patch[f]! })),
    skipped_fields: plan.skipped_fields,
    link_basis: r.basis,
    expires_at: new Date(exp).toISOString(),
  };
}

export async function runPrefillApply(
  input: { referral_id: string; partner_patient_id: string; token: string },
  caller: Caller,
  deps: PrefillDeps,
): Promise<PrefillApplyResult> {
  const body = verifyPreviewToken(input.token, deps.tokenSecret);
  const now = (deps.now ?? Date.now)();
  if (!body || body.sub !== caller.userId || body.ref !== input.referral_id || body.pt !== input.partner_patient_id) {
    return fail("invalid_preview");
  }
  if (body.exp < now) return fail("stale_preview");

  const r = await resolve(input.referral_id, input.partner_patient_id, caller, deps);
  if ("ok" in r) return r;
  if (r.referral.updated_at !== body.sr || r.patient.updated_at !== body.tr) return fail("stale_preview");

  const plan = computePartnerHandoverPrefill(r.source, r.patient);
  if (patchHash(plan.patch as Record<string, string>) !== body.fh) return fail("stale_preview");
  if (plan.applied_fields.length === 0) return { ok: true, applied_fields: [], updated_at: r.patient.updated_at };

  const out = await patchHubPatient(r.patient.id, body.tr, plan.patch, caller.actor, deps.hub);
  if (out.kind === "conflict") return fail("conflict");
  if (out.kind === "not_shared" || out.kind === "forbidden") return fail("not_shared");
  if (out.kind === "not_configured") return fail("not_configured");
  if (out.kind === "unavailable") return fail("partner_unavailable");
  if (out.kind === "rejected") return fail("rejected");

  try {
    await deps.audit?.({
      referral_id: r.referral.id,
      partner_patient_id: r.patient.id,
      applied_fields: plan.applied_fields,
    });
  } catch {
    /* audit failure must not misreport a completed Hub write */
  }
  return { ok: true, applied_fields: plan.applied_fields, updated_at: out.updated_at };
}
