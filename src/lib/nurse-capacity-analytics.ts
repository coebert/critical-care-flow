// Pure aggregation for nurse-capacity analytics.
// Given raw occupancy stays + nurse-staffing rows over a date range,
// produce one row per calendar date with day/night dependency, nurse
// availability, and spare capacity. Reconstructs historical dependency
// from admission/discharge windows using the current stored `level`
// (a best-effort snapshot — level changes over a stay are not tracked
// historically).

import { nurseWeightForLevel } from "./nurse-capacity";

export interface OccupancyStay {
  admitted_at: string;
  discharged_at: string | null;
  level: number | null;
}

export interface StaffingRow {
  shift_date: string; // YYYY-MM-DD
  shift: "day" | "night";
  available_nurses: number;
}

export interface NurseCapacityPoint {
  date: string; // YYYY-MM-DD
  dependency_day: number;
  dependency_night: number;
  nurses_day: number | null;
  nurses_night: number | null;
  spare_day: number | null;
  spare_night: number | null;
}

// Sample the day shift at 12:00 local, night shift at 00:00 local of the
// following day (i.e. the middle of a rough 08-20 / 20-08 rota).
const DAY_SAMPLE_HOUR = 12;
const NIGHT_SAMPLE_HOUR = 0; // next-day 00:00

function dependencyAt(stays: OccupancyStay[], instantMs: number): number {
  let sum = 0;
  for (const s of stays) {
    const start = Date.parse(s.admitted_at);
    if (!isFinite(start) || start > instantMs) continue;
    const end = s.discharged_at ? Date.parse(s.discharged_at) : Infinity;
    if (isFinite(end) && end <= instantMs) continue;
    sum += nurseWeightForLevel(s.level);
  }
  return Math.round(sum * 100) / 100;
}

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function eachDate(fromIso: string, toIso: string): string[] {
  const out: string[] = [];
  const start = new Date(`${fromIso}T00:00:00`);
  const end = new Date(`${toIso}T00:00:00`);
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) return out;
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    out.push(isoDate(d));
  }
  return out;
}

export function aggregateNurseCapacitySeries(input: {
  from: string; // YYYY-MM-DD (inclusive)
  to: string; // YYYY-MM-DD (inclusive)
  stays: OccupancyStay[];
  staffing: StaffingRow[];
}): NurseCapacityPoint[] {
  const dates = eachDate(input.from, input.to);
  const staffingByDateShift = new Map<string, number>();
  for (const r of input.staffing) {
    staffingByDateShift.set(`${r.shift_date}|${r.shift}`, r.available_nurses);
  }

  return dates.map((date) => {
    const [y, m, d] = date.split("-").map(Number);
    const dayInstant = new Date(y, m - 1, d, DAY_SAMPLE_HOUR).getTime();
    const nightInstant = new Date(y, m - 1, d + 1, NIGHT_SAMPLE_HOUR).getTime();

    const dep_day = dependencyAt(input.stays, dayInstant);
    const dep_night = dependencyAt(input.stays, nightInstant);
    const nurses_day = staffingByDateShift.get(`${date}|day`) ?? null;
    const nurses_night = staffingByDateShift.get(`${date}|night`) ?? null;

    return {
      date,
      dependency_day: dep_day,
      dependency_night: dep_night,
      nurses_day,
      nurses_night,
      spare_day: nurses_day == null ? null : Math.round((nurses_day - dep_day) * 100) / 100,
      spare_night: nurses_night == null ? null : Math.round((nurses_night - dep_night) * 100) / 100,
    };
  });
}
