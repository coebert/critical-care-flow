import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { safeError } from "./safe-error";
import { assertAdmin } from "./auth-guards";
import type { Tables } from "@/integrations/supabase/types";

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

const listUsersInputSchema = z
  .object({
    page: z.number().int().min(1).max(1000).optional(),
    perPage: z.number().int().min(1).max(200).optional(),
  })
  .default({});

export type ListUsersPage = {
  users: Array<{
    id: string;
    email: string;
    created_at: string;
    last_sign_in_at: string | null;
    profile: Tables<"profiles"> | null;
    roles: string[];
  }>;
  page: number;
  perPage: number;
  hasMore: boolean;
};

export const listUsers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => listUsersInputSchema.parse(input ?? {}))
  .handler(async ({ data, context }): Promise<ListUsersPage> => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const page = data.page ?? 1;
    const perPage = data.perPage ?? 50;

    // Ask for perPage+1 so we can report hasMore without a second call.
    const { data: usersRes, error } = await supabaseAdmin.auth.admin.listUsers({
      page,
      perPage: perPage + 1,
    });
    if (error) throw safeError("admin.listUsers", error, "Failed to load users.");
    const allUsers = usersRes.users ?? [];
    const hasMore = allUsers.length > perPage;
    const pageUsers = hasMore ? allUsers.slice(0, perPage) : allUsers;
    const ids = pageUsers.map((u) => u.id);

    // Fetch profiles + roles ONLY for the current page and index by id in a
    // Map — replaces the previous O(N²) filter/find joins over every user.
    const [{ data: profiles }, { data: roles }] = await Promise.all([
      ids.length
        ? supabaseAdmin.from("profiles").select("*").in("id", ids)
        : Promise.resolve({ data: [] as any[] }),
      ids.length
        ? supabaseAdmin.from("user_roles").select("*").in("user_id", ids)
        : Promise.resolve({ data: [] as any[] }),
    ]);
    const profileById = new Map((profiles ?? []).map((p: any) => [p.id, p]));
    const rolesById = new Map<string, string[]>();
    for (const r of roles ?? []) {
      const list = rolesById.get(r.user_id) ?? [];
      list.push(r.role);
      rolesById.set(r.user_id, list);
    }

    return {
      users: pageUsers.map((u) => ({
        id: u.id,
        email: u.email ?? "",
        created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at ?? null,
        profile: profileById.get(u.id) ?? null,
        roles: rolesById.get(u.id) ?? [],
      })),
      page,
      perPage,
      hasMore,
    };
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

    // Self-demotion guard: an admin cannot revoke their own admin role.
    // Even if another admin exists, requiring a peer to demote you avoids
    // the "sole-admin footgun" of an accidental self-lockout.
    if (
      !data.grant &&
      data.role === "admin" &&
      data.user_id === context.userId
    ) {
      throw new Error(
        "You cannot revoke your own admin role. Ask another admin to do it.",
      );
    }

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

const auditLogInputSchema = z
  .object({
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).max(10_000).optional(),
  })
  .default({});

export type AuditLogEntry = {
  id: string;
  user_id: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  // Free-form JSON diff written by callers; keep loose so TSS can serialize.
  diff: any;
  created_at: string;
};

export type AuditLogPage = {
  rows: AuditLogEntry[];
  hasMore: boolean;
  nextOffset: number;
};

export const getAuditLog = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => auditLogInputSchema.parse(input ?? {}))
  .handler(async ({ data, context }): Promise<AuditLogPage> => {
    await assertAdmin(context);
    // Use the admin client so RLS on audit_log cannot silently hide rows from
    // admins (e.g. entries written by service_role or by users whose scope
    // no longer matches the policy). Access is gated by assertAdmin above.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const limit = data.limit ?? 100;
    const offset = data.offset ?? 0;
    // Fetch limit+1 to detect whether more rows exist without a second query.
    const { data: rows, error } = await supabaseAdmin
      .from("audit_log")
      .select("*")
      .order("created_at", { ascending: false })
      .range(offset, offset + limit);
    if (error) throw safeError("admin.getAuditLog", error, "Failed to load audit log.");
    const list = rows ?? [];
    const hasMore = list.length > limit;
    return {
      rows: list.slice(0, limit) as AuditLogPage["rows"],
      hasMore,
      nextOffset: offset + limit,
    };
  });

