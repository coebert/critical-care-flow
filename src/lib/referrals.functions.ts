import { createServerFn } from "@tanstack/react-start";
import { safeError } from "./safe-error";
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
  admission_urgency: z
    .enum(["within_15_min", "within_30_min", "within_1_hour", "within_1_2_hours", "not_admitting"])
    .nullable()
    .optional(),
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
  url?: string,
) {
  const admin = await getAdmin();
  const { fanOutNotifications: runFanOut } = await import("./notification-fanout");
  await runFanOut(
    {
      fetchEligibleRoles: async (actorId) => {
        const { data } = await admin
          .from("user_roles")
          .select("user_id, role")
          .in("role", ["admin", "clinician"])
          .neq("user_id", actorId);
        return (data ?? []) as any;
      },
      fetchAtWorkProfiles: async (ids) => {
        const { data } = await admin
          .from("profiles")
          .select("id, is_at_work")
          .in("id", ids)
          .eq("is_at_work", true);
        return (data ?? []) as any;
      },
      fetchPushSubs: async (ids) => {
        const { data } = await admin
          .from("push_subscriptions")
          .select("user_id, endpoint, p256dh, auth")
          .in("user_id", ids);
        return (data ?? []) as any;
      },
      insertNotifications: async (rows) => {
        await admin.from("notifications").insert(rows as any);
      },
      sendPush: async (subs, payload) => {
        const { sendPushToMany } = await import("./push.server");
        return sendPushToMany(subs as any, payload);
      },
      deletePushSubs: async (endpoints) => {
        await admin.from("push_subscriptions").delete().in("endpoint", endpoints);
      },
    },
    { actorId: userId, referralId, kind, message, url },
  );
}


export const createReferral = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => refSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    if (data.status === "declined" && !(data.decline_reason ?? "").trim()) {
      throw new Error("A reason is required when declining a referral.");
    }
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
    if (error) throw safeError("referrals.create", error, "Failed to create referral.");

    await writeAudit({
      user_id: userId,
      action: "create",
      entity: "referral",
      entity_id: row.id,
      diff: row as any,
    });

    const summary = `${row.referring_specialty ?? "Referral"} — ${row.current_ward ?? "ward unknown"}`;
    await fanOutNotifications(userId, row.id, "new", `New referral: ${summary}`);

    // If this patient has a prior DECLINED referral on record, flag it loudly.
    if (row.hospital_number) {
      const admin = await getAdmin();
      const { data: priorDeclined } = await admin
        .from("referrals")
        .select("id, decision_at, referral_received_at, decline_reason")
        .eq("hospital_number", row.hospital_number)
        .eq("status", "declined")
        .is("deleted_at", null)
        .neq("id", row.id)
        .order("referral_received_at", { ascending: false })
        .limit(1);
      if (priorDeclined && priorDeclined.length > 0) {
        const prev = priorDeclined[0];
        const when = prev.decision_at ?? prev.referral_received_at;
        const whenStr = when ? new Date(when).toLocaleDateString("en-GB") : "previously";
        const reasonRaw = (prev.decline_reason ?? "").trim();
        const reason = reasonRaw.length > 200 ? `${reasonRaw.slice(0, 197)}…` : reasonRaw;
        const reasonStr = reason ? ` Reason: ${reason}` : " Reason not recorded.";
        await fanOutNotifications(
          userId,
          row.id,
          "updated",
          `⚠️ Patient has a previously DECLINED critical care referral (${whenStr}).${reasonStr} — ${summary}`,
          `/referrals/${prev.id}?highlight=declined`,
        );
      }

    }
    return row;
  });



