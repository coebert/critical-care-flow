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
  // Flags a booking entered for testing/demonstration only. Rows with
  // is_test=true are excluded from analytics dashboards.
  is_test: z.boolean().optional(),
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
  "is_test",
] as const;

const ENC_SET = new Set<string>([...ENC_FIELDS, "hospital_number"]);

import { getAdmin } from "./server-utils";

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
      // Bounded list; realtime-refreshed. See referrals.listReferralsForList
      // for the rationale on why this stays as a hard cap rather than a
      // paginated feed. Warn if we ever hit the cap so we know to revisit.
      const POSTOP_LIST_HARD_CAP = 500;
      let query = context.supabase
        .from("postop_bookings")
        .select("*")
        .order("proposed_surgery_date", { ascending: true, nullsFirst: false })
        .order("created_at", { ascending: false })
        .limit(POSTOP_LIST_HARD_CAP);
      if (!includeDeleted) query = query.is("deleted_at", null);
      const { data: rows, error } = await query;
      if (error) throw error;
      if ((rows?.length ?? 0) >= POSTOP_LIST_HARD_CAP) {
        console.warn(
          `[postop.list] hit hard cap of ${POSTOP_LIST_HARD_CAP} rows — results are truncated.`,
        );
      }
      const { decryptRow } = await loadCrypto();
      const decrypted = ((rows ?? []) as Array<Record<string, any>>).map(decryptRow) as Array<Record<string, any>>;

      // Attach creator display names so the list can show who made each booking.
      const creatorIds = Array.from(
        new Set(decrypted.map((r) => r.created_by).filter(Boolean) as string[]),
      );
      const nameById: Record<string, string> = {};
      if (creatorIds.length) {
        const admin = await getAdmin();
        const { data: profs } = await admin
          .from("profiles")
          .select("id, full_name")
          .in("id", creatorIds);
        profs?.forEach((p: any) => {
          nameById[p.id] = p.full_name ?? "Clinician";
        });
      }
      return decrypted.map((r) => ({
        ...r,
        created_by_name: r.created_by ? nameById[r.created_by] ?? "Clinician" : null,
      }));
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
        .maybeSingle();
      const { data: isAdmin } = await context.supabase.rpc("has_role", {
        _user_id: context.userId,
        _role: "admin",
      });
      const gate = decidePostopUpdate(
        prev ? { created_by: (prev as any).created_by ?? null, deleted_at: (prev as any).deleted_at ?? null } : null,
        context.userId,
        !!isAdmin,
      );
      if (gate.kind === "not_found" || gate.kind === "already_deleted") {
        throw new Error("Booking not found");
      }
      if (gate.kind === "forbidden") {
        throw new Error("Only the booking creator or an admin can update this booking");
      }
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

export type PostopUpdateRow = {
  created_by: string | null;
  deleted_at: string | null;
} | null;

export type PostopUpdateDecision =
  | { kind: "not_found" }
  | { kind: "already_deleted"; deleted_at: string }
  | { kind: "forbidden" }
  | { kind: "allow" };

/**
 * Pure authorization helper used by `updatePostopBooking`. A booking may only
 * be updated by its original creator or by an admin. Mirrors the RLS policy
 * on `postop_bookings` so the server returns a clear error instead of a
 * silent no-op update. Exposed so unit tests can exercise every branch.
 */
export function decidePostopUpdate(
  row: PostopUpdateRow,
  userId: string,
  isAdmin: boolean,
): PostopUpdateDecision {
  if (!row) return { kind: "not_found" };
  if (row.deleted_at) return { kind: "already_deleted", deleted_at: row.deleted_at };
  if (row.created_by !== userId && !isAdmin) return { kind: "forbidden" };
  return { kind: "allow" };
}

export type PostopRestoreRow = {
  created_by: string | null;
  deleted_at: string | null;
} | null;

export type PostopRestoreDecision =
  | { kind: "not_found" }
  | { kind: "not_deleted" }
  | { kind: "forbidden" }
  | { kind: "allow" };

/**
 * Pure authorization helper used by `restorePostopBooking`. A soft-deleted
 * booking may only be restored by its original creator or by an admin. This
 * mirrors the `postop_bookings_guard_soft_delete` trigger so the server can
 * return a clear error rather than surfacing a Postgres 42501. Exposed so
 * unit tests can exercise every branch without a live Supabase context.
 */
