import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { safeError } from "./safe-error";
import { assertAdmin } from "./auth-guards";
import { redactAuditDiff } from "./audit-redact";
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

export const AUDIT_SORT_COLUMNS = ["created_at", "action", "entity"] as const;
export type AuditSortColumn = (typeof AUDIT_SORT_COLUMNS)[number];
export const AUDIT_ACTIONS = ["create", "update", "delete"] as const;

// Custom error messages that DELIBERATELY omit the caller-supplied value.
// Zod's default enum / datetime / string errors echo the received value
// verbatim (e.g. `received 'H-1234567'`), which turns any accidentally-
// sensitive filter value into a leak via error logs & client toasts. Fixed
// messages keep the validation surface stable and value-free.
const auditLogInputSchema = z
  .object({
    limit: z
      .number({ message: "Invalid limit" })
      .int({ message: "Invalid limit" })
      .min(1, { message: "Invalid limit" })
      .max(200, { message: "Invalid limit" })
      .optional(),
    offset: z
      .number({ message: "Invalid offset" })
      .int({ message: "Invalid offset" })
      .min(0, { message: "Invalid offset" })
      .max(100_000, { message: "Invalid offset" })
      .optional(),
    sortBy: z.enum(AUDIT_SORT_COLUMNS, { message: "Invalid sortBy" }).optional(),
    sortDir: z.enum(["asc", "desc"], { message: "Invalid sortDir" }).optional(),
    // --- filters ---
    entity: z
      .string({ message: "Invalid entity" })
      .trim()
      .min(1, { message: "Invalid entity" })
      .max(64, { message: "Invalid entity" })
      .optional(),
    action: z.enum(AUDIT_ACTIONS, { message: "Invalid action" }).optional(),
    // Free-text clinician search: matched against profiles.full_name (ilike).
    // A UUID is treated as a direct user_id filter for exact lookups.
    clinician: z
      .string({ message: "Invalid clinician" })
      .trim()
      .min(1, { message: "Invalid clinician" })
      .max(120, { message: "Invalid clinician" })
      .optional(),
    // Filter referral-entity rows whose linked referral has this specialty.
    specialty: z
      .string({ message: "Invalid specialty" })
      .trim()
      .min(1, { message: "Invalid specialty" })
      .max(120, { message: "Invalid specialty" })
      .optional(),
    // ISO datetimes bounding audit_log.created_at.
    from: z.string().datetime({ message: "Invalid from" }).optional(),
    to: z.string().datetime({ message: "Invalid to" }).optional(),
  })
  .default({});

