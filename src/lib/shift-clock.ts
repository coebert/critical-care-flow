/**
 * Single source of truth for "which nursing shift is it now?".
 *
 * The unit runs on UK civil time (Europe/London, GMT/BST):
 *   - Day shift   08:00–19:59 local → shift_date = today
 *   - Night shift 20:00–23:59 local → shift_date = today
 *   - Night shift 00:00–07:59 local → shift_date = the PREVIOUS calendar date
 *     (it is the night shift that started the evening before)
 *
 * Every capacity surface (bed board, TV board, referral badge/callout, mini
 * link) and the server-side capacity alerts must use these helpers so they
 * agree across midnight and the GMT/BST changeovers, regardless of the
 * browser's or the Worker's own time zone.
 */

export const UNIT_TIME_ZONE = "Europe/London";

export type Shift = "day" | "night";
export type ShiftKey = { date: string; shift: Shift };

export const DAY_SHIFT_START_HOUR = 8;
export const NIGHT_SHIFT_START_HOUR = 20;

const partsFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: UNIT_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** Wall-clock parts of `now` in Europe/London. */
export function londonParts(now: Date): { y: number; m: number; d: number; h: number; min: number } {
  const parts: Record<string, string> = {};
  for (const p of partsFmt.formatToParts(now)) parts[p.type] = p.value;
  const h = Number(parts.hour) % 24; // some engines emit "24" for midnight
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    h,
    min: Number(parts.minute),
  };
}

function iso(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Calendar arithmetic on a YYYY-MM-DD string (time-zone free). */
export function addDaysIso(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Today's calendar date in Europe/London (YYYY-MM-DD). */
export function londonDateIso(now: Date = new Date()): string {
  const p = londonParts(now);
  return iso(p.y, p.m, p.d);
}

/** The nursing shift in progress at `now`, keyed by its staffing date. */
export function currentShift(now: Date = new Date()): ShiftKey {
  const p = londonParts(now);
  const today = iso(p.y, p.m, p.d);
  if (p.h >= DAY_SHIFT_START_HOUR && p.h < NIGHT_SHIFT_START_HOUR) {
    return { date: today, shift: "day" };
  }
  if (p.h >= NIGHT_SHIFT_START_HOUR) return { date: today, shift: "night" };
  return { date: addDaysIso(today, -1), shift: "night" };
}

/** The shift that follows `k` (day D → night D → day D+1). */
export function nextShift(k: ShiftKey): ShiftKey {
  return k.shift === "day"
    ? { date: k.date, shift: "night" }
    : { date: addDaysIso(k.date, 1), shift: "day" };
}

export function shiftKeyString(k: ShiftKey): string {
  return `${k.date}#${k.shift}`;
}

export function shiftHoursLabel(shift: Shift): string {
  return shift === "day" ? "08:00–20:00" : "20:00–08:00";
}

/** "Day shift" / "Night shift". */
export function shiftName(shift: Shift): string {
  return shift === "day" ? "Day shift" : "Night shift";
}

/** YYYY-MM-DD → dd/MM/yyyy (UK ordering, no time-zone conversion). */
export function formatShiftDate(date: string): string {
  const [y, m, d] = date.split("-");
  return `${d}/${m}/${y}`;
}

const timeFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: UNIT_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
/** HH:mm in unit time; prefixes dd/MM when not on the same London day as `now`. */
export function formatUnitTime(isoTs: string | null | undefined, now: Date = new Date()): string {
  if (!isoTs) return "—";
  const t = new Date(isoTs);
  if (!Number.isFinite(t.getTime())) return "—";
  if (londonDateIso(t) === londonDateIso(now)) return timeFmt.format(t);
  // Build from parts so the separator doesn't depend on the ICU version.
  const p = londonParts(t);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(p.d)}/${two(p.m)} ${two(p.h)}:${two(p.min)}`;
}
