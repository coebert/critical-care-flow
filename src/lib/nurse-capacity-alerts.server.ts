// Server-only helper: detect material changes in spare admission capacity
// (per care level going from zero to available or vice versa for the current
// shift) and fan out a push notification + persistent in-app alert.
//
// Idempotent by design: the previous state is stored in the
// nurse_capacity_alert_state singleton row, so repeated calls after the same
// underlying situation do nothing.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { computeNurseCapacity, todayIsoDate, type Shift } from "./nurse-capacity";
import { sendPushToMany } from "./push.server";

type Admin = SupabaseClient<Database>;

export function currentShift(now: Date = new Date()): { date: string; shift: Shift } {
  const h = now.getHours();
  // Day shift 08:00–19:59 local, night shift 20:00–07:59 local.
  if (h >= 8 && h < 20) return { date: todayIsoDate(now), shift: "day" };
  if (h >= 20) return { date: todayIsoDate(now), shift: "night" };
  // 00:00–07:59 belongs to the night shift that started the previous evening.
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  return { date: todayIsoDate(y), shift: "night" };
}

interface LevelFlags {
  l3: boolean;
  l2: boolean;
  l1: boolean;
}

function flagsFromSnap(spare: number | null, level3: number | null, level2: number | null, level1: number | null): LevelFlags {
  if (spare == null) return { l3: false, l2: false, l1: false };
  return {
    l3: (level3 ?? 0) > 0,
    l2: (level2 ?? 0) > 0,
    l1: (level1 ?? 0) > 0,
  };
}

export type FlippedLevel = "l3" | "l2" | "l1";

export function flippedLevels(prev: LevelFlags | null, next: LevelFlags): FlippedLevel[] {
  const out: FlippedLevel[] = [];
  (["l3", "l2", "l1"] as const).forEach((k) => {
    const p = prev?.[k];
    const n = next[k];
    if (p === undefined) {
      if (n) out.push(k);
    } else if (p !== n) {
      out.push(k);
    }
  });
  return out;
}

function levelLabel(k: FlippedLevel): string {
  return k === "l3" ? "Level 3" : k === "l2" ? "Level 2" : "Level 1/0";
}

function slotsFor(k: FlippedLevel, block: { level3_slots: number | null; level2_slots: number | null; level1_slots: number | null }): number {
  const raw = k === "l3" ? block.level3_slots : k === "l2" ? block.level2_slots : block.level1_slots;
  return Math.max(0, raw ?? 0);
}

function messageFor(
  levels: FlippedLevel[],
  next: LevelFlags,
  block: { level3_slots: number | null; level2_slots: number | null; level1_slots: number | null },
): string {
  return levels
    .map((k) => {
      const slots = slotsFor(k, block);
      return next[k]
        ? `${levelLabel(k)}: ${slots} spare admission${slots === 1 ? "" : "s"} available`
        : `${levelLabel(k)}: no spare admissions`;
    })
    .join(" · ");
}



/**
 * Recompute current spare capacity and, if it flips a per-level available flag
 * versus the last stored state, fan out a push + in-app notification.
 * Safe to call from any bed / staffing mutation; errors are logged and
 * swallowed so they never break the originating write.
 */
