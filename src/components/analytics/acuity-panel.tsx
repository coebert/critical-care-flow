import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
  AreaChart,
  Area,
  BarChart,
  Bar,
} from "recharts";
import { format, subDays, startOfDay, endOfDay } from "date-fns";
import type { DateRange } from "react-day-picker";

import { Card } from "@/components/ui/card";
import { DateRangePicker } from "@/components/date-range-picker";
import { Kpi } from "@/components/analytics/kpi";
import { getAcuityAnalytics } from "@/lib/acuity-analytics.functions";

function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function AcuityAnalyticsPanel() {
  const [range, setRange] = useState<DateRange>(() => ({
    from: startOfDay(subDays(new Date(), 29)),
    to: endOfDay(new Date()),
  }));
  const from = range.from ? startOfDay(range.from) : startOfDay(subDays(new Date(), 29));
  const to = range.to ? endOfDay(range.to) : endOfDay(range.from ?? new Date());
  const fromKey = fmtDate(from);
  const toKey = fmtDate(to);

  const fetchSeries = useServerFn(getAcuityAnalytics);
  const { data, isLoading, error } = useQuery({
    queryKey: ["analytics", "acuity", fromKey, toKey],
    queryFn: () => fetchSeries({ data: { from: fromKey, to: toKey } }),
  });

  const series = data ?? [];

  const chartData = useMemo(
    () =>
      series.map((p) => ({
        ...p,
        label: format(new Date(`${p.date}T00:00:00`), "d MMM"),
      })),
    [series],
  );

  const kpis = useMemo(() => {
    const totalScored = series.reduce((a, p) => a + p.scored, 0);
    const meanVals = series.map((p) => p.meanAcuity).filter((v): v is number => v != null);
    const meanOverall =
      meanVals.length === 0
        ? null
        : Math.round((meanVals.reduce((a, b) => a + b, 0) / meanVals.length) * 100) / 100;
    const peakPatients = series.reduce((a, p) => Math.max(a, p.patientsScored), 0);
    const latest = series[series.length - 1];
    return {
      totalScored,
      meanOverall,
      peakPatients,
      latestMean: latest?.meanAcuity ?? null,
      latestPatients: latest?.patientsScored ?? 0,
    };
  }, [series]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <DateRangePicker range={range} onChange={setRange} presets={[7, 30, 90, 365]} />
        <div className="text-xs text-muted-foreground">
          End-of-day state is reconstructed from every acuity change plus a nightly snapshot.
        </div>
      </div>

      {error && (
        <div className="text-sm text-destructive" role="alert">
          {error instanceof Error ? error.message : "Failed to load analytics"}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="Scoring events" value={String(kpis.totalScored)} />
        <Kpi
          label="Mean acuity (period)"
          value={kpis.meanOverall == null ? "—" : kpis.meanOverall.toFixed(2)}
        />
        <Kpi
          label="Latest mean acuity"
          value={kpis.latestMean == null ? "—" : kpis.latestMean.toFixed(2)}
        />
        <Kpi label="Peak scored patients" value={String(kpis.peakPatients)} />
      </div>

      <Card className="p-4">
        <div className="mb-2 text-sm font-medium">Referrals scored per day</div>
        {isLoading ? (
          <div className="h-64 flex items-center justify-center text-sm text-muted-foreground">Loading…</div>
        ) : series.length === 0 ? (
          <div className="h-64 flex items-center justify-center text-sm text-muted-foreground">
            No acuity data in this window yet.
          </div>
        ) : (
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
                <Tooltip contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)" }} />
                <Bar dataKey="scored" name="Scored" fill="var(--chart-1)" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      <Card className="p-4">
        <div className="mb-2 text-sm font-medium">Patients at each level (end of day)</div>
        {isLoading ? (
          <div className="h-64 flex items-center justify-center text-sm text-muted-foreground">Loading…</div>
        ) : series.length === 0 ? (
          <div className="h-64 flex items-center justify-center text-sm text-muted-foreground">
            No acuity data in this window yet.
          </div>
        ) : (
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} stackOffset="none">
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
                <Tooltip contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)" }} />
                <Legend />
                <Area type="monotone" dataKey="l0" stackId="lvl" name="Level 0" stroke="var(--chart-1)" fill="var(--chart-1)" fillOpacity={0.35} />
                <Area type="monotone" dataKey="l1" stackId="lvl" name="Level 1" stroke="var(--chart-2)" fill="var(--chart-2)" fillOpacity={0.35} />
                <Area type="monotone" dataKey="l2" stackId="lvl" name="Level 2" stroke="var(--chart-3)" fill="var(--chart-3)" fillOpacity={0.35} />
                <Area type="monotone" dataKey="l3" stackId="lvl" name="Level 3" stroke="var(--chart-4)" fill="var(--chart-4)" fillOpacity={0.35} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      <Card className="p-4">
        <div className="mb-2 text-sm font-medium">Mean unit acuity</div>
        {isLoading ? (
          <div className="h-64 flex items-center justify-center text-sm text-muted-foreground">Loading…</div>
        ) : series.length === 0 ? (
          <div className="h-64 flex items-center justify-center text-sm text-muted-foreground">
            No acuity data in this window yet.
          </div>
        ) : (
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} domain={[0, 3]} />
                <Tooltip contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)" }} />
                <Legend />
                <Line type="monotone" dataKey="meanAcuity" name="Mean level" stroke="var(--chart-2)" strokeWidth={2} dot={false} connectNulls />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>
    </div>
  );
}
