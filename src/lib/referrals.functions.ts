import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const refSchema = z.object({
  age: z.number().int().min(0).max(130).nullable().optional(),
  sex: z.enum(["male", "female", "other", "unknown"]).nullable().optional(),
  hospital_number: z.string().trim().max(50).nullable().optional(),
  current_ward: z.string().trim().max(100).nullable().optional(),
  current_bed: z.string().trim().max(50).nullable().optional(),
  past_medical_history: z.string().trim().max(5000).nullable().optional(),
  baseline_function: z.string().trim().max(2000).nullable().optional(),
  dnacpr_respect: z.boolean().optional(),
  referring_specialty: z.string().trim().max(100).nullable().optional(),
  reason_for_referral: z.string().trim().max(5000).nullable().optional(),
  referral_received_at: z.string().optional(),
  first_seen_at: z.string().nullable().optional(),
  decision_at: z.string().nullable().optional(),
  arrived_on_unit_at: z.string().nullable().optional(),
  status: z.enum(["pending", "declined", "admitted"]).optional(),
  decline_reason: z.string().trim().max(2000).nullable().optional(),
});

async function getAdmin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

async function writeAudit(entry: {
  user_id: string;
  action: string;
  entity: string;
  entity_id: string;
  diff?: any;
}) {
  const admin = await getAdmin();
  await admin.from("audit_log").insert(entry as any);
}

async function fanOutNotifications(
  userId: string,
  referralId: string,
  kind: "new" | "updated",
  message: string,
) {
  const admin = await getAdmin();
  const { data: others } = await admin
    .from("user_roles")
    .select("user_id")
    .neq("user_id", userId);
  if (!others?.length) return;
  const unique = Array.from(new Set(others.map((r: any) => r.user_id as string)));
  const rows = unique.map((uid) => ({
    user_id: uid,
    referral_id: referralId,
    kind,
    message,
  }));
  await admin.from("notifications").insert(rows);
}


export const createReferral = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => refSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const insert = {
      ...data,
      created_by: userId,
      updated_by: userId,
      referral_received_at: data.referral_received_at ?? new Date().toISOString(),
    };
    const { data: row, error } = await supabase
      .from("referrals")
      .insert(insert as any)
      .select()
      .single();
    if (error) throw new Error(error.message);

    await writeAudit({
      user_id: userId,
      action: "create",
      entity: "referral",
      entity_id: row.id,
      diff: row as any,
    });

    const summary = `${row.referring_specialty ?? "Referral"} — ${row.current_ward ?? "ward unknown"}`;
    await fanOutNotifications(userId, row.id, "new", `New referral: ${summary}`);
    return row;
  });


export const updateReferral = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ id: z.string().uuid(), patch: refSchema }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: row, error } = await supabase
      .from("referrals")
      .update({ ...data.patch, updated_by: userId } as any)
      .eq("id", data.id)
      .select()
      .single();
    if (error) throw new Error(error.message);

    await writeAudit({
      user_id: userId,
      action: "update",
      entity: "referral",
      entity_id: row.id,
      diff: data.patch as any,
    });

    const summary = `${row.referring_specialty ?? "Referral"} — ${row.current_ward ?? "ward unknown"}`;
    await fanOutNotifications(userId, row.id, "updated", `Updated: ${summary}`);
    return row;
  });


export const addNote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({ referral_id: z.string().uuid(), body: z.string().trim().min(1).max(2000) })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: row, error } = await supabase
      .from("referral_notes")
      .insert({ referral_id: data.referral_id, author_id: userId, body: data.body })
      .select()
      .single();
    if (error) throw new Error(error.message);

    await supabase.from("audit_log").insert({
      user_id: userId,
      action: "create",
      entity: "referral_note",
      entity_id: row.id,
      diff: { referral_id: data.referral_id, body: data.body },
    });

    await fanOutNotifications(
      supabase,
      userId,
      data.referral_id,
      "updated",
      `New note added to referral`,
    );
    return row;
  });

export const logReferralView = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ referral_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await supabase.from("audit_log").insert({
      user_id: userId,
      action: "view",
      entity: "referral",
      entity_id: data.referral_id,
    });
    return { ok: true };
  });

export const deleteReferral = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: isAdmin } = await supabase.rpc("has_role", {
      _user_id: userId,
      _role: "admin",
    });
    if (!isAdmin) throw new Error("Only admins can delete referrals");

    const { data: row } = await supabase
      .from("referrals")
      .select("*")
      .eq("id", data.id)
      .maybeSingle();

    const { error } = await supabase
      .from("referrals")
      .update({ deleted_at: new Date().toISOString(), deleted_by: userId } as any)
      .eq("id", data.id)
      .is("deleted_at", null);
    if (error) throw new Error(error.message);


    await supabase.from("audit_log").insert({
      user_id: userId,
      action: "delete",
      entity: "referral",
      entity_id: data.id,
      diff: row as any,
    });
    return { ok: true };
  });

