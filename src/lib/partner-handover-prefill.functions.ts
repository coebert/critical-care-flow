import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { PrefillApplyResult, PrefillPreviewResult } from "./partner-handover-prefill-core";

/**
 * Referral → ICU Handover Hub handover prefill, in two explicit steps:
 *   1. preview: fresh Hub read + verified link → exactly which blank Hub
 *      fields would be filled, with the text, plus a signed token.
 *   2. apply: only after the clinician confirms; re-verifies everything,
 *      rejects a stale preview, and sends a partial, revision-checked patch.
 * See partner-handover-prefill-core.ts for the clinical safety rules.
 */
export type { PrefillApplyResult, PrefillPreviewResult } from "./partner-handover-prefill-core";
export { computePartnerHandoverPrefill } from "./partner-handover-prefill-core";

const ids = z.object({
  referral_id: z.string().uuid(),
  partner_patient_id: z.string().uuid(),
});

async function buildDeps(context: { supabase: any; userId: string; claims: unknown }) {
  const [{ supabaseAdmin }, crypto, { getBridgeSecrets }, { actorFor }] = await Promise.all([
    import("@/integrations/supabase/client.server"),
    import("./crypto.server"),
    import("./bridge-hmac.server"),
    import("./hub-client.server"),
  ]);
  let tokenSecret = "";
  try {
    tokenSecret = getBridgeSecrets().current;
  } catch {
    tokenSecret = "";
  }
  const deps = {
    checkClinical: async () => {
      const { data, error } = await context.supabase.rpc("has_clinical_access", { _user_id: context.userId });
      if (error) return "error" as const;
      return data === true;
    },
    loadReferral: async (id: string) => {
      const { data, error } = await supabaseAdmin
        .from("referrals")
        .select(
          "id, updated_at, hospital_number_hash, past_medical_history_enc, baseline_function_enc, reason_for_referral_enc, allergies, weight_kg, anticipated_interventions, ceiling_of_care, resus_status, dnacpr_respect",
        )
        .eq("id", id)
        .is("deleted_at", null)
        .maybeSingle();
      if (error) return "error" as const;
      return (data ?? null) as any;
    },
    decrypt: crypto.decryptString,
    hashHospitalNumber: (hn: string) => crypto.hashHospitalNumber(hn),
    tokenSecret,
    audit: async (entry: { referral_id: string; partner_patient_id: string; applied_fields: string[] }) => {
      await supabaseAdmin.from("audit_log").insert({
        user_id: context.userId,
        action: "update",
        entity: "partner_handover_prefill",
        entity_id: entry.partner_patient_id,
        diff: { source: "referral_prefill", referral_id: entry.referral_id, applied_fields: entry.applied_fields } as any,
      });
    },
  };
  return { deps, caller: { userId: context.userId, actor: actorFor(context.userId, context.claims as Record<string, unknown>) }, tokenSecret };
}

export const previewPartnerHandoverPrefill = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => ids.parse(d))
  .handler(async ({ data, context }): Promise<PrefillPreviewResult> => {
    const { deps, caller, tokenSecret } = await buildDeps(context);
    if (!tokenSecret) return { ok: false, code: "not_configured", message: "The ICU Handover Hub link is not configured." };
    const { runPrefillPreview } = await import("./partner-handover-prefill.server");
    return runPrefillPreview(data, caller, deps);
  });

export const applyPartnerHandoverPrefill = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => ids.extend({ token: z.string().min(1).max(2048) }).parse(d))
  .handler(async ({ data, context }): Promise<PrefillApplyResult> => {
    const { deps, caller, tokenSecret } = await buildDeps(context);
    if (!tokenSecret) return { ok: false, code: "not_configured", message: "The ICU Handover Hub link is not configured." };
    const { runPrefillApply } = await import("./partner-handover-prefill.server");
    return runPrefillApply(data, caller, deps);
  });