export const updateReferral = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ id: z.string().uuid(), patch: refSchema }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    // Read prior status to decide whether to notify on status change.
    const { data: prior } = await supabase
      .from("referrals")
      .select("status")
      .eq("id", data.id)
      .maybeSingle();

    const { data: row, error } = await supabase
      .from("referrals")
      .update({ ...data.patch, updated_by: userId } as any)
      .eq("id", data.id)
      .select()
      .single();
    if (error) throw safeError("referrals.update", error, "Failed to update referral.");

    await writeAudit({
      user_id: userId,
      action: "update",
      entity: "referral",
      entity_id: row.id,
      diff: data.patch as any,
    });

    const statusChanged =
      data.patch.status !== undefined && prior?.status !== row.status;
    if (statusChanged) {
      const summary = `${row.referring_specialty ?? "Referral"} — ${row.current_ward ?? "ward unknown"}`;
      await fanOutNotifications(
        userId,
        row.id,
        "updated",
        `Status changed to ${row.status}: ${summary}`,
      );
    }
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
    if (error) throw safeError("referrals.addNote", error, "Failed to add note.");

    await writeAudit({
      user_id: userId,
      action: "create",
      entity: "referral_note",
      entity_id: row.id,
      diff: { referral_id: data.referral_id, body: data.body },
    });

    await fanOutNotifications(
      userId,
      data.referral_id,
      "updated",
      `New note added to referral`,
    );
    return row;
  });


export const updateNote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({ id: z.string().uuid(), body: z.string().trim().min(1).max(2000) })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: existing } = await supabase
      .from("referral_notes")
      .select("id, body, referral_id, author_id")
      .eq("id", data.id)
      .maybeSingle();
    if (!existing) throw new Error("Note not found");

    const { data: row, error } = await supabase
      .from("referral_notes")
      .update({ body: data.body, edited_at: new Date().toISOString() } as any)
      .eq("id", data.id)
      .select()
      .single();
    if (error) throw safeError("referrals.updateNote", error, "Failed to update note.");

    await writeAudit({
      user_id: userId,
      action: "update",
      entity: "referral_note",
      entity_id: row.id,
      diff: {
        referral_id: existing.referral_id,
        before: { body: existing.body },
        after: { body: data.body },
      },
    });
    return row;
  });


export const deleteNote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: existing } = await supabase
      .from("referral_notes")
      .select("id, body, referral_id, author_id, created_at")
      .eq("id", data.id)
      .maybeSingle();
    if (!existing) throw new Error("Note not found");

    const { error } = await supabase.from("referral_notes").delete().eq("id", data.id);
    if (error) throw safeError("referrals.deleteNote", error, "Failed to delete note.");

    await writeAudit({
      user_id: userId,
      action: "delete",
      entity: "referral_note",
      entity_id: data.id,
      diff: existing as any,
    });
    return { ok: true };
  });


export const getNoteHistory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ note_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: access } = await supabase.rpc("has_clinical_access", { _user_id: userId });
    if (!access) throw new Error("Forbidden");

    const admin = await getAdmin();
    const { data: rows, error } = await admin
      .from("audit_log")
      .select("id, user_id, action, diff, created_at")
      .eq("entity", "referral_note")
      .eq("entity_id", data.note_id)
      .order("created_at", { ascending: false });
    if (error) throw safeError("referrals.getNoteHistory", error, "Failed to load note history.");

    const userIds = Array.from(new Set((rows ?? []).map((r: any) => r.user_id).filter(Boolean)));
    let names: Record<string, string> = {};
    if (userIds.length) {
      const { data: profs } = await admin
        .from("profiles")
        .select("id, full_name")
        .in("id", userIds as string[]);
      profs?.forEach((p: any) => { names[p.id] = p.full_name ?? "Clinician"; });
    }
    return (rows ?? []).map((r: any) => ({
      id: r.id,
      action: r.action,
      created_at: r.created_at,
      user_id: r.user_id,
      user_name: names[r.user_id] ?? "Clinician",
      diff: r.diff,
    }));
  });


// Fields shown in the referral audit trail. Other columns (created_by,
// updated_by, deleted_*) are bookkeeping and excluded from the diff view.
const AUDITED_REFERRAL_FIELDS = [
  "age", "sex", "hospital_number", "current_ward", "current_bed",
  "past_medical_history", "baseline_function", "dnacpr_respect",
  "referring_specialty", "reason_for_referral",
  "referral_received_at", "first_seen_at", "decision_at", "arrived_on_unit_at",
  "status", "decline_reason",
] as const;

export type AuditValue = string | number | boolean | null;