export async function checkAndAlertNurseCapacity(admin: Admin, now: Date = new Date()): Promise<void> {
  try {
    const { date, shift } = currentShift(now);
    const shiftKey = `${date}#${shift}`;

    const [{ data: staffing }, { data: occs }] = await Promise.all([
      admin
        .from("nurse_staffing")
        .select("shift, available_nurses")
        .eq("shift_date", date),
      admin
        .from("bed_occupancies")
        .select("id,bed_id,discharged_at,predicted_discharge_at,level")
        .is("discharged_at", null),
    ]);

    const dayRow = (staffing ?? []).find((s) => s.shift === "day");
    const nightRow = (staffing ?? []).find((s) => s.shift === "night");

    const snap = computeNurseCapacity({
      occupancies: (occs ?? []).map((o) => ({
        id: o.id,
        bed_id: o.bed_id,
        discharged_at: o.discharged_at,
        predicted_discharge_at: o.predicted_discharge_at,
        level: (o.level ?? 3) as number,
      })),
      day_available: dayRow ? Number(dayRow.available_nurses) : null,
      night_available: nightRow ? Number(nightRow.available_nurses) : null,
    });

    const block = shift === "day" ? snap.day : snap.night;
    const next = flagsFromSnap(block.spare, block.level3_slots, block.level2_slots, block.level1_slots);

    // Load previous state.
    const { data: prevRow } = await admin
      .from("nurse_capacity_alert_state")
      .select("shift_key, level3_available, level2_available, level1_available")
      .eq("id", true)
      .maybeSingle();

    const prev: LevelFlags | null =
      prevRow && prevRow.shift_key === shiftKey
        ? {
            l3: !!prevRow.level3_available,
            l2: !!prevRow.level2_available,
            l1: !!prevRow.level1_available,
          }
        : null;

    // Persist the new state up front (even if we don't notify, to avoid drift).
    await admin.from("nurse_capacity_alert_state").upsert(
      {
        id: true,
        shift_key: shiftKey,
        level3_available: next.l3,
        level2_available: next.l2,
        level1_available: next.l1,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    );

    const flipped = flippedLevels(prev, next);
    if (!flipped.length) return;

    const shiftLabel = shift === "day" ? "Day shift" : "Night shift";
    const prefKey: Record<FlippedLevel, "notify_capacity_l3" | "notify_capacity_l2" | "notify_capacity_l1"> = {
      l3: "notify_capacity_l3",
      l2: "notify_capacity_l2",
      l1: "notify_capacity_l1",
    };

    // Recipients: everyone at work with capacity alerts on for at least one
    // of the flipped levels. Per-user preferences narrow both the audience
    // and the wording of the alert.
    const { data: profiles } = await admin
      .from("profiles")
      .select("id, is_at_work, notify_capacity, notify_capacity_l3, notify_capacity_l2, notify_capacity_l1")
      .eq("is_at_work", true);

    type Row = {
      id: string;
      notify_capacity: boolean | null;
      notify_capacity_l3: boolean | null;
      notify_capacity_l2: boolean | null;
      notify_capacity_l1: boolean | null;
    };
    const perUser: Array<{ id: string; body: string }> = [];
    for (const p of (profiles ?? []) as Row[]) {
      if (p.notify_capacity === false) continue;
      const userLevels = flipped.filter((k) => (p as any)[prefKey[k]] !== false);
      if (!userLevels.length) continue;
      const summary = messageFor(userLevels, next, block);
      perUser.push({
        id: p.id,
        body: `${shiftLabel}: ${summary}. Spare ${block.spare ?? "—"} nurses (dependency ${snap.dependency}).`,
      });
    }
    if (!perUser.length) return;

    const recipientIds = perUser.map((u) => u.id);
    const bodyByUser = new Map(perUser.map((u) => [u.id, u.body]));

    // Persist in-app notifications (referral_id NULL, kind='capacity').
    const notifRows = perUser.map((u) => ({
      user_id: u.id,
      referral_id: null as string | null,
      kind: "capacity",
      message: u.body,
    }));
    await admin.from("notifications").insert(notifRows as any);

    // Push fan-out — personalised body per subscription.
    const { data: subs } = await admin
      .from("push_subscriptions")
      .select("user_id, endpoint, p256dh, auth")
      .in("user_id", recipientIds);
    if (subs && subs.length) {
      const goneEndpoints: string[] = [];
      // Group by body so we send one request per (body, subs) batch.
      const groups = new Map<string, typeof subs>();
      for (const s of subs) {
        const b = bodyByUser.get(s.user_id);
        if (!b) continue;
        const g = groups.get(b) ?? [];
        g.push(s);
        groups.set(b, g);
      }
      for (const [body, group] of groups) {
        const res = await sendPushToMany(
          group.map((s) => ({ user_id: s.user_id, endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth })),
          {
            title: "Critical Care — admission capacity",
            body,
            url: "/bed-board",
            tag: `capacity-${shiftKey}`,
          },
        );
        goneEndpoints.push(...res.goneEndpoints);
      }
      if (goneEndpoints.length) {
        await admin.from("push_subscriptions").delete().in("endpoint", goneEndpoints);
      }
    }

  } catch (e) {
    console.error("[nurse-capacity-alerts] failed", e);
  }
}
