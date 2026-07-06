// Shared wiring for `fanOutNotifications`. Both the referrals and
// encrypted-notes code paths need the same fetch/insert/push helpers backed
// by the service-role client, so we build them once here and hand the deps
// object back to the caller. Keep this file server-only — it must never be
// pulled into the client bundle.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { FanOutDeps } from "./notification-fanout";

// Typed to the generated Database schema so column typos in this file are
// caught at build time rather than at runtime by the admin client.
export type AdminClient = SupabaseClient<Database>;

export function buildNotificationFanoutDeps(admin: AdminClient): FanOutDeps {
  return {
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
        .select(
          "id, is_at_work, notify_notes, notify_status, notify_new_referral, notify_updated_referral",
        )
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
      const { data } = await admin
        .from("notifications")
        .insert(rows as any)
        .select("id, user_id");
      return (data ?? []) as any;
    },
    sendPush: async (subs, payload) => {
      const { sendPushToMany } = await import("./push.server");
      return sendPushToMany(subs as any, payload);
    },
    deletePushSubs: async (endpoints) => {
      await admin.from("push_subscriptions").delete().in("endpoint", endpoints);
    },
    recordDeliveries: async (rows) => {
      const { error } = await admin
        .from("notification_deliveries")
        .insert(rows as any);
      if (error) {
        console.error("[fanOut] recordDeliveries", error);
      }
    },
  };
}
