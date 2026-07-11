import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  ANTICIPATED_INTERVENTIONS,
  CEILING_OF_CARE_OPTIONS,
  RESUS_STATUS_OPTIONS,
} from "./referral-clinical";

/**
 * Prefill the partner (ICU Handover Hub) patient handover form with the
 * clinical information captured on our referral, once the patient has been
 * admitted to a bed on the partner side.
 *
 * Contract:
 *  - Fill-blanks only: never overwrite a field that already has content on
 *    the partner.
 *  - Mapped fields:
 *      resus_status + dnacpr_respect + ceiling_of_care
 *        → tep_in_place, tep_details, dnacpr_decision, dnacpr_details
 *      past_medical_history → past_medical_history
 *      reason_for_referral  → current_admission
 *      baseline_function + allergies + weight + anticipated_interventions
 *        → current_management (structured summary)
 *  - Only clinicians/admins may run this; the write goes over the signed
 *    partner bridge as the caller's identity.
 */

const inputSchema = z.object({
  referral_id: z.string().uuid(),
  partner_patient_id: z.string().uuid(),
});

export type PrefillPartnerHandoverResult =
  | {
      ok: true;
      applied_fields: string[];
      skipped_fields: string[];
      updated_at: string | null;
    }
  | { ok: false; error: string; status?: number };

function ceilingLabel(v: string | null | undefined): string | null {
  if (!v) return null;
  return CEILING_OF_CARE_OPTIONS.find((o) => o.value === v)?.label ?? v;
}
function resusLabel(v: string | null | undefined): string | null {
  if (!v) return null;
  return RESUS_STATUS_OPTIONS.find((o) => o.value === v)?.label ?? v;
}
function interventionLabel(v: string): string {
  return ANTICIPATED_INTERVENTIONS.find((o) => o.value === v)?.label ?? v;
}

/** True when the partner field is missing/blank and should be filled. */
function isBlank(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === "string" && v.trim() === "") return true;
  return false;
}

/** Compose the current_management summary from referral clinical fields. */
function composeCurrentManagement(ref: {
  baseline_function: string | null;
  allergies: string | null;
  weight_kg: number | null;
  anticipated_interventions: string[] | null;
}): string | null {
  const parts: string[] = [];
  if (ref.anticipated_interventions && ref.anticipated_interventions.length) {
    parts.push(
      `Anticipated interventions: ${ref.anticipated_interventions
        .map(interventionLabel)
        .join(", ")}.`,
    );
  }
  if (ref.allergies && ref.allergies.trim()) {
    parts.push(`Allergies: ${ref.allergies.trim()}.`);
  }
  if (ref.weight_kg != null) {
    parts.push(`Weight: ${ref.weight_kg} kg.`);
  }
  if (ref.baseline_function && ref.baseline_function.trim()) {
    parts.push(`Baseline function: ${ref.baseline_function.trim()}.`);
  }
  return parts.length ? parts.join("\n") : null;
}

/** Compose the TEP text from ceiling-of-care + resus-status. */
function composeTepDetails(
  ceiling_of_care: string | null,
  resus_status: string | null,
): string | null {
  const bits: string[] = [];
  const c = ceilingLabel(ceiling_of_care);
  const r = resusLabel(resus_status);
  if (c) bits.push(`Ceiling of care: ${c}`);
  if (r) bits.push(`Resus status: ${r}`);
  if (!bits.length) return null;
  return `${bits.join(". ")}. (Auto-populated from critical care referral.)`;
}

function composeDnacprDetails(
  resus_status: string | null,
  dnacpr_respect: boolean | null,
): string | null {
  if (resus_status === "dnacpr") {
    return "DNACPR documented on critical care referral.";
  }
  if (dnacpr_respect === true) {
    return "ReSPECT / DNACPR form recorded on critical care referral.";
  }
  return null;
}

/**
 * Pure mapping: given the decrypted referral fields and the current partner
 * patient row, decide which fields to fill (fill-blanks only) and the exact
 * patch we would send across the bridge. Exported for unit tests.
 */
export interface ReferralPrefillSource {
  past_medical_history: string | null;
  baseline_function: string | null;
  reason_for_referral: string | null;
  allergies: string | null;
  weight_kg: number | null;
  anticipated_interventions: string[] | null;
  ceiling_of_care: string | null;
  resus_status: string | null;
  dnacpr_respect: boolean | null;
}

export interface PartnerPatientCurrent {
  tep_in_place: boolean | null;
  tep_details: string | null;
  dnacpr_decision: boolean | null;
  dnacpr_details: string | null;
  past_medical_history: string | null;
  current_admission: string | null;
  current_management: string | null;
}

export interface PartnerHandoverPrefillPlan {
  patch: Record<string, string | boolean>;
  applied_fields: string[];
  skipped_fields: string[];
}

