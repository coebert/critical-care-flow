// Server-only helper: detect material changes in spare admission capacity
// (per care level going from zero to available or vice versa for the current
// shift) and fan out a persistent in-app alert + best-effort push.
//
// Uses the SAME inputs and calculation as every capacity surface
// (`deriveUnitCapacity` in unit-capacity.ts): the signed ICU Handover Hub
// roster, CCC patient acuity, and the current shift's nurse staffing.
//
// FAIL CLOSED — no state change, no notification and no push when:
//   - the Hub board failed, is indeterminate, or its snapshot is stale or
//     in the future (checked again right before the claim);
//   - acuity / staffing / previous-state / recipient reads fail;
//   - the atomic claim procedure is unavailable or the state moved on.
//
// The state transition and the in-app notifications are persisted in ONE
// transaction by claim_nurse_capacity_transition (service-role only) with a
// stable event key, so concurrent triggers or retries never duplicate and a
// newer state is never blindly replayed. External push is best effort and
// never promised exactly-once: attempted/delivered/failed counts are
// recorded against the event and reported back.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { sendPushToMany } from "./push.server";
import { currentShift as unitCurrentShift, shiftKeyString, type Shift } from "./shift-clock";
import { STALE_AFTER_MS, availableNursesFor, deriveUnitCapacity, type AcuityRow } from "./unit-capacity";
import {
  MAX_FUTURE_SKEW_MS,
  sourceTimeOf,
  type PartnerBedBoardOk,
  type PartnerBedBoardResult,
} from "./partner-bed-board-contract";

type Admin = SupabaseClient<Database>;

/** Re-exported for existing callers; Europe/London, see shift-clock.ts. */
export function currentShift(now: Date = new Date()): { date: string; shift: Shift } {
  return unitCurrentShift(now);
}

export type CapacityAlertDeps = {
  /** Signed partner fetch; injectable for tests. */
  fetchBoard?: () => Promise<PartnerBedBoardResult>;
  sendPush?: typeof sendPushToMany;
  /** Wall clock used for freshness checks (defaults to Date.now). */
  clock?: () => number;
};

export type PushDelivery = { attempted: number; delivered: number; failed: number; recorded: boolean };

export type CapacityAlertOutcome =
  | { kind: "suppressed"; reason: string }
  | { kind: "no_change" }
  | { kind: "lost_race" }
  | { kind: "state_updated" }
  | {
      kind: "alerted";
      levels: FlippedLevel[];
      recipients: number;
      notifications_inserted: number;
      event_key: string;
      push: PushDelivery;
    }
  | { kind: "error" };

/** Inputs older than this (or Hub snapshots in the future beyond skew) never alert. */
export const ALERT_INPUT_MAX_AGE_MS = STALE_AFTER_MS;

