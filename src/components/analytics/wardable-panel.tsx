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
  BarChart,
  Bar,
} from "recharts";
import { format, subDays, startOfDay, endOfDay } from "date-fns";
import type { DateRange } from "react-day-picker";

import { Card } from "@/components/ui/card";
import { DateRangePicker } from "@/components/date-range-picker";
import { Kpi } from "@/components/analytics/kpi";
import { getWardableAnalytics } from "@/lib/wardable-analytics.functions";

function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fmtHours(h: number | null): string {
  if (h == null) return "—";
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

export function WardableAnalyticsPanel() {
  const [range, setRange] = useState<DateRange>(() => ({
    from: startOfDay(subDays(new Date(), 29)),
    to: endOfDay(new Date()),
  }));
  const from = range.from ? startOfDay(range.from) : startOfDay(subDays(new Date(), 29));
  const to = range.to ? endOfDay(range.to) : endOfDay(range.from ?? new Date());
  const fromKey = fmtDate(from);
  const toKey = fmtDate(to);

  const fetchData = useServerFn(getWardableAnalytics);
  const { data, isLoading, error } = useQuery({
    queryKey: ["analytics", "wardable", fromKey, toKey],
    queryFn: () => fetchData({ data: { from: fromKey, to: toKey } }),
  });

  const daily = useMemo(
    () =>
      (data?.daily ?? []).map((p) => ({
        ...p,
        label: format(new Date(`${p.date}T00:00:00`), "d MMM"),
      })),
    [data?.daily],
  );

  const bySpecialty = data?.bySpecialty ?? [];
  const distribution = data?.distribution ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <DateRangePicker range={range} onChange={setRange} presets={[7, 30, 90, 365]} />
        <div className="text-xs text-muted-foreground">
          Elapsed time from a patient being marked wardable to the discharge action being recorded.
        </div>
      </div>

      {error && (
        <div className="text-sm text-destructive" role="alert">
          {error instanceof Error ? error.message : "Failed to load analytics"}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Kpi label="Discharges (period)" value={String(data?.totalCompleted ?? 0)} />
        <Kpi label="Currently wardable" value={String(data?.openCount ?? 0)} />
        <Kpi label="Median wait" value={fmtHours(data?.medianHours ?? null)} />
        <Kpi label="Mean wait" value={fmtHours(data?.meanHours ?? null)} />
        <Kpi label="P90 wait" value={fmtHours(data?.p90Hours ?? null)} />
      </div>

      <Card className="p-4">
        <div className="mb-2 text-sm font-medium">Wardable-to-discharge over time</div>
        {isLoading ? (
          <div className="h-64 flex items-center justify-center text-sm text-muted-foreground">Loading…</div>
        ) : daily.every((d) => d.count === 0) ? (
          <div className="h-64 flex items-center justify-center text-sm text-muted-foreground">
            No completed wardable-to-discharge episodes in this window yet.
          </div>
        ) : (
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={daily} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                <YAxis
                  yAxisId="left"
                  tick={{ fontSize: 12 }}
                  label={{ value: "Hours", angle: -90, position: "insideLeft", fontSize: 12 }}
                />
                <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 12 }} allowDecimals={false} />
                <Tooltip contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)" }} />
                <Legend />
                <Line yAxisId="left" type="monotone" dataKey="medianHours" name="Median hours" stroke="var(--chart-1)" strokeWidth={2} dot={false} />
                <Line yAxisId="left" type="monotone" dataKey="meanHours" name="Mean hours" stroke="var(--chart-2)" strokeWidth={2} dot={false} />
                <Line yAxisId="right" type="monotone" dataKey="count" name="Discharges" stroke="var(--chart-3)" strokeWidth={1.5} strokeDasharray="4 3" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      <Card className="p-4">
        <div className="mb-2 text-sm font-medium">Duration distribution</div>
        {isLoading ? (
          <div className="h-64 flex items-center justify-center text-sm text-muted-foreground">Loading…</div>
        ) : distribution.every((d) => d.count === 0) ? (
          <div className="h-64 flex items-center justify-center text-sm text-muted-foreground">
            No episodes in this window.
          </div>
        ) : (
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={distribution} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="bucket" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
                <Tooltip contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)" }} />
                <Bar dataKey="count" name="Episodes" fill="var(--chart-1)" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      <Card className="p-4">
        <div className="mb-2 text-sm font-medium">By referring specialty</div>
        {isLoading ? (
          <div className="h-64 flex items-center justify-center text-sm text-muted-foreground">Loading…</div>
        ) : bySpecialty.length === 0 ? (
          <div className="h-32 flex items-center justify-center text-sm text-muted-foreground">
            No specialty data available for this window.
          </div>
        ) : (
          <>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={bySpecialty}
                  layout="vertical"
                  margin={{ top: 8, right: 16, left: 40, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis type="number" tick={{ fontSize: 12 }} />
                  <YAxis
                    type="category"
                    dataKey="specialty"
                    tick={{ fontSize: 12 }}
                    width={140}
                  />
                  <Tooltip contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)" }} />
                  <Legend />
                  <Bar dataKey="medianHours" name="Median hours" fill="var(--chart-1)" />
                  <Bar dataKey="p90Hours" name="P90 hours" fill="var(--chart-3)" />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr className="text-left">
                    <th className="py-1 pr-3">Specialty</th>
                    <th className="py-1 pr-3 text-right">Episodes</th>
                    <th className="py-1 pr-3 text-right">Median</th>
                    <th className="py-1 pr-3 text-right">Mean</th>
                    <th className="py-1 text-right">P90</th>
                  </tr>
                </thead>
                <tbody>
                  {bySpecialty.map((s) => (
                    <tr key={s.specialty} className="border-t border-border/60">
                      <td className="py-1 pr-3">{s.specialty}</td>
                      <td className="py-1 pr-3 text-right tabular-nums">{s.count}</td>
                      <td className="py-1 pr-3 text-right tabular-nums">{fmtHours(s.medianHours)}</td>
                      <td className="py-1 pr-3 text-right tabular-nums">{fmtHours(s.meanHours)}</td>
                      <td className="py-1 text-right tabular-nums">{fmtHours(s.p90Hours)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
