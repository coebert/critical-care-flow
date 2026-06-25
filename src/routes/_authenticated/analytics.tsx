import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CalendarIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DateRange } from "react-day-picker";
import type { Tables } from "@/integrations/supabase/types";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid,
  BarChart, Bar, PieChart, Pie, Cell, Legend, AreaChart, Area,
} from "recharts";
import {
  format, subDays, startOfDay, endOfDay, differenceInMinutes,
  differenceInCalendarDays, eachDayOfInterval,
} from "date-fns";
import { ADMISSION_URGENCY_LABELS } from "@/lib/admission-urgency";

type Referral = Tables<"referrals">;

export const Route = createFileRoute("/_authenticated/analytics")({
  head: () => ({ meta: [{ title: "Analytics — SDH Critical Care" }] }),
  component: AnalyticsPage,
});

const COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];

function AnalyticsPage() {
  const [rows, setRows] = useState<Referral[]>([]);
  const [range, setRange] = useState<DateRange>(() => ({
    from: startOfDay(subDays(new Date(), 29)),
    to: endOfDay(new Date()),
  }));

  const from = range.from ? startOfDay(range.from) : startOfDay(subDays(new Date(), 29));
  const to = range.to ? endOfDay(range.to) : endOfDay(range.from ?? new Date());
  const days = Math.max(1, differenceInCalendarDays(to, from) + 1);

  useEffect(() => {
    supabase
      .from("referrals")
      .select("*")
      .is("deleted_at", null)
      .gte("referral_received_at", from.toISOString())
      .lte("referral_received_at", to.toISOString())
      .limit(5000)
      .then(({ data }) => setRows(data ?? []));
  }, [from.getTime(), to.getTime()]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      const t = new Date(r.referral_received_at).getTime();
      return t >= from.getTime() && t <= to.getTime();
    });
  }, [rows, from, to]);

  const dayKeys = useMemo(
    () => eachDayOfInterval({ start: from, end: to }).map((d) => format(d, "yyyy-MM-dd")),
    [from, to]
  );

  const perDay = useMemo(() => {
    const map = new Map<string, number>(dayKeys.map((k) => [k, 0]));
    filtered.forEach((r) => {
      const k = format(startOfDay(new Date(r.referral_received_at)), "yyyy-MM-dd");
      if (map.has(k)) map.set(k, (map.get(k) ?? 0) + 1);
    });
    return Array.from(map.entries()).map(([date, count]) => ({ date: format(new Date(date), "dd MMM"), count }));
  }, [filtered, dayKeys]);

  const meanPer24h = filtered.length / Math.max(days, 1);
  const meanAge = (() => {
    const ages = filtered.map((r) => r.age).filter((x): x is number => x != null);
    return ages.length ? ages.reduce((a, b) => a + b, 0) / ages.length : 0;
  })();

  const bySpecialty = useMemo(() => {
    const map = new Map<string, number>();
    filtered.forEach((r) => {
      const k = r.referring_specialty || "Unknown";
      map.set(k, (map.get(k) ?? 0) + 1);
    });
    return Array.from(map.entries())
      .map(([specialty, count]) => ({ specialty, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  }, [filtered]);

  const byStatus = useMemo(() => {
    const map = new Map<string, number>();
    filtered.forEach((r) => map.set(r.status, (map.get(r.status) ?? 0) + 1));
    return Array.from(map.entries()).map(([name, value]) => ({ name, value }));
  }, [filtered]);

  const bySex = useMemo(() => {
    const map = new Map<string, number>();
    filtered.forEach((r) => map.set(r.sex ?? "unknown", (map.get(r.sex ?? "unknown") ?? 0) + 1));
    return Array.from(map.entries()).map(([name, value]) => ({ name, value }));
  }, [filtered]);

  const byUrgency = useMemo(() => {
    const map = new Map<string, number>();
    filtered.forEach((r) => {
      const k = r.admission_urgency ? ADMISSION_URGENCY_LABELS[r.admission_urgency] : "Not set";
      map.set(k, (map.get(k) ?? 0) + 1);
    });
    // Preserve defined order then append "Not set" last
    const order = [...Object.values(ADMISSION_URGENCY_LABELS), "Not set"];
    return order
      .filter((label) => map.has(label))
      .map((label) => ({ urgency: label, count: map.get(label)! }));
  }, [filtered]);

  const urgencyKeys = useMemo(
    () => [...Object.values(ADMISSION_URGENCY_LABELS), "Not set"],
    []
  );

  const perDayByUrgency = useMemo(() => {
    const buckets = new Map<string, Record<string, number>>(
      dayKeys.map((k) => {
        const row: Record<string, number> = {};
        urgencyKeys.forEach((u) => (row[u] = 0));
        return [k, row];
      })
    );
    filtered.forEach((r) => {
      const k = format(startOfDay(new Date(r.referral_received_at)), "yyyy-MM-dd");
      const label = r.admission_urgency ? ADMISSION_URGENCY_LABELS[r.admission_urgency] : "Not set";
      const row = buckets.get(k);
      if (row) row[label] = (row[label] ?? 0) + 1;
    });
    return Array.from(buckets.entries()).map(([date, vals]) => ({
      date: format(new Date(date), "dd MMM"),
      ...vals,
    }));
  }, [filtered, dayKeys, urgencyKeys]);

  const meanMinutes = (sel: (r: Referral) => [string | null, string | null]) => {
    const ds = filtered
      .map(sel)
      .map(([a, b]) => (a && b ? differenceInMinutes(new Date(b), new Date(a)) : null))
      .filter((x): x is number => x != null && x >= 0);
    return ds.length ? ds.reduce((a, b) => a + b, 0) / ds.length : 0;
  };
  const meanTimeToSeen = meanMinutes((r) => [r.referral_received_at, r.first_seen_at]);
  const meanDecisionToArrival = meanMinutes((r) => [r.decision_at, r.arrived_on_unit_at]);

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
          <p className="text-sm text-muted-foreground">Last {days} days · {filtered.length} referrals</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          {[7, 30, 90, 365].map((d) => (
            <Button key={d} size="sm" variant={days === d ? "default" : "outline"} onClick={() => setDays(d)}>
              {d}d
            </Button>
          ))}
        </div>
      </div>

      <div className="grid md:grid-cols-4 gap-4 mb-6">
        <Kpi label="Total referrals" value={filtered.length.toString()} />
        <Kpi label="Mean / 24h" value={meanPer24h.toFixed(1)} />
        <Kpi label="Mean age (yrs)" value={meanAge ? meanAge.toFixed(1) : "—"} />
        <Kpi label="Mean time-to-first-seen" value={meanTimeToSeen ? `${Math.round(meanTimeToSeen)} min` : "—"} />
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <Card className="p-5">
          <h2 className="font-semibold mb-3">Referrals over time</h2>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={perDay}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                <XAxis dataKey="date" fontSize={11} />
                <YAxis allowDecimals={false} fontSize={11} />
                <Tooltip />
                <Line type="monotone" dataKey="count" stroke="var(--chart-1)" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="font-semibold mb-3">Outcome breakdown</h2>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={byStatus} dataKey="value" nameKey="name" innerRadius={50} outerRadius={90} label>
                  {byStatus.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie>
                <Legend />
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="font-semibold mb-3">Admission urgency</h2>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={byUrgency}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                <XAxis dataKey="urgency" fontSize={10} angle={-20} textAnchor="end" height={80} interval={0} />
                <YAxis allowDecimals={false} fontSize={11} />
                <Tooltip />
                <Bar dataKey="count" fill="var(--chart-3)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="p-5 md:col-span-2">
          <h2 className="font-semibold mb-3">Referrals over time by urgency</h2>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={perDayByUrgency}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                <XAxis dataKey="date" fontSize={11} />
                <YAxis allowDecimals={false} fontSize={11} />
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {urgencyKeys.map((k, i) => (
                  <Area
                    key={k}
                    type="monotone"
                    dataKey={k}
                    stackId="1"
                    stroke={COLORS[i % COLORS.length]}
                    fill={COLORS[i % COLORS.length]}
                    fillOpacity={0.7}
                  />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="font-semibold mb-3">Urgency counts</h2>
          <ul className="space-y-2 text-sm">
            {byUrgency.map((u) => (
              <li key={u.urgency} className="flex justify-between">
                <span className="text-muted-foreground truncate mr-2" title={u.urgency}>{u.urgency}</span>
                <span className="font-medium shrink-0">{u.count}</span>
              </li>
            ))}
            {byUrgency.length === 0 && (
              <li className="text-muted-foreground">No urgency data for this period.</li>
            )}
          </ul>
        </Card>

        <Card className="p-5 md:col-span-2">
          <h2 className="font-semibold mb-3">Referrals by specialty (top 10)</h2>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={bySpecialty}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                <XAxis dataKey="specialty" fontSize={11} angle={-15} textAnchor="end" height={70} />
                <YAxis allowDecimals={false} fontSize={11} />
                <Tooltip />
                <Bar dataKey="count" fill="var(--chart-2)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="font-semibold mb-3">Sex distribution</h2>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={bySex} dataKey="value" nameKey="name" outerRadius={80} label>
                  {bySex.map((_, i) => <Cell key={i} fill={COLORS[(i + 1) % COLORS.length]} />)}
                </Pie>
                <Legend />
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="font-semibold mb-3">Process times</h2>
          <ul className="space-y-3 text-sm">
            <li className="flex justify-between"><span className="text-muted-foreground">Mean referral → first seen</span><span className="font-medium">{meanTimeToSeen ? `${Math.round(meanTimeToSeen)} min` : "—"}</span></li>
            <li className="flex justify-between"><span className="text-muted-foreground">Mean decision → on unit</span><span className="font-medium">{meanDecisionToArrival ? `${Math.round(meanDecisionToArrival)} min` : "—"}</span></li>
            <li className="flex justify-between"><span className="text-muted-foreground">Admitted</span><span className="font-medium">{byStatus.find((s) => s.name === "admitted")?.value ?? 0}</span></li>
            <li className="flex justify-between"><span className="text-muted-foreground">Declined</span><span className="font-medium">{byStatus.find((s) => s.name === "declined")?.value ?? 0}</span></li>
            <li className="flex justify-between"><span className="text-muted-foreground">Pending</span><span className="font-medium">{byStatus.find((s) => s.name === "pending")?.value ?? 0}</span></li>
          </ul>
        </Card>
      </div>
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <Card className="p-5">
      <div className="text-xs text-muted-foreground uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
    </Card>
  );
}
