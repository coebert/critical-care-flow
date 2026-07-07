import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { safeError } from "./safe-error";

const roleEnum = z.enum(["admin", "clinician"]);
const statusEnum = z.enum(["open", "done", "cancelled"]);

const createSchema = z.object({
  referral_id: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  details: z.string().trim().max(2000).nullable().optional(),
  assigned_role: roleEnum.nullable().optional(),
  due_at: z.string().datetime().nullable().optional(),
});

const patchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  details: z.string().trim().max(2000).nullable().optional(),
  assigned_role: roleEnum.nullable().optional(),
  due_at: z.string().datetime().nullable().optional(),
  status: statusEnum.optional(),
});

const updateSchema = z.object({
  id: z.string().uuid(),
  patch: patchSchema,
});

export const listTasks = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ referral_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("referral_tasks")
      .select("*")
      .eq("referral_id", data.referral_id)
      .order("created_at", { ascending: true });
    if (error) throw safeError("tasks", error, "Could not load tasks");
    return rows ?? [];
  });

export const createTask = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => createSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("referral_tasks")
      .insert({
        referral_id: data.referral_id,
        title: data.title,
        details: data.details ?? null,
        assigned_role: data.assigned_role ?? null,
        due_at: data.due_at ?? null,
        created_by: context.userId,
      })
      .select("*")
      .single();
    if (error) throw safeError("tasks", error, "Could not create task");
    return row;
  });

export const updateTask = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => updateSchema.parse(d))
  .handler(async ({ data, context }) => {
    const patch: Record<string, unknown> = { ...data.patch };
    if (data.patch.status === "done") {
      patch.completed_by = context.userId;
      patch.completed_at = new Date().toISOString();
    } else if (data.patch.status === "open") {
      patch.completed_by = null;
      patch.completed_at = null;
    }
    const { data: row, error } = await context.supabase
      .from("referral_tasks")
      .update(patch)
      .eq("id", data.id)
      .select("*")
      .single();
    if (error) throw safeError("tasks", error, "Could not update task");
    return row;
  });

export const deleteTask = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("referral_tasks").delete().eq("id", data.id);
    if (error) throw safeError("tasks", error, "Could not delete task");
    return { ok: true };
  });
