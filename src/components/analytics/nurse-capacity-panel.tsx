import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid,
  Legend, AreaChart, Area, ReferenceLine,
} from "recharts";
import { format, subDays, startOfDay, endOfDay } from "date-fns";
import type { DateRange } from "react-day-picker";

import { Card } from "@/components/ui/card";
import { DateRangePicker } from "@/components/date-range-picker";
import { Kpi } from "@/components/analytics/kpi";
import { getNurseCapacityAnalytics } from "@/lib/nurse-staffing.functions";

function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function NurseCapacityAnalyticsPanel() {
  const [range, setRange] = useState<DateRange>(() => ({
    from: startOfDay(subDays(new Date(), 29)),
    to: endOfDay(new Date()),
  }));
  const from = range.from ? startOfDay(range.from) : startOfDay(subDays(new Date(), 29));
  const to = range.to ? endOfDay(range.to) : endOfDay(range.from ?? new Date());
  const fromKey = fmtDate(from);
  const toKey = fmtDate(to);

  const fetchSeries = useServerFn(getNurseCapacityAnalytics);
  const { data, isLoading, error } = useQuery({
    queryKey: ["analytics", "nurse-capacity", fromKey, toKey],
    queryFn: () => fetchSeries({ data: { from: fromKey, to: toKey } }),
  });

  const series = data ?? [];

  const chartData = useMemo(
    () =>
      series.map((p) => ({
        date: p.date,
        label: format(new Date(`${p.date}T00:00:00`), "d MMM"),
        nurses_day: p.nurses_day,
        nurses_night: p.nurses_night,
        dependency_day: p.dependency_day,
        dependency_night: p.dependency_night,
        spare_day: p.spare_day,
        spare_night: p.spare_night,
      })),
    [series],
  );

  // KPI summaries (over the recorded days only)
  const kpis = useMemo(() => {
    const withDay = series.filter((p) => p.nurses_day != null);
    const withNight = series.filter((p) => p.nurses_night != null);
    const spareVals = [
      ...series.map((p) => p.spare_day),
      ...series.map((p) => p.spare_night),
    ].filter((v): v is number => v != null);
    const dependencyVals = series.flatMap((p) => [p.dependency_day, p.dependency_night]);
    const avg = (xs: number[]) =>
      xs.length === 0 ? 0 : Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100;
    return {
      avgNursesDay: avg(withDay.map((p) => p.nurses_day!)),
      avgNursesNight: avg(withNight.map((p) => p.nurses_night!)),
      avgDependency: avg(dependencyVals),
      avgSpare: avg(spareVals),
      undercapacityShifts: spareVals.filter((v) => v < 0).length,
      recordedShifts: withDay.length + withNight.length,
      totalShifts: series.length * 2,
    };
  }, [series]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <DateRangePicker value={range} onChange={(r) => r && setRange(r)} />
        <div className="text-xs text-muted-foreground">
          Dependency is sampled at 12:00 (day) and 24:00 (night) using each patient's current level of care.
        </div>
      </div>

      {error && (
        <div className="text-sm text-destructive" role="alert">
          {error instanceof Error ? error.message : "Failed to load analytics"}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="Avg nurses (day)" value={kpis.avgNursesDay.toFixed(1)} />
        <Kpi label="Avg nurses (night)" value={kpis.avgNursesNight.toFixed(1)} />
        <Kpi label="Avg dependency" value={kpis.avgDependency.toFixed(2)} />
        <Kpi
          label="Avg spare capacity"
          value={kpis.avgSpare.toFixed(2)}
          tone={kpis.avgSpare < 0 ? "danger" : kpis.avgSpare < 1 ? "warn" : "ok"}
        />
      </div>

      <div className="text-xs text-muted-foreground">
        {kpis.recordedShifts} of {kpis.totalShifts} shifts have recorded nurse counts.
        {kpis.undercapacityShifts > 0 && (
          <>
            {" · "}
            <span className="text-destructive font-medium">
              {kpis.undercapacityShifts} shift{kpis.undercapacityShifts === 1 ? "" : "s"} below safe nursing capacity.
            </span>
          </>
        )}
      </div>

      <Card className="p-4">
        <div className="mb-2 text-sm font-medium">Nurse availability</div>
        {isLoading ? (
          <div className="h-64 flex items-center justify-center text-sm text-muted-foreground">Loading…</div>
        ) : (
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
                <Tooltip contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)" }} />
                <Legend />
                <Line type="monotone" dataKey="nurses_day" name="Day shift" stroke="var(--chart-1)" strokeWidth={2} dot={false} connectNulls />
                <Line type="monotone" dataKey="nurses_night" name="Night shift" stroke="var(--chart-2)" strokeWidth={2} dot={false} connectNulls />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      <Card className="p-4">
        <div className="mb-2 text-sm font-medium">Unit dependency (nurses required)</div>
        {isLoading ? (
          <div className="h-64 flex items-center justify-center text-sm text-muted-foreground">Loading…</div>
        ) : (
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)" }} />
                <Legend />
                <Line type="monotone" dataKey="dependency_day" name="Day (12:00)" stroke="var(--chart-3)" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="dependency_night" name="Night (00:00)" stroke="var(--chart-4)" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      <Card className="p-4">
        <div className="mb-2 text-sm font-medium">Spare admission capacity (nurses)</div>
        {isLoading ? (
          <div className="h-64 flex items-center justify-center text-sm text-muted-foreground">Loading…</div>
        ) : (
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="spareDay" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.6} />
                    <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.05} />
                  </linearGradient>
                  <linearGradient id="spareNight" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--chart-2)" stopOpacity={0.6} />
                    <stop offset="100%" stopColor="var(--chart-2)" stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <ReferenceLine y={0} stroke="var(--destructive)" strokeDasharray="4 2" />
                <Tooltip contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)" }} />
                <Legend />
                <Area type="monotone" dataKey="spare_day" name="Day spare" stroke="var(--chart-1)" fill="url(#spareDay)" connectNulls />
                <Area type="monotone" dataKey="spare_night" name="Night spare" stroke="var(--chart-2)" fill="url(#spareNight)" connectNulls />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>
    </div>
  );
}