export function computePartnerHandoverPrefill(
  ref: ReferralPrefillSource,
  patient: PartnerPatientCurrent,
): PartnerHandoverPrefillPlan {
  const wantsDnacpr =
    ref.resus_status === "dnacpr" || ref.dnacpr_respect === true;
  const wantsTep =
    !!ref.ceiling_of_care ||
    !!ref.resus_status ||
    wantsDnacpr ||
    (ref.anticipated_interventions?.length ?? 0) > 0;

  const proposed: Record<string, string | boolean | null | undefined> = {
    tep_in_place: wantsTep ? true : undefined,
    tep_details: composeTepDetails(ref.ceiling_of_care, ref.resus_status),
    dnacpr_decision: wantsDnacpr ? true : undefined,
    dnacpr_details: composeDnacprDetails(ref.resus_status, ref.dnacpr_respect),
    past_medical_history: ref.past_medical_history,
    current_admission: ref.reason_for_referral,
    current_management: composeCurrentManagement({
      baseline_function: ref.baseline_function,
      allergies: ref.allergies,
      weight_kg: ref.weight_kg,
      anticipated_interventions: ref.anticipated_interventions,
    }),
  };

  const applied: string[] = [];
  const skipped: string[] = [];
  const patch: Record<string, string | boolean> = {};

  const textFields = [
    "tep_details",
    "dnacpr_details",
    "past_medical_history",
    "current_admission",
    "current_management",
  ] as const;
  for (const k of textFields) {
    const val = proposed[k];
    if (val == null || val === "") continue;
    if (isBlank((patient as unknown as Record<string, unknown>)[k])) {
      patch[k] = val as string;
      applied.push(k);
    } else {
      skipped.push(k);
    }
  }

  if (proposed.tep_in_place === true) {
    if (!patient.tep_in_place) {
      patch.tep_in_place = true;
      applied.push("tep_in_place");
    } else {
      skipped.push("tep_in_place");
    }
  }
  if (proposed.dnacpr_decision === true) {
    if (!patient.dnacpr_decision) {
      patch.dnacpr_decision = true;
      applied.push("dnacpr_decision");
    } else {
      skipped.push("dnacpr_decision");
    }
  }

  return { patch, applied_fields: applied, skipped_fields: skipped };
}