export function decidePostopRestore(
  row: PostopRestoreRow,
  userId: string,
  isAdmin: boolean,
): PostopRestoreDecision {
  if (!row) return { kind: "not_found" };
  if (!row.deleted_at) return { kind: "not_deleted" };
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

      const { data: isAdmin } = await context.supabase.rpc("has_role", {
        _user_id: context.userId,
        _role: "admin",
      });

      const decision = decidePostopRestore(
        existing as PostopRestoreRow,
        context.userId,
        !!isAdmin,
      );
      if (decision.kind === "not_found") throw new Error("Booking not found");
      if (decision.kind === "not_deleted") return { id: data.id };
      if (decision.kind === "forbidden") {
        throw safeError(
          "restorePostopBooking",
          new Error("forbidden"),
          "Only the creator or an admin can restore this booking",
        );
      }

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

// ---------------------------------------------------------------------------
// Point-4: lifecycle, planner, cancellations, convert-to-referral
// ---------------------------------------------------------------------------

import {
  POSTOP_BOOKING_STATUSES,
  POSTOP_CANCELLATION_REASONS,
  canTransition,
  isEligibleForConversion,
  type PostopBookingStatus,
} from "./postop-lifecycle";

const statusSchema = z.enum(POSTOP_BOOKING_STATUSES);
const reasonSchema = z.enum(POSTOP_CANCELLATION_REASONS);

/** Transition a booking's status through the workflow. */
export const transitionBookingStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        id: z.string().uuid(),
        next_status: statusSchema,
        cancellation_reason: reasonSchema.nullable().optional(),
        cancellation_notes: z.string().trim().max(1000).nullable().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    try {
      const { data: prev, error: readErr } = await context.supabase
        .from("postop_bookings")
        .select(
          "id, created_by, deleted_at, booking_status, preop_signed_off_at, intensivist_reviewed_at",
        )
        .eq("id", data.id)
        .maybeSingle();
      if (readErr) throw readErr;
      if (!prev || (prev as any).deleted_at) throw new Error("Booking not found");

      const { data: isAdmin } = await context.supabase.rpc("has_role", {
        _user_id: context.userId,
        _role: "admin",
      });
      if ((prev as any).created_by !== context.userId && !isAdmin) {
        throw new Error("Only the booking creator or an admin can change status");
      }

      const decision = canTransition(
        (prev as any).booking_status as PostopBookingStatus,
        data.next_status,
        {
          preop_signed_off_at: (prev as any).preop_signed_off_at ?? null,
          intensivist_reviewed_at: (prev as any).intensivist_reviewed_at ?? null,
          cancellation_reason: data.cancellation_reason ?? null,
        },
      );
      if (!decision.ok) throw new Error(decision.reason);

      const patch: Record<string, unknown> = { booking_status: data.next_status };
      if (data.next_status === "cancelled") {
        patch.cancellation_reason = data.cancellation_reason ?? null;
        patch.cancellation_notes = data.cancellation_notes ?? null;
        patch.cancelled_at = new Date().toISOString();
        patch.cancelled_by = context.userId;
      }

      const { error } = await context.supabase
        .from("postop_bookings")
        .update(patch as any)
        .eq("id", data.id);
      if (error) throw error;

      await writeAudit({
        user_id: context.userId,
        action: "update",
        entity_id: data.id,
        diff: {
          booking_status: {
            from: (prev as any).booking_status,
            to: data.next_status,
          },
          ...(data.next_status === "cancelled"
            ? { cancellation_reason: { from: null, to: data.cancellation_reason ?? null } }
            : {}),
        },
      });
      return { id: data.id, booking_status: data.next_status };
    } catch (err) {
      throw safeError("transitionBookingStatus", err, "Could not change booking status");
    }
  });

/** Record anaesthetic pre-op sign-off and/or intensivist review. */
export const signOffBooking = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        id: z.string().uuid(),
        kind: z.enum(["preop", "intensivist"]),
        clear: z.boolean().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    try {
      const stamp = data.clear ? null : new Date().toISOString();
      const by = data.clear ? null : context.userId;
      const patch =
        data.kind === "preop"
          ? { preop_signed_off_at: stamp, preop_signed_off_by: by }
          : { intensivist_reviewed_at: stamp, intensivist_reviewed_by: by };
      const { error } = await context.supabase
        .from("postop_bookings")
        .update(patch as any)
        .eq("id", data.id);
      if (error) throw error;
      await writeAudit({
        user_id: context.userId,
        action: "update",
        entity_id: data.id,
        diff: patch as Record<string, unknown>,
      });
      return { id: data.id };
    } catch (err) {
      throw safeError("signOffBooking", err, "Could not record sign-off");
    }
  });

/** Planner query — bookings whose surgery date is within [from, to] inclusive. */
export const listBookingsInRange = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    try {
      const { data: rows, error } = await context.supabase
        .from("postop_bookings")
        .select("*")
        .gte("proposed_surgery_date", data.from)
        .lte("proposed_surgery_date", data.to)
        .is("deleted_at", null)
        .order("proposed_surgery_date", { ascending: true })
        .limit(500);
      if (error) throw error;
      const { decryptRow } = await loadCrypto();
      return ((rows ?? []) as Array<Record<string, any>>).map(decryptRow);
    } catch (err) {
      throw safeError("listBookingsInRange", err, "Could not load planner data");
    }
  });