// -----------------------------------------------------------------------------
// Notification delivery audit
// -----------------------------------------------------------------------------

const deliveryAuditInputSchema = z
  .object({
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).max(10_000).optional(),
    channel: z.enum(["inapp", "push"]).optional(),
    status: z.enum(["generated", "sent", "failed", "gone"]).optional(),
  })
  .default({});

export type NotificationDeliveryRow = {
  id: string;
  notification_id: string | null;
  recipient_id: string;
  recipient_name: string | null;
  actor_id: string | null;
  actor_name: string | null;
  referral_id: string | null;
  kind: string;
  channel: "inapp" | "push";
  status: "generated" | "sent" | "failed" | "gone";
  endpoint: string | null;
  error: string | null;
  generated_at: string;
  delivered_at: string | null;
};

export type NotificationDeliveryAuditPage = {
  rows: NotificationDeliveryRow[];
  hasMore: boolean;
  nextOffset: number;
};

export const getNotificationDeliveryAudit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => deliveryAuditInputSchema.parse(input ?? {}))
  .handler(async ({ data, context }): Promise<NotificationDeliveryAuditPage> => {
    await assertAdmin(context);
    // Admins can see every delivery record (the recipient RLS policy would
    // otherwise hide rows addressed to other users). Access is gated above.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const limit = data.limit ?? 100;
    const offset = data.offset ?? 0;

    let q = supabaseAdmin
      .from("notification_deliveries")
      .select(
        "id, notification_id, recipient_id, actor_id, referral_id, kind, channel, status, endpoint, error, generated_at, delivered_at",
      )
      .order("generated_at", { ascending: false })
      .range(offset, offset + limit);
    if (data.channel) q = q.eq("channel", data.channel);
    if (data.status) q = q.eq("status", data.status);
    const { data: rows, error } = await q;
    if (error) throw safeError("admin.getNotificationDeliveryAudit", error, "Failed to load delivery audit.");

    const list = rows ?? [];
    const hasMore = list.length > limit;
    const page = list.slice(0, limit);

    // Hydrate actor/recipient display names in a single profile lookup.
    const userIds = Array.from(
      new Set(
        page
          .flatMap((r) => [r.recipient_id, r.actor_id])
          .filter((v): v is string => !!v),
      ),
    );
    const nameById = new Map<string, string | null>();
    if (userIds.length) {
      const { data: profiles } = await supabaseAdmin
        .from("profiles")
        .select("id, full_name")
        .in("id", userIds);
      for (const p of profiles ?? []) nameById.set((p as any).id, (p as any).full_name);
    }

    const hydrated: NotificationDeliveryRow[] = page.map((r) => ({
      ...(r as any),
      recipient_name: nameById.get((r as any).recipient_id) ?? null,
      actor_name: (r as any).actor_id ? (nameById.get((r as any).actor_id) ?? null) : null,
    }));

    return { rows: hydrated, hasMore, nextOffset: offset + limit };
  });


export const updateIcnarcTargets = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        time_to_seen_target_min: z.number().int().min(1).max(100_000),
        decision_to_arrival_target_min: z.number().int().min(1).max(100_000),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { error } = await supabaseAdmin
      .from("icnarc_targets")
      .update({
        time_to_seen_target_min: data.time_to_seen_target_min,
        decision_to_arrival_target_min: data.decision_to_arrival_target_min,
        updated_by: context.userId,
      })
      .eq("id", true);
    if (error) throw safeError("admin.updateIcnarcTargets", error, "Failed to update ICNARC targets.");

    await supabaseAdmin.from("audit_log").insert({
      user_id: context.userId,
      action: "update",
      entity: "icnarc_targets",
      entity_id: null,
      diff: {
        time_to_seen_target_min: data.time_to_seen_target_min,
        decision_to_arrival_target_min: data.decision_to_arrival_target_min,
      },
    });

    return { ok: true };
  });
