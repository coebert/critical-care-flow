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

function diffMessage(prev: LevelFlags | null, next: LevelFlags): string | null {
  const changes: string[] = [];
  const check = (label: string, p: boolean | undefined, n: boolean) => {
    if (p === undefined) {
      if (n) changes.push(`${label} available`);
      return;
    }
    if (p === n) return;
    changes.push(n ? `${label} now available` : `${label} no longer available`);
  };
  check("Level 3", prev?.l3, next.l3);
  check("Level 2", prev?.l2, next.l2);
  check("Level 1", prev?.l1, next.l1);
  return changes.length ? changes.join(" · ") : null;
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

    const message = diffMessage(prev, next);
    if (!message) return;

    const shiftLabel = shift === "day" ? "Day shift" : "Night shift";
    const body = `${shiftLabel}: ${message}. Spare ${block.spare ?? "—"} nurses (dependency ${snap.dependency}).`;

    // Recipients: everyone at work with a push subscription. Capacity alerts
    // are unit-wide, so we don't gate on per-referral notification prefs.
    const { data: profiles } = await admin
      .from("profiles")
      .select("id, is_at_work")
      .eq("is_at_work", true);
    const recipientIds = (profiles ?? []).map((p) => p.id);
    if (!recipientIds.length) return;

    // Persist in-app notifications (referral_id NULL, kind='capacity').
    const notifRows = recipientIds.map((uid) => ({
      user_id: uid,
      referral_id: null as string | null,
      kind: "capacity",
      message: body,
    }));
    await admin.from("notifications").insert(notifRows as any);

    // Push fan-out.
    const { data: subs } = await admin
      .from("push_subscriptions")
      .select("user_id, endpoint, p256dh, auth")
      .in("user_id", recipientIds);
    if (subs && subs.length) {
      const { goneEndpoints } = await sendPushToMany(
        subs.map((s) => ({ user_id: s.user_id, endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth })),
        {
          title: "Critical Care — admission capacity",
          body,
          url: "/bed-board",
          tag: `capacity-${shiftKey}`,
        },
      );
      if (goneEndpoints.length) {
        await admin.from("push_subscriptions").delete().in("endpoint", goneEndpoints);
      }
    }
  } catch (e) {
    console.error("[nurse-capacity-alerts] failed", e);
  }
}
