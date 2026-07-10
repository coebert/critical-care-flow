// Send a mock capacity-crossing push to the caller's own device subscriptions,
// respecting their per-level notification preferences. Used from the
// notification settings page to verify end-to-end delivery — including that
// tapping the push opens the bed board pre-focused on the intended shift and
// care level.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

type Level = "l3" | "l2" | "l1";
type Shift = "day" | "night";

function labelFor(k: Level): string {
  return k === "l3" ? "Level 3" : k === "l2" ? "Level 2" : "Level 1/0";
}

function levelNum(k: Level): 1 | 2 | 3 {
  return k === "l3" ? 3 : k === "l2" ? 2 : 1;
}

export interface TestCapacityPushResult {
  ok: boolean;
  reason?:
    | "capacity_alerts_off"
    | "no_levels_selected"
    | "level_not_enabled"
    | "no_subscriptions"
    | "push_not_configured";
  selected_levels: Level[];
  focus_shift: Shift;
  focus_level: 1 | 2 | 3;
  deep_link_url: string;
  subscription_count: number;
  delivered_count: number;
}

const InputSchema = z
  .object({
    shift: z.enum(["day", "night"]).optional(),
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  })
  .optional();

export const sendTestCapacityPush = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => InputSchema.parse(data))
  .handler(async ({ data, context }): Promise<TestCapacityPushResult> => {
    const { supabase, userId } = context;
    const shift: Shift = data?.shift ?? "day";
    const shiftLabel = shift === "night" ? "Night shift" : "Day shift";

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
        focus_shift: shift,
        focus_level: data?.level ?? 3,
        deep_link_url: `/bed-board?focus_shift=${shift}&focus_level=${data?.level ?? 3}`,
        subscription_count: 0,
        delivered_count: 0,
      };
    }

    const enabled: Level[] = [];
    if (prof?.notify_capacity_l3 !== false) enabled.push("l3");
    if (prof?.notify_capacity_l2 !== false) enabled.push("l2");
    if (prof?.notify_capacity_l1 !== false) enabled.push("l1");
    if (!enabled.length) {
      return {
        ok: false,
        reason: "no_levels_selected",
        selected_levels: [],
        focus_shift: shift,
        focus_level: data?.level ?? 3,
        deep_link_url: `/bed-board?focus_shift=${shift}&focus_level=${data?.level ?? 3}`,
        subscription_count: 0,
        delivered_count: 0,
      };
    }

    // If the caller specified a level, use only it (and verify it's enabled).
    let selected: Level[];
    if (data?.level) {
      const key: Level = data.level === 3 ? "l3" : data.level === 2 ? "l2" : "l1";
      if (!enabled.includes(key)) {
        return {
          ok: false,
          reason: "level_not_enabled",
          selected_levels: [],
          focus_shift: shift,
          focus_level: data.level,
          deep_link_url: `/bed-board?focus_shift=${shift}&focus_level=${data.level}`,
          subscription_count: 0,
          delivered_count: 0,
        };
      }
      selected = [key];
    } else {
      selected = enabled;
    }

    const focusLevel = levelNum(selected[0]);
    const deepLinkUrl = `/bed-board?focus_shift=${shift}&focus_level=${focusLevel}`;

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
        focus_shift: shift,
        focus_level: focusLevel,
        deep_link_url: deepLinkUrl,
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
    const body = `${shiftLabel} · ${summary}. Spare nurses 0 → ${selected.length} (dependency test). Tap to verify deep link opens bed board focused on ${shiftLabel} · ${labelFor(selected[0])}.`;

    const { sendPushToMany } = await import("./push.server");
    const res = await sendPushToMany(
      subs.map((s) => ({
        user_id: userId,
        endpoint: s.endpoint,
        p256dh: s.p256dh,
        auth: s.auth,
      })),
      {
        title: `Radnor Critical Care — ${shiftLabel} capacity (test)`,
        body,
        url: deepLinkUrl,
        tag: `capacity-test-${userId}-${shift}-${focusLevel}`,
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
      focus_shift: shift,
      focus_level: focusLevel,
      deep_link_url: deepLinkUrl,
      subscription_count: subs.length,
      delivered_count: delivered,
    };
  });
