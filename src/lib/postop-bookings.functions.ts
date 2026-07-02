import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { safeError } from "./safe-error";
// crypto helpers are loaded dynamically inside handlers via
// ./postop-bookings-crypto.server so the Node "crypto" module never lands
// in the client bundle (this file is part of the client module graph;
// only handler bodies are stripped).
type PostopCrypto = typeof import("./postop-bookings-crypto.server");
let _cryptoMod: Promise<PostopCrypto> | null = null;
function loadCrypto(): Promise<PostopCrypto> {
  if (!_cryptoMod) _cryptoMod = import("./postop-bookings-crypto.server");
  return _cryptoMod;
}

const bookingSchema = z.object({
  hospital_number: z.string().trim().max(50).nullable().optional(),
  age: z.number().int().min(0).max(130).nullable().optional(),
  sex: z.enum(["male", "female", "other", "unknown"]).nullable().optional(),
  weight_kg: z.number().positive().max(499).nullable().optional(),
  height_cm: z.number().positive().max(299).nullable().optional(),
  bmi: z.number().positive().max(199).nullable().optional(),
  proposed_procedure: z.string().trim().max(2000).nullable().optional(),
  surgical_specialty: z
    .enum([
      "orthopaedics_trauma",
      "plastics",
      "ent",
      "maxfax",
      "general",
      "urology",
      "gynaecology",
      "other",
    ])
    .nullable()
    .optional(),
  past_medical_history: z.string().trim().max(5000).nullable().optional(),
  past_surgical_history: z.string().trim().max(5000).nullable().optional(),
  social_history: z.string().trim().max(2000).nullable().optional(),
  reason_for_bed: z.string().trim().max(2000).nullable().optional(),
  predicted_level: z.enum(["level_1", "level_2", "level_3"]),
  proposed_surgery_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  arrived_at: z.string().datetime().nullable().optional(),
});

export type PostopBookingInput = z.infer<typeof bookingSchema>;

const ENC_FIELDS = [
  "proposed_procedure",
  "past_medical_history",
  "past_surgical_history",
  "social_history",
  "reason_for_bed",
] as const;

// Fields tracked in the audit trail. Encrypted free-text fields are logged
// as "[changed]" placeholders so a DB leak of audit_log cannot reveal what
// the encrypted columns hide.
const AUDITED_FIELDS = [
  "hospital_number",
  "age",
  "sex",
  "weight_kg",
  "height_cm",
  "bmi",
  "predicted_level",
  "proposed_surgery_date",
  "arrived_at",
  "surgical_specialty",
  "proposed_procedure",
  "past_medical_history",
  "past_surgical_history",
  "social_history",
  "reason_for_bed",
] as const;

const ENC_SET = new Set<string>([...ENC_FIELDS, "hospital_number"]);

async function getAdmin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

function redactValue(field: string, value: unknown): unknown {
  if (ENC_SET.has(field) && value != null && value !== "") return "[redacted]";
  return value ?? null;
}

function buildCreateDiff(input: PostopBookingInput): Record<string, unknown> {
  const diff: Record<string, unknown> = {};
  for (const k of AUDITED_FIELDS) {
    diff[k] = redactValue(k, (input as any)[k]);
  }
  return diff;
}

function buildUpdateDiff(
  before: Record<string, any>,
  after: PostopBookingInput,
): Record<string, unknown> | null {
  const changes: Record<string, unknown> = {};
  for (const k of AUDITED_FIELDS) {
    const b = before[k] ?? null;
    const a = (after as any)[k] ?? null;
    if (b === a) continue;
    changes[k] = { from: redactValue(k, b), to: redactValue(k, a) };
  }
  return Object.keys(changes).length ? changes : null;
}

async function writeAudit(entry: {
  user_id: string;
  action: string;
  entity_id: string;
  diff?: Record<string, unknown> | null;
}) {
  const admin = await getAdmin();
  await admin
    .from("audit_log")
    .insert({
      user_id: entry.user_id,
      action: entry.action as any,
      entity: "postop_booking",
      entity_id: entry.entity_id,
      diff: entry.diff ?? null,
    } as any);
}



