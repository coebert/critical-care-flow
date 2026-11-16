import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Minimal context for the Bed Board "Arrived from …" banner, looked up by
 * opaque id instead of putting identifiers in the URL. Clinical role is
 * checked first; the row read then runs as the caller (RLS applies).
 */
export type AdmissionSourceContext =
  | { ok: true; kind: "referral" | "postop"; patient_initials: string | null }
  | { ok: false; error: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const getAdmissionSourceContext = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { kind: "referral" | "postop"; id: string }) => {
    if (d?.kind !== "referral" && d?.kind !== "postop") throw new Error("Invalid source");
    if (typeof d.id !== "string" || !UUID_RE.test(d.id)) throw new Error("Invalid source id");
    return { kind: d.kind, id: d.id };
  })
  .handler(async ({ data, context }): Promise<AdmissionSourceContext> => {
    const { data: allowed, error: roleErr } = await context.supabase.rpc("has_clinical_access", {
      _user_id: context.userId,
    });
    if (roleErr || allowed !== true) return { ok: false, error: "Not available" };
    const table = data.kind === "referral" ? "referrals" : "postop_bookings";
    const { data: row, error } = await context.supabase
      .from(table)
      .select("patient_initials")
      .eq("id", data.id)
      .maybeSingle();
    if (error || !row) return { ok: false, error: "Not available" };
    return { ok: true, kind: data.kind, patient_initials: row.patient_initials ?? null };
  });
