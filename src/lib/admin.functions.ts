import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { safeError } from "./safe-error";

async function assertAdmin(context: any) {
  const { data, error } = await context.supabase.rpc("has_role", {
    _user_id: context.userId,
    _role: "admin",
  });
  if (error) throw safeError("admin.assertAdmin", error, "Permission check failed.");
  if (!data) throw new Error("Forbidden: admin role required");
}

export const inviteClinician = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        email: z.string().email().max(255),
        full_name: z.string().trim().min(1).max(120),
        job_title: z.string().trim().max(120).optional(),
        role: z.enum(["admin", "clinician"]).default("clinician"),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Send a time-limited magic-link invite. The user clicks the link in their
    // email and sets their own password — no plaintext temporary password is
    // ever stored, displayed in the admin UI, or held in a browser DOM.
    const { data: invited, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(
      data.email,
      {
        data: { full_name: data.full_name, job_title: data.job_title ?? null },
      },
    );
    if (error) throw safeError("admin.inviteClinician", error, "Failed to invite user.");
    const newUserId = invited.user!.id;

    if (data.role === "admin") {
      // Trigger inserted 'clinician'; upgrade to admin
      const { error: roleErr } = await supabaseAdmin
        .from("user_roles")
        .upsert({ user_id: newUserId, role: "admin" }, { onConflict: "user_id,role" });
      if (roleErr) throw safeError("admin.inviteClinician.role", roleErr, "Failed to set admin role.");
    }

    await supabaseAdmin.from("audit_log").insert({
      user_id: context.userId,
      action: "create",
      entity: "user",
      entity_id: newUserId,
      diff: { email: data.email, role: data.role, method: "invite_email" },
    });

    return { user_id: newUserId };
  });

export const listUsers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: users, error } = await supabaseAdmin.auth.admin.listUsers({ perPage: 200 });
    if (error) throw safeError("admin.listUsers", error, "Failed to load users.");
    const { data: profiles } = await supabaseAdmin.from("profiles").select("*");
    const { data: roles } = await supabaseAdmin.from("user_roles").select("*");
    return users.users.map((u) => ({
      id: u.id,
      email: u.email ?? "",
      created_at: u.created_at,
      last_sign_in_at: u.last_sign_in_at,
      profile: profiles?.find((p) => p.id === u.id) ?? null,
      roles: (roles ?? []).filter((r) => r.user_id === u.id).map((r) => r.role),
    }));
  });

export const setUserRole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        user_id: z.string().uuid(),
        role: z.enum(["admin", "clinician"]),
        grant: z.boolean(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    if (data.grant) {
      const { error } = await supabaseAdmin
        .from("user_roles")
        .upsert({ user_id: data.user_id, role: data.role }, { onConflict: "user_id,role" });
      if (error) throw safeError("admin.setUserRole.grant", error, "Failed to grant role.");
    } else {
      const { error } = await supabaseAdmin
        .from("user_roles")
        .delete()
        .eq("user_id", data.user_id)
        .eq("role", data.role);
      if (error) throw safeError("admin.setUserRole.revoke", error, "Failed to revoke role.");
    }
    await supabaseAdmin.from("audit_log").insert({
      user_id: context.userId,
      action: "update",
      entity: "user_role",
      entity_id: data.user_id,
      diff: { role: data.role, grant: data.grant },
    });

    return { ok: true };
  });

export const getAuditLog = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    // Use the admin client so RLS on audit_log cannot silently hide rows from
    // admins (e.g. entries written by service_role or by users whose scope
    // no longer matches the policy). Access is gated by assertAdmin above.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("audit_log")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw safeError("admin.getAuditLog", error, "Failed to load audit log.");
    return data;
  });