export const prefillPartnerHandoverFromReferral = createServerFn({
  method: "POST",
})
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => inputSchema.parse(d))
  .handler(
    async ({ data, context }): Promise<PrefillPartnerHandoverResult> => {
      const base = process.env.PARTNER_BRIDGE_URL;
      if (!base) {
        return { ok: false, error: "PARTNER_BRIDGE_URL is not configured" };
      }

      // Only clinicians/admins on our side may write across the bridge.
      const { data: allowed, error: roleErr } = await context.supabase.rpc(
        "has_clinical_access",
        { _user_id: context.userId },
      );
      if (roleErr) {
        return { ok: false, error: `authz check failed: ${roleErr.message}` };
      }
      if (!allowed) {
        return {
          ok: false,
          error: "forbidden: clinical role required",
          status: 403,
        };
      }

      // Load the referral (with encrypted fields decrypted) and the current
      // partner-mirrored patient row so we know which fields are blank.
      const [{ supabaseAdmin }, { decryptString }] = await Promise.all([
        import("@/integrations/supabase/client.server"),
        import("./crypto.server"),
      ]);

      const { data: refRow, error: refErr } = await supabaseAdmin
        .from("referrals")
        .select(
          "id, past_medical_history_enc, baseline_function_enc, reason_for_referral_enc, allergies, weight_kg, anticipated_interventions, ceiling_of_care, resus_status, dnacpr_respect",
        )
        .eq("id", data.referral_id)
        .is("deleted_at", null)
        .maybeSingle();
      if (refErr) return { ok: false, error: refErr.message };
      if (!refRow) return { ok: false, error: "referral not found" };

      const safeDecrypt = (enc: string | null): string | null => {
        if (!enc) return null;
        try {
          return decryptString(enc);
        } catch {
          return null;
        }
      };

      const past_medical_history = safeDecrypt(
        (refRow as any).past_medical_history_enc,
      );
      const baseline_function = safeDecrypt(
        (refRow as any).baseline_function_enc,
      );
      const reason_for_referral = safeDecrypt(
        (refRow as any).reason_for_referral_enc,
      );

      const { data: patientRow, error: patientErr } = await supabaseAdmin
        .from("patients")
        .select(
          "id, updated_at, tep_in_place, tep_details, dnacpr_decision, dnacpr_details, past_medical_history, current_admission, current_management",
        )
        .eq("id", data.partner_patient_id)
        .maybeSingle();
      if (patientErr) return { ok: false, error: patientErr.message };
      if (!patientRow) {
        return {
          ok: false,
          error:
            "Partner patient not found locally — wait for the next bridge sync and try again.",
        };
      }

      // Compute proposed values.
      const resus = (refRow as any).resus_status as string | null;
      const ceiling = (refRow as any).ceiling_of_care as string | null;
      const dnacprRespect = (refRow as any).dnacpr_respect as boolean | null;
      const interventions =
        ((refRow as any).anticipated_interventions as string[] | null) ?? null;

      const wantsDnacpr = resus === "dnacpr" || dnacprRespect === true;
      const wantsTep =
        !!ceiling ||
        !!resus ||
        wantsDnacpr ||
        (interventions?.length ?? 0) > 0;

      const proposed: Record<
        string,
        string | boolean | number | null | undefined
      > = {
        tep_in_place: wantsTep ? true : undefined,
        tep_details: composeTepDetails(ceiling, resus),
        dnacpr_decision: wantsDnacpr ? true : undefined,
        dnacpr_details: composeDnacprDetails(resus, dnacprRespect),
        past_medical_history: past_medical_history,
        current_admission: reason_for_referral,
        current_management: composeCurrentManagement({
          baseline_function,
          allergies: (refRow as any).allergies ?? null,
          weight_kg: (refRow as any).weight_kg ?? null,
          anticipated_interventions: interventions,
        }),
      };

      // Fill-blanks only: skip anything already populated on the partner.
      const applied: string[] = [];
      const skipped: string[] = [];
      const patch: Record<string, unknown> = {};

      const textFields = [
        "tep_details",
        "dnacpr_details",
        "past_medical_history",
        "current_admission",
        "current_management",
      ] as const;
      for (const k of textFields) {
        const proposedVal = proposed[k];
        if (proposedVal == null || proposedVal === "") continue;
        if (isBlank((patientRow as any)[k])) {
          patch[k] = proposedVal;
          applied.push(k);
        } else {
          skipped.push(k);
        }
      }

      // Boolean flags — only set true when currently falsy/null and we have a
      // reason to set them. Never flip an existing true back to false.
      if (proposed.tep_in_place === true) {
        if (!(patientRow as any).tep_in_place) {
          patch.tep_in_place = true;
          applied.push("tep_in_place");
        } else {
          skipped.push("tep_in_place");
        }
      }
      if (proposed.dnacpr_decision === true) {
        if (!(patientRow as any).dnacpr_decision) {
          patch.dnacpr_decision = true;
          applied.push("dnacpr_decision");
        } else {
          skipped.push("dnacpr_decision");
        }
      }

      if (applied.length === 0) {
        return {
          ok: true,
          applied_fields: [],
          skipped_fields: skipped,
          updated_at: (patientRow as any).updated_at ?? null,
        };
      }

      // Push over the signed partner bridge.
      let secret: string;
      try {
        const { getBridgeSecrets } = await import("@/lib/bridge-hmac.server");
        secret = getBridgeSecrets().current;
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }

      const claims = context.claims as Record<string, unknown>;
      const email =
        typeof claims.email === "string" ? claims.email : undefined;
      const actor = JSON.stringify({
        id: context.userId,
        email,
        role: "clinician",
      });

      const bodyObj: Record<string, unknown> = {
        id: data.partner_patient_id,
        ...patch,
      };
      if ((patientRow as any).updated_at) {
        bodyObj.expected_updated_at = (patientRow as any).updated_at;
      }
      const rawBody = JSON.stringify(bodyObj);

      const timestamp = String(Math.floor(Date.now() / 1000));
      const { createHmac } = await import("node:crypto");
      const signature = createHmac("sha256", secret)
        .update(`${timestamp}.${actor}.${rawBody}`)
        .digest("hex");

      const url = `${base.replace(/\/$/, "")}/patients`;
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-timestamp": timestamp,
            "x-actor": actor,
            "x-signature": signature,
            "cache-control": "no-store",
          },
          body: rawBody,
        });
      } catch (err) {
        return {
          ok: false,
          error: `partner unreachable: ${(err as Error).message}`,
        };
      }

      let payload: unknown = null;
      try {
        payload = await res.json();
      } catch {
        /* keep null */
      }

      if (!res.ok) {
        const msg =
          (payload as { error?: string; message?: string } | null)?.error ||
          (payload as { error?: string; message?: string } | null)?.message ||
          res.statusText;
        return {
          ok: false,
          status: res.status,
          error: `partner ${res.status}: ${msg}`,
        };
      }

      // Audit the prefill on our side so we can trace referral-origin writes.
      try {
        await supabaseAdmin.from("audit_log").insert({
          user_id: context.userId,
          action: "update",
          entity: "partner_handover_prefill",
          entity_id: data.partner_patient_id,
          diff: {
            source: "referral_prefill",
            referral_id: data.referral_id,
            applied_fields: applied,
            skipped_fields: skipped,
          } as any,
        });
      } catch {
        /* audit failure must not block the prefill result */
      }

      const patient = (payload as { patient?: { updated_at?: string | null } } | null)
        ?.patient;
      return {
        ok: true,
        applied_fields: applied,
        skipped_fields: skipped,
        updated_at: patient?.updated_at ?? null,
      };
    },
  );