export const createPostopBooking = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => bookingSchema.parse(d))
  .handler(async ({ data, context }) => {
    try {
      const { encryptPayload } = await loadCrypto();
      const payload = encryptPayload(data);
      const { data: row, error } = await context.supabase
        .from("postop_bookings")
        .insert({ ...payload, created_by: context.userId } as any)
        .select("id")
        .single();
      if (error) throw error;
      await writeAudit({
        user_id: context.userId,
        action: "create",
        entity_id: row.id as string,
        diff: buildCreateDiff(data),
      });
      return { id: row.id as string };
    } catch (err) {
      throw safeError("createPostopBooking", err, "Could not save post-op booking");
    }
  });

export const listPostopBookings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { includeDeleted?: boolean } | undefined) =>
    z.object({ includeDeleted: z.boolean().optional() }).parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    try {
      let includeDeleted = false;
      if (data.includeDeleted) {
        const { data: isAdmin } = await context.supabase.rpc("has_role", {
          _user_id: context.userId,
          _role: "admin",
        });
        if (!isAdmin) {
          throw safeError(
            "listPostopBookings",
            new Error("forbidden"),
            "Only admins can view deleted bookings",
          );
        }
        includeDeleted = true;
      }
      let query = context.supabase
        .from("postop_bookings")
        .select("*")
        .order("proposed_surgery_date", { ascending: true, nullsFirst: false })
        .order("created_at", { ascending: false })
        .limit(500);
      if (!includeDeleted) query = query.is("deleted_at", null);
      const { data: rows, error } = await query;
      if (error) throw error;
      const { decryptRow } = await loadCrypto();
      return (rows ?? []).map(decryptRow);
    } catch (err) {
      throw safeError("listPostopBookings", err, "Could not load post-op bookings");
    }
  });

export const getPostopBooking = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    try {
      const { data: row, error } = await context.supabase
        .from("postop_bookings")
        .select("*")
        .eq("id", data.id)
        .is("deleted_at", null)
        .maybeSingle();
      if (error) throw error;
      if (!row) throw new Error("Booking not found");
      const { decryptRow } = await loadCrypto();
      return decryptRow(row);
    } catch (err) {
      throw safeError("getPostopBooking", err, "Could not load post-op booking");
    }
  });

export const updatePostopBooking = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => bookingSchema.extend({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    try {
      const { id, ...rest } = data;
      const { data: prev } = await context.supabase
        .from("postop_bookings")
        .select("*")
        .eq("id", id)
        .is("deleted_at", null)
        .maybeSingle();
      if (!prev) throw new Error("Booking not found");
      const { decryptRow, encryptPayload } = await loadCrypto();
      const decryptedPrev = decryptRow(prev as Record<string, any>);
      const diff = buildUpdateDiff(decryptedPrev, rest);
      const payload = encryptPayload(rest);
      const { error } = await context.supabase
        .from("postop_bookings")
        .update(payload as any)
        .eq("id", id);
      if (error) throw error;
      if (diff) {
        await writeAudit({
          user_id: context.userId,
          action: "update",
          entity_id: id,
          diff,
        });
      }
      return { id };
    } catch (err) {
      throw safeError("updatePostopBooking", err, "Could not update post-op booking");
    }
  });

export type PostopSoftDeleteRow = {
  created_by: string | null;
  deleted_at: string | null;
} | null;

export type PostopSoftDeleteDecision =
  | { kind: "not_found" }
  | { kind: "already_deleted"; deleted_at: string }
  | { kind: "forbidden" }
  | { kind: "allow" };

/**
 * Pure authorization helper used by `deletePostopBooking`. A booking may only
 * be soft-deleted by its original creator or by an admin. Exposed so unit
 * tests can exercise every branch without a live Supabase context.
 */
export function decidePostopSoftDelete(
  row: PostopSoftDeleteRow,
  userId: string,
  isAdmin: boolean,
): PostopSoftDeleteDecision {
  if (!row) return { kind: "not_found" };
  if (row.deleted_at) return { kind: "already_deleted", deleted_at: row.deleted_at };
  if (row.created_by !== userId && !isAdmin) return { kind: "forbidden" };
  return { kind: "allow" };
}

