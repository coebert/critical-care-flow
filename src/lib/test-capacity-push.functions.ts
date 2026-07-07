// Send a mock capacity-crossing push to the caller's own device subscriptions,
// respecting their per-level notification preferences. Used from the
// notification settings page to verify end-to-end delivery.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

type Level = "l3" | "l2" | "l1";

function labelFor(k: Level): string {
  return k === "l3" ? "Level 3" : k === "l2" ? "Level 2" : "Level 1/0";
}

export interface TestCapacityPushResult {
  ok: boolean;
  reason?:
    | "capacity_alerts_off"
    | "no_levels_selected"
    | "no_subscriptions"
    | "push_not_configured";
  selected_levels: Level[];
  subscription_count: number;
  delivered_count: number;
}

export const sendTestCapacityPush = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<TestCapacityPushResult> => {
    const { supabase, userId } = context;

    const { data: prof, error: profErr } = await supabase
      .from("profiles")
      .select(
        "notify_capacity, notify_capacity_l3, notify_capacity_l2, notify_capacity_l1",
      )
      .eq("id", userId)
      .maybeSingle();
    if (profErr) throw profErr;

    const master = prof?.notify_capacity !== false;
    if (!master) {
      return {
        ok: false,
        reason: "capacity_alerts_off",
        selected_levels: [],
        subscription_count: 0,
        delivered_count: 0,
      };
    }

    const selected: Level[] = [];
    if (prof?.notify_capacity_l3 !== false) selected.push("l3");
    if (prof?.notify_capacity_l2 !== false) selected.push("l2");
    if (prof?.notify_capacity_l1 !== false) selected.push("l1");
    if (!selected.length) {
      return {
        ok: false,
        reason: "no_levels_selected",
        selected_levels: [],
        subscription_count: 0,
        delivered_count: 0,
      };
    }

    const { data: subs, error: subsErr } = await supabase
      .from("push_subscriptions")
      .select("endpoint, p256dh, auth")
      .eq("user_id", userId);
    if (subsErr) throw subsErr;
    if (!subs || !subs.length) {
      return {
        ok: false,
        reason: "no_subscriptions",
        selected_levels: selected,
        subscription_count: 0,
        delivered_count: 0,
      };
    }

    const summary = selected
      .map((k, i) => {
        const n = i + 1;
        return `${labelFor(k)}: 0 → ${n} spare admission${n === 1 ? "" : "s"}`;
      })
      .join(" · ");
    const body = `Day shift · ${summary}. Spare nurses 0 → ${selected.length} (dependency test). (Preview only, no real change.)`;

    const { sendPushToMany } = await import("./push.server");
    const res = await sendPushToMany(
      subs.map((s) => ({
        user_id: userId,
        endpoint: s.endpoint,
        p256dh: s.p256dh,
        auth: s.auth,
      })),
      {
        title: "Critical Care — Day shift capacity (test)",

        body,
        url: `/bed-board?focus_shift=day&focus_level=${selected[0] === "l3" ? 3 : selected[0] === "l2" ? 2 : 1}`,
        tag: `capacity-test-${userId}`,
      },
    );

    if (res.goneEndpoints.length) {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      await supabaseAdmin.from("push_subscriptions").delete().in("endpoint", res.goneEndpoints);
    }

    const delivered = res.results.filter((r) => r.ok).length;
    const allFailedConfig = res.results.length > 0 && res.results.every((r) => r.error === "push_not_configured");

    return {
      ok: delivered > 0,
      reason: allFailedConfig ? "push_not_configured" : undefined,
      selected_levels: selected,
      subscription_count: subs.length,
      delivered_count: delivered,
    };
  });