export type ReferralAuditEntry = {
  id: string;
  action: string;
  created_at: string;
  user_id: string | null;
  user_name: string;
  changes: { field: string; from: AuditValue; to: AuditValue }[];
  // For "create": initial snapshot of the audited fields.
  snapshot?: Record<string, AuditValue>;
};

export type ReferralAuditPage = {
  entries: ReferralAuditEntry[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
};

const HISTORY_PAGE_MAX = 100;

export const getReferralHistory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        referral_id: z.string().uuid(),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(HISTORY_PAGE_MAX).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }): Promise<ReferralAuditPage> => {
    const { supabase, userId } = context;
    const offset = data.offset ?? 0;
    const limit = data.limit ?? 20;

    const { data: access } = await supabase.rpc("has_clinical_access", { _user_id: userId });
    if (!access) throw new Error("Forbidden");

    // Confirm the caller can see the referral via RLS before exposing history.
    const { data: ref } = await supabase
      .from("referrals")
      .select("id")
      .eq("id", data.referral_id)
      .maybeSingle();
    if (!ref) throw new Error("Referral not found");

    const admin = await getAdmin();
    // We must walk all rows chronologically to reconstruct from->to diffs,
    // then slice for pagination. The audit_log is indexed by entity/entity_id
    // and rows are small, so this stays cheap per referral.
    const { data: rows, error } = await admin
      .from("audit_log")
      .select("id, user_id, action, diff, created_at")
      .eq("entity", "referral")
      .eq("entity_id", data.referral_id)
      .in("action", ["create", "update", "delete"])
      .order("created_at", { ascending: true });
    if (error) throw safeError("referrals.getReferralHistory", error, "Failed to load referral history.");

    // Normalize a JSONB value to a simple scalar suitable for display.
    const norm = (v: unknown): AuditValue => {
      if (v === null || v === undefined) return null;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
      return JSON.stringify(v);
    };

    // Track previous values so each update entry can be shown as
    // before -> after for the fields that actually changed.
    const prev: Record<string, AuditValue> = {};
    const built: ReferralAuditEntry[] = [];

    for (const r of rows ?? []) {
      const diff = (r.diff ?? {}) as Record<string, unknown>;
      const base: ReferralAuditEntry = {
        id: r.id,
        action: r.action,
        created_at: r.created_at,
        user_id: r.user_id,
        user_name: "Clinician", // filled in after slicing
        changes: [],
      };

      if (r.action === "create") {
        const snap: Record<string, AuditValue> = {};
        for (const k of AUDITED_REFERRAL_FIELDS) {
          const v = norm(diff[k]);
          snap[k] = v;
          prev[k] = v;
        }
        base.snapshot = snap;
      } else if (r.action === "update") {
        for (const k of AUDITED_REFERRAL_FIELDS) {
          if (k in diff) {
            const to = norm(diff[k]);
            const from = prev[k] ?? null;
            if (from !== to) {
              base.changes.push({ field: k, from, to });
              prev[k] = to;
            }
          }
        }
        // Skip update rows that didn't touch any audited field.
        if (base.changes.length === 0) continue;
      }
      // "delete" actions are recorded as-is with no changes list.

      built.push(base);
    }

    // Newest first for display, then slice the requested window.
    built.reverse();
    const total = built.length;
    const page = built.slice(offset, offset + limit);

    // Only resolve profile names for the users actually shown on this page.
    const userIds = Array.from(new Set(page.map((e) => e.user_id).filter(Boolean) as string[]));
    if (userIds.length) {
      const { data: profs } = await admin
        .from("profiles")
        .select("id, full_name")
        .in("id", userIds);
      const names: Record<string, string> = {};
      profs?.forEach((p: any) => { names[p.id] = p.full_name ?? "Clinician"; });
      for (const e of page) {
        e.user_name = e.user_id ? (names[e.user_id] ?? "Clinician") : "System";
      }
    } else {
      for (const e of page) {
        if (!e.user_id) e.user_name = "System";
      }
    }

    return {
      entries: page,
      total,
      offset,
      limit,
      hasMore: offset + page.length < total,
    };
  });