export const deletePostopBooking = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    try {
      const { data: existing, error: fetchErr } = await context.supabase
        .from("postop_bookings")
        .select("id, created_by, deleted_at")
        .eq("id", data.id)
        .maybeSingle();
      if (fetchErr) throw fetchErr;

      const { data: isAdmin } = await context.supabase.rpc("has_role", {
        _user_id: context.userId,
        _role: "admin",
      });

      const decision = decidePostopSoftDelete(
        existing as PostopSoftDeleteRow,
        context.userId,
        !!isAdmin,
      );
      if (decision.kind === "not_found") throw new Error("Booking not found");
      if (decision.kind === "already_deleted") {
        return { id: data.id, deleted_at: decision.deleted_at };
      }
      if (decision.kind === "forbidden") {
        throw safeError(
          "deletePostopBooking",
          new Error("forbidden"),
          "Only the creator or an admin can delete this booking",
        );
      }

      const deletedAt = new Date().toISOString();
      const { error } = await context.supabase
        .from("postop_bookings")
        .update({ deleted_at: deletedAt, deleted_by: context.userId } as any)
        .eq("id", data.id);
      if (error) throw error;
      await writeAudit({
        user_id: context.userId,
        action: "delete",
        entity_id: data.id,
        diff: { deleted_at: deletedAt, deleted_by: context.userId },
      });
      return { id: data.id, deleted_at: deletedAt };

    } catch (err) {
      throw safeError("deletePostopBooking", err, "Could not delete post-op booking");
    }
  });




export const restorePostopBooking = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    try {
      const { data: existing, error: fetchErr } = await context.supabase
        .from("postop_bookings")
        .select("id, created_by, deleted_at")
        .eq("id", data.id)
        .maybeSingle();
      if (fetchErr) throw fetchErr;
      if (!existing) throw new Error("Booking not found");
      if (!existing.deleted_at) return { id: data.id };

      const { error } = await context.supabase
        .from("postop_bookings")
        .update({ deleted_at: null, deleted_by: null } as any)
        .eq("id", data.id);
      if (error) throw error;
      await writeAudit({
        user_id: context.userId,
        action: "restore",
        entity_id: data.id,
        diff: { restored_at: new Date().toISOString() },
      });
      return { id: data.id };
    } catch (err) {
      throw safeError("restorePostopBooking", err, "Could not restore post-op booking");
    }
  });


export type AuditValue = string | number | boolean | null;

export type PostopAuditEntry = {
  id: string;
  action: string;
  created_at: string;
  user_id: string | null;
  user_name: string;
  changes: Array<{ field: string; from: AuditValue; to: AuditValue }>;
  snapshot?: Record<string, AuditValue>;
};

export const getPostopBookingHistory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }): Promise<PostopAuditEntry[]> => {
    try {
      // Verify booking is visible to the caller under RLS.
      const { data: row } = await context.supabase
        .from("postop_bookings")
        .select("id")
        .eq("id", data.id)
        .maybeSingle();
      if (!row) throw new Error("Booking not found");

      const admin = await getAdmin();
      const { data: rows, error } = await admin
        .from("audit_log")
        .select("id, user_id, action, diff, created_at")
        .eq("entity", "postop_booking")
        .eq("entity_id", data.id)
        .order("created_at", { ascending: false });
      if (error) throw error;

      const norm = (v: unknown): AuditValue => {
        if (v === null || v === undefined) return null;
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
        return JSON.stringify(v);
      };

      const entries: PostopAuditEntry[] = (rows ?? []).map((r: any) => {
        const diff = (r.diff ?? {}) as Record<string, any>;
        const entry: PostopAuditEntry = {
          id: r.id,
          action: r.action,
          created_at: r.created_at,
          user_id: r.user_id,
          user_name: "Clinician",
          changes: [],
        };
        if (r.action === "create") {
          const snap: Record<string, AuditValue> = {};
          for (const [k, v] of Object.entries(diff)) snap[k] = norm(v);
          entry.snapshot = snap;
        } else if (r.action === "update") {
          for (const [field, change] of Object.entries(diff)) {
            if (change && typeof change === "object" && "from" in (change as any)) {
              entry.changes.push({
                field,
                from: norm((change as any).from),
                to: norm((change as any).to),
              });
            }
          }
        }
        return entry;
      });

      const userIds = Array.from(
        new Set(entries.map((e) => e.user_id).filter(Boolean) as string[]),
      );
      if (userIds.length) {
        const { data: profs } = await admin
          .from("profiles")
          .select("id, full_name")
          .in("id", userIds);
        const names: Record<string, string> = {};
        profs?.forEach((p: any) => {
          names[p.id] = p.full_name ?? "Clinician";
        });
        for (const e of entries) {
          e.user_name = e.user_id ? names[e.user_id] ?? "Clinician" : "System";
        }
      }

      return entries;
    } catch (err) {
      throw safeError("getPostopBookingHistory", err, "Could not load booking history");
    }
  });
