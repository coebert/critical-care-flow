import { useMemo, useState } from "react";
import { endOfDay, format, startOfDay, subDays } from "date-fns";
import type { DateRange } from "react-day-picker";

import { DateRangePicker } from "@/components/date-range-picker";
import { PostopCharts } from "@/components/postop/postop-charts";
import { PostopDrilldown, type Drilldown } from "@/components/postop/postop-drilldown";
import { PostopKpiCards } from "@/components/postop/postop-kpi-cards";
import { usePostopAnalytics } from "@/hooks/use-postop-analytics";
import {
  arrivalHoursOf,
  dayKeyOf,
  LEVEL_LABELS,
  type PostopBookingRow,
} from "@/lib/postop-analytics-utils";

/**
 * Post-op analytics dashboard. This component owns just the date range and
 * drill-down state — data + derivations live in `usePostopAnalytics`,
 * presentation is split into KPI, chart, and drill-down sub-components.
 */
export function PostopAnalyticsPanel() {
  const [range, setRange] = useState<DateRange>(() => ({
    from: startOfDay(subDays(new Date(), 89)),
    to: endOfDay(new Date()),
  }));

  const from = range.from ?? startOfDay(subDays(new Date(), 89));
  const to = range.to ?? range.from ?? new Date();

  const {
    from: clampedFrom,
    to: clampedTo,
    days,
    filtered,
    perDay,
    perDayByLevel,
    byLevel,
    bySex,
    meanAge,
    meanBmi,
    meanPerWeek,
    arrivalStats,
    arrivalBuckets,
  } = usePostopAnalytics(from, to);

  const [drill, setDrill] = useState<Drilldown | null>(null);

  const drillHandlers = useMemo(() => {
    const setBy = (title: string, rows: PostopBookingRow[]) =>
      setDrill({
        title: `${title} — ${rows.length} booking${rows.length === 1 ? "" : "s"}`,
        rows,
      });

    return {
      onDrillDay: (key: string, extraLabel?: string) => {
        const rows = filtered.filter(
          (b) =>
            dayKeyOf(b) === key &&
            (!extraLabel || (b.predicted_level && LEVEL_LABELS[b.predicted_level] === extraLabel)),
        );
        setBy(
          `${extraLabel ? `${extraLabel} · ` : ""}${format(new Date(key), "dd/MM/yyyy")}`,
          rows,
        );
      },
      onDrillLevel: (levelLabel: string) => {
        const key = Object.entries(LEVEL_LABELS).find(([, v]) => v === levelLabel)?.[0];
        const rows = filtered.filter((b) => b.predicted_level === key);
        setBy(levelLabel, rows);
      },
      onDrillSex: (sex: string) => {
        const rows = filtered.filter((b) => (b.sex ?? "unknown") === sex);
        setBy(`Sex: ${sex}`, rows);
      },
      onDrillBucket: (name: string, min: number, max: number) => {
        const rows = filtered.filter((b) => {
          const h = arrivalHoursOf(b);
          return h != null && h >= min && h < max;
        });
        setBy(`Arrival delay ${name}`, rows);
      },
    };
  }, [filtered]);

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
        <p className="text-sm text-muted-foreground">
          {format(clampedFrom, "dd/MM/yyyy")} – {format(clampedTo, "dd/MM/yyyy")} · {days} day
          {days === 1 ? "" : "s"} · {filtered.length} bookings
        </p>
        <DateRangePicker
          range={range}
          onChange={setRange}
          presets={[30, 90, 180, 365]}
          activeDays={days}
        />
      </div>

      <PostopKpiCards
        totalBookings={filtered.length}
        meanPerWeek={meanPerWeek}
        meanAge={meanAge}
        meanBmi={meanBmi}
        arrivalStats={arrivalStats}
      />

      <PostopCharts
        filtered={filtered}
        perDay={perDay}
        perDayByLevel={perDayByLevel}
        byLevel={byLevel}
        bySex={bySex}
        arrivalStats={arrivalStats}
        arrivalBuckets={arrivalBuckets}
        meanAge={meanAge}
        meanBmi={meanBmi}
        meanPerWeek={meanPerWeek}
        {...drillHandlers}
      />

      {drill && <PostopDrilldown drill={drill} onClose={() => setDrill(null)} />}
    </div>
  );
}