export const logReferralView = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ referral_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: access } = await supabase.rpc("has_clinical_access", { _user_id: userId });
    if (!access) throw new Error("Forbidden");

    // Verify the referral exists and is readable by the caller via RLS.
    const { data: ref } = await supabase
      .from("referrals")
      .select("id")
      .eq("id", data.referral_id)
      .maybeSingle();
    if (!ref) throw new Error("Referral not found");

    await writeAudit({
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
    const { data: row } = await supabase
      .from("referrals")
      .select("*, created_by")
      .eq("id", data.id)
      .maybeSingle();

    if (!row) throw new Error("Referral not found");

    const { data: isAdmin } = await supabase.rpc("has_role", {
      _user_id: userId,
      _role: "admin",
    });
    if (row.created_by !== userId && !isAdmin) {
      throw new Error("Only the creator or an admin can delete this referral");
    }

    // Use admin client to bypass RLS, which restricts deleted_at writes to admins.
    // Authorization is enforced above in application code.
    const admin = await getAdmin();
    const { error } = await admin
      .from("referrals")
      .update({ deleted_at: new Date().toISOString(), deleted_by: userId } as any)
      .eq("id", data.id)
      .is("deleted_at", null);
    if (error) throw safeError("referrals.delete", error, "Failed to delete referral.");

    await writeAudit({
      user_id: userId,
      action: "delete",
      entity: "referral",
      entity_id: data.id,
      diff: row as any,
    });

    return { ok: true };
  });


// Window during which a soft-deleted referral can still be restored.
export const RESTORE_WINDOW_DAYS = 7;

export const listDeletedReferrals = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const cutoff = new Date(Date.now() - RESTORE_WINDOW_DAYS * 86400000).toISOString();
    const { data: isAdmin } = await supabase.rpc("has_role", {
      _user_id: userId,
      _role: "admin",
    });
    let query = supabase
      .from("referrals")
      .select("*")
      .not("deleted_at", "is", null)
      .gte("deleted_at", cutoff)
      .order("deleted_at", { ascending: false });
    if (!isAdmin) query = query.eq("created_by", userId);
    const { data, error } = await query;
    if (error) throw safeError("referrals.listDeleted", error, "Failed to load deleted referrals.");
    return data ?? [];
  });

export const restoreReferral = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: row } = await supabase
      .from("referrals")
      .select("*, created_by, deleted_at")
      .eq("id", data.id)
      .maybeSingle();
    if (!row) throw new Error("Referral not found");
    if (!row.deleted_at) throw new Error("Referral is not deleted");

    const { data: isAdmin } = await supabase.rpc("has_role", {
      _user_id: userId,
      _role: "admin",
    });
    if (row.created_by !== userId && !isAdmin) {
      throw new Error("Only the creator or an admin can restore this referral");
    }

    const cutoff = Date.now() - RESTORE_WINDOW_DAYS * 86400000;
    if (new Date(row.deleted_at).getTime() < cutoff) {
      throw new Error(`Restore window of ${RESTORE_WINDOW_DAYS} days has expired`);
    }

    const { error } = await supabase
      .from("referrals")
      .update({ deleted_at: null, deleted_by: null, updated_by: userId } as any)
      .eq("id", data.id);
    if (error) throw safeError("referrals.restore", error, "Failed to restore referral.");

    await writeAudit({
      user_id: userId,
      action: "update",
      entity: "referral",
      entity_id: data.id,
      diff: { restored: true },
    });
    return { ok: true };
  });


export const findReferralsByHospitalNumber = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        hospital_number: z.string().trim().min(1).max(50),
        exclude_id: z.string().uuid().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    let q = supabase
      .from("referrals")
      .select(
        "id, hospital_number, referral_received_at, status, referring_specialty, current_ward, current_bed, reason_for_referral, age, sex",
      )
      .eq("hospital_number", data.hospital_number)
      .is("deleted_at", null)
      .order("referral_received_at", { ascending: false })
      .limit(50);
    if (data.exclude_id) q = q.neq("id", data.exclude_id);
    const { data: rows, error } = await q;
    if (error) throw safeError("referrals.findByHospitalNumber", error, "Failed to search referrals.");
    return rows ?? [];
  });



