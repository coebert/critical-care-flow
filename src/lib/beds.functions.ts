import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { safeError } from "./safe-error";

// ---- Schemas ----

const isolationEnum = z.enum(["none", "contact", "droplet", "airborne"]);
const stepDownEnum = z.enum(["ward", "hdu", "home", "other"]);
const transferKind = z.enum(["repat", "tertiary", "other"]);
const transportMode = z.enum(["land_ambulance", "air", "self", "other"]);
const transferStatus = z.enum([
  "requested",
  "accepted",
  "awaiting_transport",
  "in_transit",
  "completed",
  "cancelled",
]);

const occupancyFields = z.object({
  hospital_number: z.string().trim().max(50).nullable().optional(),
  patient_initials: z.string().trim().max(10).nullable().optional(),
  admitting_consultant: z.string().trim().max(120).nullable().optional(),
  admitted_at: z.string().datetime().optional(),
  level: z.number().int().min(1).max(3).optional(),
  ventilated: z.boolean().optional(),
  nippv_cpap: z.boolean().optional(),
  hfno: z.boolean().optional(),
  vasopressors: z.boolean().optional(),
  renal_replacement: z.boolean().optional(),
  tracheostomy: z.boolean().optional(),
  isolation: isolationEnum.optional(),
  isolation_reason: z.string().trim().max(500).nullable().optional(),
  requires_side_room: z.boolean().optional(),
  predicted_discharge_at: z.string().datetime().nullable().optional(),
  predicted_step_down: stepDownEnum.nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  source_referral_id: z.string().uuid().nullable().optional(),
  source_postop_booking_id: z.string().uuid().nullable().optional(),
});

const admitSchema = occupancyFields.extend({ bed_id: z.string().uuid() });
const updateOccupancySchema = occupancyFields.extend({ id: z.string().uuid() });
const dischargeSchema = z.object({
  id: z.string().uuid(),
  discharged_at: z.string().datetime().optional(),
  actual_step_down: stepDownEnum.nullable().optional(),
});
const moveSchema = z.object({ id: z.string().uuid(), new_bed_id: z.string().uuid() });

const outlierFields = z.object({
  hospital_number: z.string().trim().max(50).nullable().optional(),
  patient_initials: z.string().trim().max(10).nullable().optional(),
  ward: z.string().trim().min(1).max(120),
  admitting_consultant: z.string().trim().max(120).nullable().optional(),
  started_at: z.string().datetime().optional(),
  level: z.number().int().min(1).max(3).optional(),
  ventilated: z.boolean().optional(),
  nippv_cpap: z.boolean().optional(),
  hfno: z.boolean().optional(),
  vasopressors: z.boolean().optional(),
  renal_replacement: z.boolean().optional(),
  reason: z.string().trim().max(500).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});
const updateOutlierSchema = outlierFields.partial().extend({ id: z.string().uuid() });
const endOutlierSchema = z.object({ id: z.string().uuid(), ended_at: z.string().datetime().optional() });

const transferFields = z.object({
  occupancy_id: z.string().uuid().nullable().optional(),
  kind: transferKind.optional(),
  destination_hospital: z.string().trim().min(1).max(160),
  destination_specialty: z.string().trim().max(120).nullable().optional(),
  reason: z.string().trim().max(500).nullable().optional(),
  transport_mode: transportMode.nullable().optional(),
  status: transferStatus.optional(),
  eta_at: z.string().datetime().nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});
const updateTransferSchema = transferFields.partial().extend({
  id: z.string().uuid(),
  accepted_at: z.string().datetime().nullable().optional(),
  departed_at: z.string().datetime().nullable().optional(),
  completed_at: z.string().datetime().nullable().optional(),
});
const cancelTransferSchema = z.object({
  id: z.string().uuid(),
  cancel_reason: z.string().trim().max(500).nullable().optional(),
});

// ---- Server functions ----

export const listBeds = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("beds")
      .select("*")
      .eq("active", true)
      .order("sort_order", { ascending: true });
    if (error) throw safeError("beds", error, "Could not load beds");
    return data ?? [];
  });