export type AuditLogFilters = z.infer<typeof auditLogInputSchema>;

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
  total: number;
  limit: number;
  offset: number;
  sortBy: AuditSortColumn;
  sortDir: "asc" | "desc";
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Extracted so integration tests can exercise the full query pipeline
// (clinician/specialty resolution, filter shaping, and redaction) against
// a mocked supabaseAdmin without needing the TanStack Start runtime.
// The server-fn handler below is a thin wrapper around this function.
export async function runGetAuditLog(
  data: AuditLogFilters,
  supabaseAdmin: any,
): Promise<AuditLogPage> {
  const limit = data.limit ?? 50;
  const offset = data.offset ?? 0;
  const sortBy: AuditSortColumn = data.sortBy ?? "created_at";
  const sortDir: "asc" | "desc" = data.sortDir ?? "desc";

  // Resolve clinician query → set of user_ids. A UUID means exact match; any
  // other string is looked up against profiles.full_name (ilike). An unknown
  // name yields an empty set so the query returns zero rows.
  let userIdFilter: string[] | null = null;
  if (data.clinician) {
    if (UUID_RE.test(data.clinician)) {
      userIdFilter = [data.clinician];
    } else {
      const { data: profs, error: profErr } = await supabaseAdmin
        .from("profiles")
        .select("id")
        .ilike("full_name", `%${data.clinician}%`)
        .limit(200);
      if (profErr) throw safeError("admin.getAuditLog.clinician", profErr, "Failed to load audit log.");
      userIdFilter = ((profs ?? []) as Array<{ id: string }>).map((p) => p.id);
      if (userIdFilter!.length === 0) userIdFilter = ["00000000-0000-0000-0000-000000000000"];
    }
  }

  // Resolve specialty → referral ids. Implies entity='referral'.
  let referralIdFilter: string[] | null = null;
  if (data.specialty) {
    const { data: refs, error: refErr } = await supabaseAdmin
      .from("referrals")
      .select("id")
      .ilike("referring_specialty", `%${data.specialty}%`)
      .limit(5000);
    if (refErr) throw safeError("admin.getAuditLog.specialty", refErr, "Failed to load audit log.");
    referralIdFilter = ((refs ?? []) as Array<{ id: string }>).map((r) => r.id);
    if (referralIdFilter!.length === 0) referralIdFilter = ["00000000-0000-0000-0000-000000000000"];
  }

  let query = supabaseAdmin
    .from("audit_log")
    .select("*", { count: "exact" })
    .order(sortBy, { ascending: sortDir === "asc" });
  if (sortBy !== "created_at") {
    query = query.order("created_at", { ascending: false });
  }
  if (data.entity) query = query.eq("entity", data.entity);
  if (data.action) query = query.eq("action", data.action);
  if (userIdFilter) query = query.in("user_id", userIdFilter);
  if (referralIdFilter) {
    query = query.eq("entity", "referral").in("entity_id", referralIdFilter);
  }
  if (data.from) query = query.gte("created_at", data.from);
  if (data.to) query = query.lte("created_at", data.to);

  const { data: rows, error, count } = await query.range(offset, offset + limit);
  if (error) throw safeError("admin.getAuditLog", error, "Failed to load audit log.");
  const list = rows ?? [];
  const hasMore = list.length > limit;
  const redacted = list.slice(0, limit).map((r: AuditLogEntry) => ({
    ...r,
    diff: redactAuditDiff(r.diff),
  })) as AuditLogPage["rows"];
  return {
    rows: redacted,
    hasMore,
    nextOffset: offset + limit,
    total: count ?? redacted.length,
    limit,
    offset,
    sortBy,
    sortDir,
  };
}

export const getAuditLog = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => auditLogInputSchema.parse(input ?? {}))
  .handler(async ({ data, context }): Promise<AuditLogPage> => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    return runGetAuditLog(data, supabaseAdmin);
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


// -----------------------------------------------------------------------------
// Notification lifecycle audit — per-user, per-notification_id timeline.
// For every notification row we show: when it was created, the referral it
// was attached to, when (or if) it was consumed by a deep-link view
// (audit_log.action='view' with diff->>notification_id = notifications.id),
// and when it was marked read. The single-use guarantee enforced in
// logReferralView means there is at most one "used" audit row per
// notification_id; if it appears against a referral other than the
// notification's own referral_id we surface that as a mismatch for
// investigation.
// -----------------------------------------------------------------------------

const lifecycleAuditInputSchema = z
  .object({
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).max(10_000).optional(),
    user_id: z.string().uuid().optional(),
    referral_id: z.string().uuid().optional(),
    state: z.enum(["all", "unread", "read", "unused", "used", "expired"]).optional(),
  })
  .default({});

export type NotificationLifecycleRow = {
  notification_id: string;
  user_id: string;
  user_name: string | null;
  referral_id: string;
  kind: string;
  message: string | null;
  created_at: string;
  read_at: string | null;
  used_at: string | null;
  used_by_user_id: string | null;
  used_against_referral_id: string | null;
  mismatch: boolean;
};

export type NotificationLifecycleAuditPage = {
  rows: NotificationLifecycleRow[];
  hasMore: boolean;
  nextOffset: number;
};