/** Admin-only cancellation register. */
export const listCancellations = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        reason: reasonSchema.optional(),
      })
      .parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    try {
      const { data: isAdmin } = await context.supabase.rpc("has_role", {
        _user_id: context.userId,
        _role: "admin",
      });
      if (!isAdmin) throw new Error("Admin access required");

      let q = context.supabase
        .from("postop_bookings")
        .select("*")
        .eq("booking_status", "cancelled")
        .is("deleted_at", null)
        .order("cancelled_at", { ascending: false })
        .limit(1000);
      if (data.from) q = q.gte("cancelled_at", `${data.from}T00:00:00`);
      if (data.to) q = q.lte("cancelled_at", `${data.to}T23:59:59`);
      if (data.reason) q = q.eq("cancellation_reason", data.reason);
      const { data: rows, error } = await q;
      if (error) throw error;
      const { decryptRow } = await loadCrypto();
      const decrypted = ((rows ?? []) as Array<Record<string, any>>).map(decryptRow);

      // Attach canceller display name.
      const admin = await getAdmin();
      const ids = Array.from(
        new Set(
          decrypted
            .map((r) => r.cancelled_by ?? r.created_by)
            .filter(Boolean) as string[],
        ),
      );
      const nameById: Record<string, string> = {};
      if (ids.length) {
        const { data: profs } = await admin
          .from("profiles")
          .select("id, full_name")
          .in("id", ids);
        profs?.forEach((p: any) => {
          nameById[p.id] = p.full_name ?? "Clinician";
        });
      }
      return decrypted.map((r) => ({
        ...r,
        cancelled_by_name: r.cancelled_by ? nameById[r.cancelled_by] ?? "Clinician" : null,
      }));
    } catch (err) {
      throw safeError("listCancellations", err, "Could not load cancellations");
    }
  });

/** Convert a same-day post-op booking into a live referral (idempotent). */
export const convertBookingToReferral = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    try {
      const { data: rawRow, error: readErr } = await context.supabase
        .from("postop_bookings")
        .select("*")
        .eq("id", data.id)
        .maybeSingle();
      if (readErr) throw readErr;
      if (!rawRow) throw new Error("Booking not found");

      const { decryptRow } = await loadCrypto();
      const row = decryptRow(rawRow as Record<string, any>) as Record<string, any>;

      if (row.converted_referral_id) {
        return { referral_id: row.converted_referral_id as string, reused: true };
      }
      if (
        !isEligibleForConversion({
          booking_status: row.booking_status,
          proposed_surgery_date: row.proposed_surgery_date,
          converted_referral_id: row.converted_referral_id,
          deleted_at: row.deleted_at,
        })
      ) {
        throw new Error(
          "This booking is not yet eligible for conversion — needs to be confirmed and on/near the surgery date.",
        );
      }

      const { encryptString, hashHospitalNumber } = await import("./crypto.server");

      const reasonNotesPlain = row.proposed_procedure
        ? `Post-op admission after: ${row.proposed_procedure}`
        : "Post-op admission";

      const insert: Record<string, unknown> = {
        created_by: context.userId,
        age: row.age ?? null,
        sex: row.sex ?? null,
        weight_kg: row.weight_kg ?? null,
        status: "accepted",
        outcome: "admit_for_admission",
        reason_category: "post_op",
        origin_booking_id: row.id,
        referral_received_at: new Date().toISOString(),
        decision_at: new Date().toISOString(),
      };
      if (row.hospital_number) {
        insert.hospital_number_enc = encryptString(row.hospital_number);
        insert.hospital_number_hash = hashHospitalNumber(row.hospital_number);
      }
      if (reasonNotesPlain) {
        insert.reason_for_referral_enc = encryptString(reasonNotesPlain);
      }

      const { data: newRef, error: insErr } = await context.supabase
        .from("referrals")
        .insert(insert as any)
        .select("id")
        .single();
      if (insErr) throw insErr;

      // Link back + move the booking to admitted.
      const { error: updErr } = await context.supabase
        .from("postop_bookings")
        .update({
          converted_referral_id: (newRef as any).id,
          booking_status: "admitted",
          arrived_at: new Date().toISOString(),
        } as any)
        .eq("id", data.id);
      if (updErr) throw updErr;

      await writeAudit({
        user_id: context.userId,
        action: "update",
        entity_id: data.id,
        diff: {
          converted_referral_id: { from: null, to: (newRef as any).id },
          booking_status: { from: row.booking_status, to: "admitted" },
        },
      });

      return { referral_id: (newRef as any).id as string, reused: false };
    } catch (err) {
      throw safeError("convertBookingToReferral", err, "Could not convert booking");
    }
  });