export const getBedBoard = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const [bedsRes, occRes, outRes, xferRes] = await Promise.all([
      context.supabase
        .from("beds")
        .select("*")
        .eq("active", true)
        .order("sort_order", { ascending: true }),
      context.supabase.from("bed_occupancies").select("*").is("discharged_at", null),
      context.supabase.from("bed_outliers").select("*").is("deleted_at", null).is("ended_at", null),
      context.supabase
        .from("bed_transfers_out")
        .select("*")
        .is("deleted_at", null)
        .not("status", "in", "(completed,cancelled)"),
    ]);
    if (bedsRes.error) throw safeError("beds", bedsRes.error, "Could not load beds");
    if (occRes.error) throw safeError("beds", occRes.error, "Could not load occupancies");
    if (outRes.error) throw safeError("beds", outRes.error, "Could not load outliers");
    if (xferRes.error) throw safeError("beds", xferRes.error, "Could not load transfers");
    return {
      beds: bedsRes.data ?? [],
      occupancies: occRes.data ?? [],
      outliers: outRes.data ?? [],
      transfers: xferRes.data ?? [],
    };
  });

export const admitToBed = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => admitSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("bed_occupancies")
      .insert({ ...data, created_by: context.userId, updated_by: context.userId })
      .select("*")
      .single();
    if (error) throw safeError("beds", error, "Could not admit patient (bed may already be occupied)");
    return row;
  });

export const updateOccupancy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => updateOccupancySchema.parse(d))
  .handler(async ({ data, context }) => {
    const { id, ...patch } = data;
    const { data: row, error } = await context.supabase
      .from("bed_occupancies")
      .update({ ...patch, updated_by: context.userId })
      .eq("id", id)
      .select("*")
      .single();
    if (error) throw safeError("beds", error, "Could not update occupancy");
    return row;
  });

export const dischargeOccupancy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => dischargeSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("bed_occupancies")
      .update({
        discharged_at: data.discharged_at ?? new Date().toISOString(),
        actual_step_down: data.actual_step_down ?? null,
        updated_by: context.userId,
      })
      .eq("id", data.id)
      .select("*")
      .single();
    if (error) throw safeError("beds", error, "Could not discharge patient");
    return row;
  });

export const moveOccupancy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => moveSchema.parse(d))
  .handler(async ({ data, context }) => {
    // Simple move: repoint bed_id. The partial unique index enforces that
    // the target bed is currently free.
    const { data: row, error } = await context.supabase
      .from("bed_occupancies")
      .update({ bed_id: data.new_bed_id, updated_by: context.userId })
      .eq("id", data.id)
      .is("discharged_at", null)
      .select("*")
      .single();
    if (error) throw safeError("beds", error, "Could not move patient (target bed may be occupied)");
    return row;
  });

export const createOutlier = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => outlierFields.parse(d))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("bed_outliers")
      .insert({ ...data, created_by: context.userId, updated_by: context.userId })
      .select("*")
      .single();
    if (error) throw safeError("beds", error, "Could not add outlier");
    return row;
  });

export const updateOutlier = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => updateOutlierSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { id, ...patch } = data;
    const { data: row, error } = await context.supabase
      .from("bed_outliers")
      .update({ ...patch, updated_by: context.userId })
      .eq("id", id)
      .select("*")
      .single();
    if (error) throw safeError("beds", error, "Could not update outlier");
    return row;
  });

export const endOutlier = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => endOutlierSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("bed_outliers")
      .update({ ended_at: data.ended_at ?? new Date().toISOString(), updated_by: context.userId })
      .eq("id", data.id)
      .select("*")
      .single();
    if (error) throw safeError("beds", error, "Could not end outlier");
    return row;
  });

export const createTransferOut = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => transferFields.parse(d))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("bed_transfers_out")
      .insert({ ...data, created_by: context.userId, updated_by: context.userId })
      .select("*")
      .single();
    if (error) throw safeError("beds", error, "Could not create transfer");
    return row;
  });

export const updateTransferOut = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => updateTransferSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { id, ...patch } = data;
    const completed_at =
      patch.status === "completed" && !patch.completed_at
        ? new Date().toISOString()
        : patch.completed_at;
    const { data: row, error } = await context.supabase
      .from("bed_transfers_out")
      .update({ ...patch, completed_at, updated_by: context.userId })
      .eq("id", id)
      .select("*")
      .single();
    if (error) throw safeError("beds", error, "Could not update transfer");
    return row;
  });

export const cancelTransferOut = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => cancelTransferSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("bed_transfers_out")
      .update({
        status: "cancelled",
        cancelled_at: new Date().toISOString(),
        cancel_reason: data.cancel_reason ?? null,
        updated_by: context.userId,
      })
      .eq("id", data.id)
      .select("*")
      .single();
    if (error) throw safeError("beds", error, "Could not cancel transfer");
    return row;
  });

export type BedRow = Awaited<ReturnType<typeof listBeds>>[number];
export type BedBoardData = Awaited<ReturnType<typeof getBedBoard>>;