export const getNotificationLifecycleAudit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => lifecycleAuditInputSchema.parse(input ?? {}))
  .handler(async ({ data, context }): Promise<NotificationLifecycleAuditPage> => {
    await assertAdmin(context);
    // Admin-only view. Uses the service-role client because RLS on
    // notifications restricts each row to its recipient.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const limit = data.limit ?? 100;
    const offset = data.offset ?? 0;

    let q = supabaseAdmin
      .from("notifications")
      .select("id, user_id, referral_id, kind, message, read_at, created_at")
      .order("created_at", { ascending: false })
      .range(offset, offset + limit);
    if (data.user_id) q = q.eq("user_id", data.user_id);
    if (data.referral_id) q = q.eq("referral_id", data.referral_id);
    if (data.state === "unread") q = q.is("read_at", null);
    if (data.state === "read") q = q.not("read_at", "is", null);
    const { data: notifs, error } = await q;
    if (error) {
      throw safeError("admin.getNotificationLifecycleAudit", error, "Failed to load lifecycle audit.");
    }

    const list = notifs ?? [];
    const hasMore = list.length > limit;
    const page = list.slice(0, limit) as Array<{
      id: string;
      user_id: string;
      referral_id: string;
      kind: string;
      message: string | null;
      read_at: string | null;
      created_at: string;
    }>;

    // Batch-fetch every audit_log 'view' row whose diff.notification_id
    // matches one of this page's notifications. A notification_id is
    // single-use per user, so we expect at most one hit per id.
    const ids = page.map((n) => n.id);
    const usedByNotificationId = new Map<
      string,
      { used_at: string; used_by_user_id: string | null; used_against_referral_id: string | null }
    >();
    if (ids.length) {
      const { data: audit, error: auditErr } = await supabaseAdmin
        .from("audit_log")
        .select("user_id, entity_id, created_at, diff")
        .eq("action", "view")
        .eq("entity", "referral")
        .in("diff->>notification_id", ids)
        .order("created_at", { ascending: true });
      if (auditErr) {
        throw safeError("admin.getNotificationLifecycleAudit.audit", auditErr, "Failed to load lifecycle audit.");
      }
      for (const row of audit ?? []) {
        const nid = (row as any).diff?.notification_id as string | null;
        if (!nid || usedByNotificationId.has(nid)) continue; // first (earliest) wins
        usedByNotificationId.set(nid, {
          used_at: (row as any).created_at,
          used_by_user_id: (row as any).user_id,
          used_against_referral_id: (row as any).entity_id,
        });
      }
    }

    // Hydrate recipient display names.
    const userIds = Array.from(new Set(page.map((n) => n.user_id)));
    const nameById = new Map<string, string | null>();
    if (userIds.length) {
      const { data: profiles } = await supabaseAdmin
        .from("profiles")
        .select("id, full_name")
        .in("id", userIds);
      for (const p of profiles ?? []) nameById.set((p as any).id, (p as any).full_name);
    }

    let rows: NotificationLifecycleRow[] = page.map((n) => {
      const used = usedByNotificationId.get(n.id) ?? null;
      return {
        notification_id: n.id,
        user_id: n.user_id,
        user_name: nameById.get(n.user_id) ?? null,
        referral_id: n.referral_id,
        kind: n.kind,
        message: n.message,
        created_at: n.created_at,
        read_at: n.read_at,
        used_at: used?.used_at ?? null,
        used_by_user_id: used?.used_by_user_id ?? null,
        used_against_referral_id: used?.used_against_referral_id ?? null,
        mismatch: !!used && used.used_against_referral_id !== n.referral_id,
      };
    });

    if (data.state === "used") rows = rows.filter((r) => r.used_at !== null);
    if (data.state === "unused") rows = rows.filter((r) => r.used_at === null);

    return { rows, hasMore, nextOffset: offset + limit };
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
