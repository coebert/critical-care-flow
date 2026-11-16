/**
 * Server-only core of the signed Hub patient write (updatePartnerPatient).
 * Extracted so the exact handler behaviour is testable with a synthetic Hub:
 * clinical check BEFORE signing, only allowlisted fields sent, strict DTO
 * on every reply, fixed error text (upstream bodies never echoed), and a
 * 409's `current` row accepted only for the same patient.
 */
import { createHmac } from "node:crypto";
import { occupantDtoOrNull } from "./partner-bed-board-contract";
import type { UpdatePartnerPatientInput, UpdatePartnerPatientResult } from "./partner-bed-board.functions";

export type WriteCaller = {
  userId: string;
  claims: Record<string, unknown>;
  /** has_clinical_access for the caller; "error" = could not check. */
  checkClinical: () => Promise<boolean | "error">;
};
export type WriteDeps = {
  baseUrl?: string | null;
  secret?: string | null;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
};

export const WRITABLE_FIELDS = [
  "full_name",
  "hospital_number",
  "age",
  "bed",
  "status",
  "tep_in_place",
  "tep_details",
  "dnacpr_decision",
  "dnacpr_details",
  "outstanding_tasks",
  "past_medical_history",
  "current_admission",
  "current_management",
] as const;

export async function writePartnerPatient(
  data: UpdatePartnerPatientInput,
  caller: WriteCaller,
  deps: WriteDeps,
): Promise<UpdatePartnerPatientResult> {
  const base = deps.baseUrl;
  if (!base) return { ok: false, error: "PARTNER_BRIDGE_URL is not configured" };

  // Only clinicians/admins on our side may write across the bridge.
  const allowed = await caller.checkClinical().catch(() => "error" as const);
  if (allowed === "error") return { ok: false, error: "Permission check failed — nothing was changed" };
  if (!allowed) return { ok: false, error: "forbidden: clinical role required", status: 403 };

  const secret = deps.secret;
  if (!secret) return { ok: false, error: "ICU Handover Hub link is not configured" };

  // Forward the caller's identity as the actor. Partner authorize() treats
  // the actor as authentic because it is inside the HMAC envelope.
  const email = typeof caller.claims.email === "string" ? caller.claims.email : undefined;
  const actor = JSON.stringify({ id: caller.userId, email, role: "clinician" });

  const bodyObj: Record<string, unknown> = { id: data.id };
  if (data.expected_updated_at) bodyObj.expected_updated_at = data.expected_updated_at;
  for (const key of WRITABLE_FIELDS) {
    const v = (data as Record<string, unknown>)[key];
    if (v !== undefined) bodyObj[key] = v;
  }
  const rawBody = JSON.stringify(bodyObj);

  const timestamp = String(Math.floor((deps.now ?? (() => new Date()))().getTime() / 1000));
  const signature = createHmac("sha256", secret).update(`${timestamp}.${actor}.${rawBody}`).digest("hex");

  const url = `${base.replace(/\/$/, "")}/patients`;
  let res: Response;
  try {
    res = await (deps.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-timestamp": timestamp,
        "x-actor": actor,
        "x-signature": signature,
        "cache-control": "no-store",
      },
      body: rawBody,
      signal: AbortSignal.timeout(deps.timeoutMs ?? 8_000),
    });
  } catch {
    return { ok: false, error: "ICU Handover Hub could not be reached — nothing was changed" };
  }

  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    /* keep null */
  }

  if (res.status === 409) {
    const p = (payload ?? {}) as { current?: unknown; your_expected_updated_at?: unknown };
    // Strict DTO; a "current" row for a different patient is discarded.
    const current = occupantDtoOrNull(p.current);
    return {
      ok: false,
      status: 409,
      error: "This patient was modified in ICU Handover Hub since you loaded it.",
      conflict:
        current && current.id === data.id
          ? {
              current,
              your_expected_updated_at: typeof p.your_expected_updated_at === "string" ? p.your_expected_updated_at : null,
            }
          : undefined,
    };
  }

  if (!res.ok) {
    // Fixed text per status class; upstream bodies are never echoed.
    const error =
      res.status === 401 || res.status === 403
        ? "ICU Handover Hub refused the update (no access to this patient)"
        : res.status === 404
          ? "This patient is no longer shared by ICU Handover Hub"
          : res.status >= 500
            ? "ICU Handover Hub is unavailable — nothing was changed"
            : "ICU Handover Hub rejected the update";
    return { ok: false, status: res.status, error };
  }

  const patient = occupantDtoOrNull((payload as { patient?: unknown } | null)?.patient);
  if (!patient || patient.id !== data.id) {
    return { ok: false, error: "ICU Handover Hub returned an unexpected response" };
  }
  return { ok: true, patient };
}