function boardTimeProblem(board: PartnerBedBoardOk, nowMs: number): string | null {
  const t = Date.parse(sourceTimeOf(board));
  if (!Number.isFinite(t)) return "board_time_invalid";
  if (t - nowMs > MAX_FUTURE_SKEW_MS) return "board_time_future";
  if (nowMs - t > ALERT_INPUT_MAX_AGE_MS) return "board_stale";
  return null;
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




type ClaimResult = { claimed: boolean; reason?: string; notifications_inserted?: number };

/**
 * Recompute current spare capacity and, if it flips a per-level available
 * flag versus the last stored state, atomically claim the transition and
 * persist in-app notifications, then attempt push.
 * Safe to call from any bed / staffing / acuity mutation; never throws.
 */
export async function checkAndAlertNurseCapacity(
  admin: Admin,
  now: Date = new Date(),
  deps: CapacityAlertDeps = {},
): Promise<CapacityAlertOutcome> {
  const clock = deps.clock ?? (() => Date.now());
  const suppressed = (reason: string): CapacityAlertOutcome => {
    console.info(`[nurse-capacity-alerts] suppressed (${reason})`);
    return { kind: "suppressed", reason };
  };
  try {
    const { date, shift } = currentShift(now);
    const shiftKey = shiftKeyString({ date, shift });
    const sendPush = deps.sendPush ?? sendPushToMany;
    const fetchBoard =
      deps.fetchBoard ??
      (async () => {
        const { fetchPartnerBedBoardSigned } = await import("./partner-bed-board.server");
        return fetchPartnerBedBoardSigned();
      });

    const readsStartedAt = clock();
    const [board, acuityRes, staffingRes] = await Promise.all([
      fetchBoard().catch(
        (): PartnerBedBoardResult => ({ ok: false, error: "partner fetch failed", fetched_at: new Date().toISOString() }),
      ),
      admin.from("patient_acuity_overrides").select("partner_patient_id, level, level_recorded, one_to_one"),
      admin.from("nurse_staffing").select("shift, available_nurses").eq("shift_date", date),
    ]);
    if (!board.ok) return suppressed(board.indeterminate ? "board_indeterminate" : "board_unavailable");
    const tp = boardTimeProblem(board, clock());
    if (tp) return suppressed(tp);
    if (acuityRes.error) return suppressed("acuity_unavailable");
    if (staffingRes.error) return suppressed("staffing_unavailable");

    const derivation = deriveUnitCapacity({
      board: { status: "ok", value: board },
      acuity: {
        status: "ok",
        // An unrecorded level is never treated as an observed one.
        value: ((acuityRes.data ?? []) as Array<{ partner_patient_id: string; level: number; level_recorded?: boolean | null; one_to_one: boolean }>).map(
          (r): AcuityRow => ({
            partner_patient_id: r.partner_patient_id,
            level: r.level_recorded === false ? null : r.level,
            one_to_one: r.one_to_one === true,
          }),
        ),
      },
      staffing: { status: "ok", value: availableNursesFor(staffingRes.data ?? [], shift) },
    });

    if (!derivation.determinate || derivation.nursing.state !== "ok") {
      const reason =
        derivation.nursing.state === "unknown"
          ? derivation.nursing.reason
          : derivation.nursing.state === "no_staffing"
            ? "no_staffing"
            : "indeterminate";
      return suppressed(reason);
    }

    const block = derivation.nursing;
    const next = flagsFromSnap(block.spare, block.level3_slots, block.level2_slots, block.level1_slots);

    const { data: prevRow, error: prevErr } = await admin
      .from("nurse_capacity_alert_state")
      .select(
        "shift_key, state_revision, level3_available, level2_available, level1_available, level3_slots, level2_slots, level1_slots, spare, level3_last_alerted_at, level2_last_alerted_at, level1_last_alerted_at" as never,
      )
      .eq("id", true)
      .maybeSingle();
    if (prevErr) return suppressed("state_unavailable");
    const prevAny = (prevRow ?? null) as Record<string, any> | null;
    const expectedRevision = prevAny ? Number(prevAny.state_revision ?? NaN) : 0;
    if (!Number.isSafeInteger(expectedRevision)) return suppressed("state_unavailable");
    const sameShift = !!prevAny && prevAny.shift_key === shiftKey;

    const prev: LevelFlags | null = sameShift
      ? { l3: !!prevAny!.level3_available, l2: !!prevAny!.level2_available, l1: !!prevAny!.level1_available }
      : null;
    const prevBlock = sameShift
      ? {
          level3_slots: prevAny!.level3_slots ?? null,
          level2_slots: prevAny!.level2_slots ?? null,
          level1_slots: prevAny!.level1_slots ?? null,
          spare: prevAny!.spare ?? null,
        }
      : null;
    const lastAlertedAt: Record<FlippedLevel, string | null> = sameShift
      ? {
          l3: prevAny!.level3_last_alerted_at ?? null,
          l2: prevAny!.level2_last_alerted_at ?? null,
          l1: prevAny!.level1_last_alerted_at ?? null,
        }
      : { l3: null, l2: null, l1: null };

    // Dedup window: a level alerted within the window is not re-alerted;
    // state is still advanced so later runs compare against reality.
    const DEDUP_WINDOW_MS = 5 * 60 * 1000;
    const nowMs = now.getTime();
    const withinWindow = (iso: string | null) => !!iso && nowMs - new Date(iso).getTime() < DEDUP_WINDOW_MS;
    const flippedRaw = flippedLevels(prev, next);
    const flipped = flippedRaw.filter((k) => !withinWindow(lastAlertedAt[k]));

    const nowIso = new Date(nowMs).toISOString();
    const nextState = {
      shift_key: shiftKey,
      level3_available: next.l3,
      level2_available: next.l2,
      level1_available: next.l1,
      level3_slots: slotsFor("l3", block),
      level2_slots: slotsFor("l2", block),
      level1_slots: slotsFor("l1", block),
      // Integer column; the exact figure is in the message text.
      spare: Math.floor(block.spare),
      level3_last_alerted_at: flipped.includes("l3") ? nowIso : lastAlertedAt.l3,
      level2_last_alerted_at: flipped.includes("l2") ? nowIso : lastAlertedAt.l2,
      level1_last_alerted_at: flipped.includes("l1") ? nowIso : lastAlertedAt.l1,
    };
    const unchanged =
      sameShift &&
      (["level3_available", "level2_available", "level1_available", "level3_slots", "level2_slots", "level1_slots", "spare"] as const).every(
        (k) => (prevAny![k] ?? null) === (nextState[k] ?? null),
      );
    if (unchanged) return { kind: "no_change" };

    // Recipients are read BEFORE the claim; a failed read fails closed.
    const shiftLabel = shift === "day" ? "Day shift" : "Night shift";
    const perUser: Array<{ id: string; body: string; url: string }> = [];
    if (flipped.length) {
      const { data: profiles, error: profErr } = await admin
        .from("profiles")
        .select("id, is_at_work, notify_capacity, notify_capacity_l3, notify_capacity_l2, notify_capacity_l1")
        .eq("is_at_work", true);
      if (profErr) return suppressed("recipients_unavailable");
      const prefKey: Record<FlippedLevel, "notify_capacity_l3" | "notify_capacity_l2" | "notify_capacity_l1"> = {
        l3: "notify_capacity_l3",
        l2: "notify_capacity_l2",
        l1: "notify_capacity_l1",
      };
      const levelNum: Record<FlippedLevel, 1 | 2 | 3> = { l3: 3, l2: 2, l1: 1 };
      const prevSpareText = prevBlock && prevBlock.spare != null ? `${prevBlock.spare}` : "—";
      const nextSpareText = block.spare != null ? `${block.spare}` : "—";
      for (const p of (profiles ?? []) as Array<Record<string, any>>) {
        if (p.notify_capacity === false) continue;
        const userLevels = flipped.filter((k) => p[prefKey[k]] !== false);
        if (!userLevels.length) continue;
        perUser.push({
          id: String(p.id),
          body: `${shiftLabel} · ${messageFor(userLevels, block, prevBlock)}. Spare nurses ${prevSpareText} → ${nextSpareText} (dependency ${block.dependency}).`,
          url: `/bed-board?focus_shift=${shift}&focus_level=${levelNum[userLevels[0]]}`,
        });
      }
    }

    // Re-check freshness of every input right before claiming.
    const claimAt = clock();
    const tp2 = boardTimeProblem(board, claimAt);
    if (tp2) return suppressed(tp2);
    if (claimAt - readsStartedAt > ALERT_INPUT_MAX_AGE_MS) return suppressed("inputs_stale");

    // Stable identity: this exact transition from this exact stored revision.
    const eventKey = flipped.length
      ? `capacity:${shiftKey}:r${expectedRevision}:${flipped.join("+")}:${next.l3 ? 1 : 0}${next.l2 ? 1 : 0}${next.l1 ? 1 : 0}`
      : null;
    const { data: claimData, error: claimErr } = await (admin as unknown as {
      rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { code?: string } | null }>;
    }).rpc("claim_nurse_capacity_transition", {
      _expected_revision: expectedRevision,
      _state: nextState,
      _event_key: eventKey,
      _levels: flipped,
      _notifications: perUser.map((u) => ({ user_id: u.id, message: u.body })),
    });
    if (claimErr) return suppressed(claimErr.code === "PGRST202" || claimErr.code === "42883" ? "claim_unavailable" : "claim_failed");
    const claim = (claimData ?? {}) as ClaimResult;
    if (claim.claimed !== true) return { kind: "lost_race" };
    if (!eventKey) return { kind: "state_updated" };

    // Best-effort push AFTER the durable claim. Never exactly-once.
    const push: PushDelivery = { attempted: 0, delivered: 0, failed: 0, recorded: false };
    if (perUser.length) {
      const byUser = new Map(perUser.map((u) => [u.id, u]));
      const { data: subs, error: subsErr } = await admin
        .from("push_subscriptions")
        .select("user_id, endpoint, p256dh, auth")
        .in("user_id", perUser.map((u) => u.id));
      if (!subsErr && subs && subs.length) {
        const goneEndpoints: string[] = [];
        const groups = new Map<string, { body: string; url: string; subs: typeof subs }>();
        for (const s of subs) {
          const u = byUser.get(s.user_id);
          if (!u) continue;
          const key = `${u.url}\n${u.body}`;
          const g = groups.get(key) ?? { body: u.body, url: u.url, subs: [] as typeof subs };
          g.subs.push(s);
          groups.set(key, g);
        }
        for (const [, group] of groups) {
          push.attempted += group.subs.length;
          try {
            const res = await sendPush(
              group.subs.map((s) => ({ user_id: s.user_id, endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth })),
              { title: `Radnor Critical Care — ${shiftLabel} capacity`, body: group.body, url: group.url, tag: eventKey },
            );
            const ok = (res.results ?? []).filter((r) => r.ok).length;
            push.delivered += ok;
            push.failed += group.subs.length - ok;
            goneEndpoints.push(...res.goneEndpoints);
          } catch {
            push.failed += group.subs.length;
          }
        }
        if (goneEndpoints.length) {
          await admin.from("push_subscriptions").delete().in("endpoint", goneEndpoints);
        }
      } else if (subsErr) {
        push.failed = perUser.length; // could not even look up devices
      }
    }
    const { error: recErr } = await (admin as unknown as {
      rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
    }).rpc("record_capacity_alert_delivery", {
      _event_key: eventKey,
      _attempted: push.attempted,
      _delivered: push.delivered,
      _failed: push.failed,
    });
    push.recorded = !recErr;

    return {
      kind: "alerted",
      levels: flipped,
      recipients: perUser.length,
      notifications_inserted: Number(claim.notifications_inserted ?? 0),
      event_key: eventKey,
      push,
    };
  } catch {
    console.error("[nurse-capacity-alerts] failed");
    return { kind: "error" };
  }
}
