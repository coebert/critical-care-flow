import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
import { TriangleAlert } from "lucide-react";
import {
  format, subDays, startOfDay, endOfDay, differenceInMinutes,
  differenceInCalendarDays, eachDayOfInterval,
} from "date-fns";
import {
  aggregateUrgencyCounts,
  aggregateUrgencyPerDay,
  URGENCY_LEGEND_KEYS,
} from "@/lib/analytics-urgency";
import { SURGICAL_SPECIALTY_LABEL, type SurgicalSpecialty } from "@/lib/surgical-specialties";

type Referral = Tables<"referrals">;

import { AdminOnly } from "@/components/admin-only";

export const Route = createFileRoute("/_authenticated/analytics")({
  head: () => ({ meta: [{ title: "Analytics — SDH Critical Care" }] }),
  component: () => (
    <AdminOnly>
      <AnalyticsPage />
    </AdminOnly>
  ),
});

const COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];

function AnalyticsPage() {
  const [rows, setRows] = useState<Referral[]>([]);
  const [postopBmi, setPostopBmi] = useState<Array<{ surgical_specialty: string | null; bmi: number | null }>>([]);
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

  useEffect(() => {
    supabase
      .from("postop_bookings")
      .select("surgical_specialty,bmi")
      .is("deleted_at", null)
      .gte("created_at", from.toISOString())
      .lte("created_at", to.toISOString())
      .limit(5000)
      .then(({ data }) => setPostopBmi((data ?? []) as Array<{ surgical_specialty: string | null; bmi: number | null }>));
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
    const map = new Map<string, { count: number; ageSum: number; ageN: number; accepted: number; declined: number; pending: number }>();
    filtered.forEach((r) => {
      const k = r.referring_specialty || "Unknown";
      const bucket = map.get(k) ?? { count: 0, ageSum: 0, ageN: 0, accepted: 0, declined: 0, pending: 0 };
      bucket.count += 1;
      if (typeof r.age === "number") { bucket.ageSum += r.age; bucket.ageN += 1; }
      const s = (r.status ?? "").toLowerCase();
      if (s === "accepted" || s === "admitted") bucket.accepted += 1;
      else if (s === "declined") bucket.declined += 1;
      else bucket.pending += 1;
      map.set(k, bucket);
    });
    return Array.from(map.entries())
      .map(([specialty, v]) => ({
        specialty,
        count: v.count,
        meanAge: v.ageN ? v.ageSum / v.ageN : null,
        accepted: v.accepted,
        declined: v.declined,
        pending: v.pending,
      }))
      .sort((a, b) => b.count - a.count);
  }, [filtered]);

  const bySpecialtyTop = useMemo(() => bySpecialty.slice(0, 10), [bySpecialty]);

  const bmiBySpecialtyKey = useMemo(() => {
    const map = new Map<string, { sum: number; n: number }>();
    postopBmi.forEach((b) => {
      if (typeof b.bmi !== "number" || !Number.isFinite(b.bmi)) return;
      const label = b.surgical_specialty
        ? (SURGICAL_SPECIALTY_LABEL[b.surgical_specialty as SurgicalSpecialty] ?? b.surgical_specialty)
        : "Unknown";
      const key = label.trim().toLowerCase();
      const bucket = map.get(key) ?? { sum: 0, n: 0 };
      bucket.sum += b.bmi;
      bucket.n += 1;
      map.set(key, bucket);
    });
    const out = new Map<string, { mean: number; n: number }>();
    map.forEach((v, k) => out.set(k, { mean: v.sum / v.n, n: v.n }));
    return out;
  }, [postopBmi]);

  const lookupBmi = (specialty: string): { mean: number; n: number } | null => {
    const key = specialty.trim().toLowerCase();
    const exact = bmiBySpecialtyKey.get(key);
    if (exact) return exact;
    // Fuzzy: partial match either direction (e.g. "Orthopaedics" ↔ "Orthopaedics / Trauma")
    for (const [k, v] of bmiBySpecialtyKey.entries()) {
      if (k.includes(key) || key.includes(k)) return v;
    }
    return null;
  };


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

  const byUrgency = useMemo(() => aggregateUrgencyCounts(filtered), [filtered]);

  const urgencyKeys = URGENCY_LEGEND_KEYS;

  const perDayByUrgency = useMemo(
    () => aggregateUrgencyPerDay(filtered, dayKeys),
    [filtered, dayKeys]
  );

  const admittedWithConsultant = useMemo(
    () => filtered.filter((r) => r.status === "admitted" && (r.accepting_consultant ?? "").trim()),
    [filtered]
  );

  const admittedMissingConsultant = useMemo(
    () => filtered.filter((r) => r.status === "admitted" && !(r.accepting_consultant ?? "").trim()).length,
    [filtered]
  );

  const admittedConsultants = useMemo(() => {
    const counts = new Map<string, number>();
    admittedWithConsultant.forEach((r) => {
      const name = r.accepting_consultant!.trim();
      counts.set(name, (counts.get(name) ?? 0) + 1);
    });
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name]) => name);
  }, [admittedWithConsultant]);

  const perDayByConsultant = useMemo(() => {
    const map = new Map<string, Record<string, number | string>>(
      dayKeys.map((k) => [
        k,
        { date: format(new Date(k), "dd MMM"), ...Object.fromEntries(admittedConsultants.map((c) => [c, 0])) },
      ])
    );
    admittedWithConsultant.forEach((r) => {
      const name = r.accepting_consultant!.trim();
      if (!admittedConsultants.includes(name)) return;
      const k = format(startOfDay(new Date(r.referral_received_at)), "yyyy-MM-dd");
      const row = map.get(k);
      if (row) row[name] = ((row[name] as number) ?? 0) + 1;
    });
    return Array.from(map.values());
  }, [admittedWithConsultant, dayKeys, admittedConsultants]);

  const consultantTotals = useMemo(
    () =>
      admittedConsultants
        .map((name) => ({
          name,
          count: admittedWithConsultant.filter(
            (r) => r.accepting_consultant!.trim() === name
          ).length,
        }))
        .sort((a, b) => b.count - a.count),
    [admittedConsultants, admittedWithConsultant]
  );

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
          <p className="text-sm text-muted-foreground">
            {format(from, "dd MMM yyyy")} – {format(to, "dd MMM yyyy")} · {days} day{days === 1 ? "" : "s"} · {filtered.length} referrals
          </p>
        </div>
        <div className="flex gap-2 flex-wrap items-center">
          {[7, 30, 90, 365].map((d) => (
            <Button
              key={d}
              size="sm"
              variant={days === d ? "default" : "outline"}
              onClick={() =>
                setRange({ from: startOfDay(subDays(new Date(), d - 1)), to: endOfDay(new Date()) })
              }
            >
              {d}d
            </Button>
          ))}
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={cn("justify-start text-left font-normal", !range.from && "text-muted-foreground")}
              >
                <CalendarIcon className="mr-2 h-4 w-4" />
                {range.from
                  ? range.to
                    ? `${format(range.from, "dd MMM yy")} – ${format(range.to, "dd MMM yy")}`
                    : format(range.from, "dd MMM yy")
                  : "Pick a date range"}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="end">
              <Calendar
                mode="range"
                selected={range}
                onSelect={(r) => r && setRange(r)}
                numberOfMonths={2}
                initialFocus
                className={cn("p-3 pointer-events-auto")}
              />
            </PopoverContent>
          </Popover>
        </div>
      </div>

      <div className="grid md:grid-cols-4 gap-4 mb-6">
        <Kpi label="Total referrals" value={filtered.length.toString()} />
        <Kpi label="Mean / 24h" value={meanPer24h.toFixed(1)} />
        <Kpi label="Mean age (yrs)" value={meanAge ? meanAge.toFixed(1) : "—"} />
        <Kpi label="Mean time-to-first-seen" value={meanTimeToSeen ? `${Math.round(meanTimeToSeen)} min` : "—"} />
      </div>

      {admittedMissingConsultant > 0 && (
        <Card className="mb-6 p-4 border-amber-200 bg-amber-50 dark:bg-amber-950 dark:border-amber-800">
          <div className="flex items-center gap-3">
            <TriangleAlert className="h-5 w-5 text-amber-700 dark:text-amber-300 shrink-0" />
            <div>
              <p className="text-sm font-medium text-amber-900 dark:text-amber-100">
                Data quality issue
              </p>
              <p className="text-sm text-amber-800 dark:text-amber-200">
                {admittedMissingConsultant} admitted referral{admittedMissingConsultant === 1 ? "" : "s"} missing an accepting consultant. These {admittedMissingConsultant === 1 ? "record is" : "records are"} excluded from the consultant chart below.
              </p>
            </div>
            <Badge variant="destructive" className="ml-auto shrink-0">
              {admittedMissingConsultant}
            </Badge>
          </div>
        </Card>
      )}

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
          <div className="flex items-baseline justify-between mb-3 gap-3">
            <h2 className="font-semibold">Referrals by specialty (top 10)</h2>
            <span className="text-xs text-muted-foreground">{bySpecialty.length} total specialties</span>
          </div>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={bySpecialtyTop}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                <XAxis dataKey="specialty" fontSize={11} angle={-15} textAnchor="end" height={70} />
                <YAxis allowDecimals={false} fontSize={11} />
                <Tooltip />
                <Bar dataKey="count" fill="var(--chart-2)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="p-5 md:col-span-2">
          <div className="flex items-baseline justify-between mb-3 gap-3">
            <h2 className="font-semibold">Specialty breakdown</h2>
            <span className="text-xs text-muted-foreground">
              Mean age per specialty. BMI is not captured on referrals — see post-op bookings analytics for BMI.
            </span>
          </div>
          {bySpecialty.length === 0 ? (
            <p className="text-sm text-muted-foreground">No referrals in this period.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs uppercase text-muted-foreground border-b">
                  <tr>
                    <th className="text-left py-2 pr-3">Specialty</th>
                    <th className="text-right py-2 pr-3">Referrals</th>
                    <th className="text-right py-2 pr-3">% of total</th>
                    <th className="text-right py-2 pr-3">Mean age</th>
                    <th className="text-right py-2 pr-3">Accepted</th>
                    <th className="text-right py-2 pr-3">Declined</th>
                    <th className="text-right py-2 pr-3">Pending</th>
                  </tr>
                </thead>
                <tbody>
                  {bySpecialty.map((s) => (
                    <tr key={s.specialty} className="border-b last:border-0 hover:bg-muted/40">
                      <td className="py-2 pr-3 font-medium">{s.specialty}</td>
                      <td className="py-2 pr-3 text-right">{s.count}</td>
                      <td className="py-2 pr-3 text-right">
                        {filtered.length ? ((s.count / filtered.length) * 100).toFixed(1) : "0.0"}%
                      </td>
                      <td className="py-2 pr-3 text-right">{s.meanAge != null ? `${s.meanAge.toFixed(1)} yrs` : "—"}</td>
                      <td className="py-2 pr-3 text-right">{s.accepted}</td>
                      <td className="py-2 pr-3 text-right">{s.declined}</td>
                      <td className="py-2 pr-3 text-right">{s.pending}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
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
            <li className="flex justify-between"><span className="text-muted-foreground">Accepted</span><span className="font-medium">{byStatus.find((s) => s.name === "accepted")?.value ?? 0}</span></li>
            <li className="flex justify-between"><span className="text-muted-foreground">Declined</span><span className="font-medium">{byStatus.find((s) => s.name === "declined")?.value ?? 0}</span></li>
            <li className="flex justify-between"><span className="text-muted-foreground">Pending</span><span className="font-medium">{byStatus.find((s) => s.name === "pending")?.value ?? 0}</span></li>
          </ul>
        </Card>

        <Card className="p-5 md:col-span-2">
          <h2 className="font-semibold mb-1">Admitted referrals by accepting consultant</h2>
          <p className="text-xs text-muted-foreground mb-3">
            Daily admissions broken down by accepting consultant (top {admittedConsultants.length || 0}).
          </p>
          <div className="h-72">
            {admittedConsultants.length === 0 ? (
              <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
                No admitted referrals in this period.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={perDayByConsultant}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                  <XAxis dataKey="date" fontSize={11} />
                  <YAxis allowDecimals={false} fontSize={11} />
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  {admittedConsultants.map((name, i) => (
                    <Area
                      key={name}
                      type="monotone"
                      dataKey={name}
                      stackId="consultant"
                      stroke={COLORS[i % COLORS.length]}
                      fill={COLORS[i % COLORS.length]}
                      fillOpacity={0.7}
                    />
                  ))}
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
          {consultantTotals.length > 0 && (
            <ul className="mt-4 grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 text-sm">
              {consultantTotals.map((c) => (
                <li key={c.name} className="flex justify-between">
                  <span className="text-muted-foreground truncate mr-2" title={c.name}>{c.name}</span>
                  <span className="font-medium shrink-0">{c.count}</span>
                </li>
              ))}
            </ul>
          )}
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
