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

function formatCount(n: number): string {
  return n === 0 ? "no spare admissions" : `${n} spare admission${n === 1 ? "" : "s"}`;
}

function messageFor(
  levels: FlippedLevel[],
  nextBlock: { level3_slots: number | null; level2_slots: number | null; level1_slots: number | null },
  prevBlock: { level3_slots: number | null; level2_slots: number | null; level1_slots: number | null } | null,
): string {
  return levels
    .map((k) => {
      const nextN = slotsFor(k, nextBlock);
      const prevN = prevBlock ? slotsFor(k, prevBlock) : null;
      const after = formatCount(nextN);
      if (prevN === null) return `${levelLabel(k)}: now ${after}`;
      const before = prevN === 0 ? "no spare admissions" : `${prevN}`;
      return `${levelLabel(k)}: ${before} → ${after}`;
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

    // Load previous state, including per-level last-alerted timestamps used
    // for short-window deduplication of rapid staffing/capacity flips.
    const { data: prevRow } = await admin
      .from("nurse_capacity_alert_state")
      .select(
        "shift_key, level3_available, level2_available, level1_available, level3_slots, level2_slots, level1_slots, spare, level3_last_alerted_at, level2_last_alerted_at, level1_last_alerted_at",
      )
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

    const prevBlock: { level3_slots: number | null; level2_slots: number | null; level1_slots: number | null; spare: number | null } | null =
      prevRow && prevRow.shift_key === shiftKey
        ? {
            level3_slots: (prevRow as any).level3_slots ?? null,
            level2_slots: (prevRow as any).level2_slots ?? null,
            level1_slots: (prevRow as any).level1_slots ?? null,
            spare: (prevRow as any).spare ?? null,
          }
        : null;


    const lastAlertedAt: Record<FlippedLevel, string | null> =
      prevRow && prevRow.shift_key === shiftKey
        ? {
            l3: (prevRow as any).level3_last_alerted_at ?? null,
            l2: (prevRow as any).level2_last_alerted_at ?? null,
            l1: (prevRow as any).level1_last_alerted_at ?? null,
          }
        : { l3: null, l2: null, l1: null };

    // Dedup window: suppress a per-level alert if we already alerted for
    // that level within the last DEDUP_WINDOW_MS. Availability state is
    // still persisted so the next post-window recomputation compares
    // against the real current situation.
    const DEDUP_WINDOW_MS = 5 * 60 * 1000;
    const nowMs = now.getTime();
    const withinWindow = (iso: string | null) =>
      !!iso && nowMs - new Date(iso).getTime() < DEDUP_WINDOW_MS;

    const flippedRaw = flippedLevels(prev, next);
    const flipped = flippedRaw.filter((k) => !withinWindow(lastAlertedAt[k]));
    const suppressed = flippedRaw.filter((k) => withinWindow(lastAlertedAt[k]));
    if (suppressed.length) {
      console.info(
        `[nurse-capacity-alerts] dedup: suppressed ${suppressed.join(",")} within ${DEDUP_WINDOW_MS}ms`,
      );
    }

    // Persist state up front. Bump last_alerted_at only for levels we are
    // actually about to notify on; keep prior timestamps otherwise so the
    // dedup window continues to count from the real last alert.
    const nowIso = new Date(nowMs).toISOString();
    const l3Alerted = flipped.includes("l3") ? nowIso : lastAlertedAt.l3;
    const l2Alerted = flipped.includes("l2") ? nowIso : lastAlertedAt.l2;
    const l1Alerted = flipped.includes("l1") ? nowIso : lastAlertedAt.l1;

    await admin.from("nurse_capacity_alert_state").upsert(
      {
        id: true,
        shift_key: shiftKey,
        level3_available: next.l3,
        level2_available: next.l2,
        level1_available: next.l1,
        level3_slots: slotsFor("l3", block),
        level2_slots: slotsFor("l2", block),
        level1_slots: slotsFor("l1", block),
        spare: block.spare,
        level3_last_alerted_at: l3Alerted,
        level2_last_alerted_at: l2Alerted,
        level1_last_alerted_at: l1Alerted,
        updated_at: nowIso,
      } as any,
      { onConflict: "id" },
    );

    if (!flipped.length) return;


    const shiftLabel = shift === "day" ? "Day shift" : "Night shift";
    const prefKey: Record<FlippedLevel, "notify_capacity_l3" | "notify_capacity_l2" | "notify_capacity_l1"> = {
      l3: "notify_capacity_l3",
      l2: "notify_capacity_l2",
      l1: "notify_capacity_l1",
    };

    const prevSpareText =
      prevBlock && prevBlock.spare != null ? `${prevBlock.spare}` : "—";
    const nextSpareText = block.spare != null ? `${block.spare}` : "—";

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
      const summary = messageFor(userLevels, block, prevBlock);
      perUser.push({
        id: p.id,
        body: `${shiftLabel} · ${summary}. Spare nurses ${prevSpareText} → ${nextSpareText} (dependency ${snap.dependency}).`,
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
