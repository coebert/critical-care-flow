import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { safeError } from "./safe-error";

// Fan out a push + in-app notification to every at-work user with the
// given role when a task is created or reassigned. Kept local to this
// module so we can scope the eligible-role query to just the assignee
// role instead of the broad "admin + clinician" default.
async function fanOutTaskAssignment(args: {
  actorId: string;
  referralId: string;
  taskTitle: string;
  assignedRole: "admin" | "clinician";
  action: "created" | "reassigned";
}) {
  try {
    const [
      { fanOutNotifications: runFanOut },
      { buildNotificationFanoutDeps },
      { supabaseAdmin },
    ] = await Promise.all([
      import("./notification-fanout"),
      import("./notification-fanout-deps.server"),
      import("@/integrations/supabase/client.server"),
    ]);
    const baseDeps = buildNotificationFanoutDeps(supabaseAdmin);
    const deps = {
      ...baseDeps,
      // Narrow the recipient pool to holders of the assigned role only.
      fetchEligibleRoles: async (actorId: string) => {
        const { data } = await supabaseAdmin
          .from("user_roles")
          .select("user_id, role")
          .eq("role", args.assignedRole)
          .neq("user_id", actorId);
        return (data ?? []) as { user_id: string; role: string }[];
      },
    };
    const roleLabel = args.assignedRole === "admin" ? "admins" : "clinicians";
    const verb = args.action === "created" ? "assigned" : "reassigned";
    await runFanOut(deps, {
      actorId: args.actorId,
      referralId: args.referralId,
      kind: "task",
      message: `Task ${verb} to ${roleLabel}: ${args.taskTitle}`,
      title: "Referral task",
      url: `/referrals/${args.referralId}`,
    });
  } catch (err) {
    // Push is best-effort — never fail the task write because of it.
    console.error("[referral-tasks] fanOutTaskAssignment failed", err);
  }
}

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
    const patch: {
      title?: string;
      details?: string | null;
      assigned_role?: "admin" | "clinician" | null;
      due_at?: string | null;
      status?: "open" | "done" | "cancelled";
      completed_by?: string | null;
      completed_at?: string | null;
    } = { ...data.patch };
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
