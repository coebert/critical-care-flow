import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { z } from "zod";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { PostopAnalyticsPanel } from "@/components/postop-analytics-panel";
import { getReferralsAnalytics, getPostopAnalytics } from "@/lib/analytics.functions";
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
  startOfISOWeek, startOfMonth, eachWeekOfInterval, eachMonthOfInterval,
} from "date-fns";
import {
  aggregateUrgencyCounts,
  aggregateUrgencyPerDay,
  URGENCY_LEGEND_KEYS,
} from "@/lib/analytics-urgency";
import { SURGICAL_SPECIALTY_LABEL, type SurgicalSpecialty } from "@/lib/surgical-specialties";

type Referral = Tables<"referrals">;

import { AdminOnly } from "@/components/admin-only";

const analyticsSearchSchema = z.object({
  view: z.enum(["referrals", "postop"]).optional(),
});

export const Route = createFileRoute("/_authenticated/analytics")({
  head: () => ({ meta: [{ title: "Analytics — SDH Critical Care" }] }),
  validateSearch: analyticsSearchSchema,
  component: () => (
    <AdminOnly redirectTo="/postop-bookings">
      <AnalyticsPage />
    </AdminOnly>
  ),
});

const COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];

function AnalyticsPage() {
  const [range, setRange] = useState<DateRange>(() => ({
    from: startOfDay(subDays(new Date(), 29)),
    to: endOfDay(new Date()),
  }));

  const from = range.from ? startOfDay(range.from) : startOfDay(subDays(new Date(), 29));
  const to = range.to ? endOfDay(range.to) : endOfDay(range.from ?? new Date());
  const days = Math.max(1, differenceInCalendarDays(to, from) + 1);

  const nav = useNavigate();
  const fromKey = format(from, "yyyy-MM-dd");
  const toKey = format(to, "yyyy-MM-dd");
  const openDay = (dayKey: string) =>
    nav({ to: "/", search: { from: dayKey, to: dayKey } });
  const openSpecialty = (specialty: string) =>
    nav({ to: "/", search: { specialty, from: fromKey, to: toKey } });

  const referralsFn = useServerFn(getReferralsAnalytics);
  const postopFn = useServerFn(getPostopAnalytics);

  const fromIso = from.toISOString();
  const toIso = to.toISOString();

  const { data: rows = [] } = useQuery({
    queryKey: ["analytics", "referrals", fromIso, toIso],
    queryFn: () => referralsFn({ data: { from: fromIso, to: toIso } }),
  });
  const { data: postopBmi = [] } = useQuery({
    queryKey: ["analytics", "postop", fromIso, toIso],
    queryFn: () => postopFn({ data: { from: fromIso, to: toIso } }),
  });

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
    return Array.from(map.entries()).map(([date, count]) => ({ key: date, date: format(new Date(date), "dd MMM"), count }));
  }, [filtered, dayKeys]);

  const combinedPerDay = useMemo(() => {
    const refMap = new Map<string, number>(dayKeys.map((k) => [k, 0]));
    filtered.forEach((r) => {
      const k = format(startOfDay(new Date(r.referral_received_at)), "yyyy-MM-dd");
      if (refMap.has(k)) refMap.set(k, (refMap.get(k) ?? 0) + 1);
    });
    const bookMap = new Map<string, number>(dayKeys.map((k) => [k, 0]));
    postopBmi.forEach((b) => {
      const k = format(startOfDay(new Date(b.created_at)), "yyyy-MM-dd");
      if (bookMap.has(k)) bookMap.set(k, (bookMap.get(k) ?? 0) + 1);
    });
    return dayKeys.map((k) => ({
      key: k,
      date: format(new Date(k), "dd MMM"),
      referrals: refMap.get(k) ?? 0,
      bookings: bookMap.get(k) ?? 0,
    }));
  }, [filtered, postopBmi, dayKeys]);

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

  const minutesSamples = (sel: (r: Referral) => [string | null, string | null]) =>
    filtered
      .map(sel)
      .map(([a, b]) => (a && b ? differenceInMinutes(new Date(b), new Date(a)) : null))
      .filter((x): x is number => x != null && x >= 0);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const median = (xs: number[]) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const pctWithin = (xs: number[], threshold: number) =>
    xs.length ? (xs.filter((x) => x <= threshold).length / xs.length) * 100 : 0;

  const timeToSeenSamples = minutesSamples((r) => [r.referral_received_at, r.first_seen_at]);
  const decisionToArrivalSamples = minutesSamples((r) => [r.decision_at, r.arrived_on_unit_at]);
  const meanTimeToSeen = mean(timeToSeenSamples);
  const meanDecisionToArrival = mean(decisionToArrivalSamples);

  // ICNARC / GPICS-aligned targets for critical-care referral workflow.
  // Values are in minutes and can be tuned to local standards.
  const ICNARC_TIME_TO_SEEN_TARGET_MIN = 30;   // review within 30 min of referral
  const ICNARC_DECISION_TO_ARRIVAL_TARGET_MIN = 240; // on unit within 4 h of decision
  const icnarc = {
    seen: {
      n: timeToSeenSamples.length,
      pct: pctWithin(timeToSeenSamples, ICNARC_TIME_TO_SEEN_TARGET_MIN),
      median: median(timeToSeenSamples),
      target: ICNARC_TIME_TO_SEEN_TARGET_MIN,
    },
    arrival: {
      n: decisionToArrivalSamples.length,
      pct: pctWithin(decisionToArrivalSamples, ICNARC_DECISION_TO_ARRIVAL_TARGET_MIN),
      median: median(decisionToArrivalSamples),
      target: ICNARC_DECISION_TO_ARRIVAL_TARGET_MIN,
    },
  };

  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const tab: "referrals" | "postop" = search.view === "postop" ? "postop" : "referrals";

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      <div className="mb-4">
        <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
      </div>
      <Tabs
        value={tab}
        onValueChange={(v) =>
          navigate({ search: { view: v === "postop" ? "postop" : undefined } as any, replace: true })
        }
      >
        <TabsList className="mb-4">
          <TabsTrigger value="referrals">Referrals</TabsTrigger>
          <TabsTrigger value="postop">Post-op bookings</TabsTrigger>
        </TabsList>
        <TabsContent value="referrals">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
        <div className="min-w-0">
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

      <Card className="p-5 mb-6">
        <div className="flex items-baseline justify-between gap-3 mb-4 flex-wrap">
          <h2 className="font-semibold">ICNARC timing KPIs</h2>
          <span className="text-xs text-muted-foreground">
            Referral-workflow targets aligned to ICNARC / GPICS timing standards.
          </span>
        </div>
        <div className="grid md:grid-cols-2 gap-4">
          <IcnarcKpi
            label="Referral → first seen"
            targetLabel={`≤ ${icnarc.seen.target} min`}
            pct={icnarc.seen.pct}
            median={icnarc.seen.median}
            n={icnarc.seen.n}
          />
          <IcnarcKpi
            label="Decision → on unit"
            targetLabel={`≤ ${Math.round(icnarc.arrival.target / 60)} h`}
            pct={icnarc.arrival.pct}
            median={icnarc.arrival.median}
            n={icnarc.arrival.n}
          />
        </div>
      </Card>



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
        <Card className="p-5 md:col-span-2">
          <h2 className="font-semibold mb-3">Referrals &amp; post-op bookings trend</h2>
          <p className="text-xs text-muted-foreground mb-2">Click a day to view referrals from that day.</p>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={combinedPerDay}
                style={{ cursor: "pointer" }}
                onClick={(e: any) => {
                  const p = e?.activePayload?.[0]?.payload;
                  if (p?.key) openDay(p.key);
                }}
              >
                <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                <XAxis dataKey="date" fontSize={11} />
                <YAxis allowDecimals={false} fontSize={11} />
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line type="monotone" dataKey="referrals" name="Referrals" stroke="var(--chart-1)" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="bookings" name="Post-op bookings" stroke="var(--chart-2)" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="font-semibold mb-3">Referrals over time</h2>
          <p className="text-xs text-muted-foreground mb-2">Click a day to view its referrals.</p>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={perDay}
                style={{ cursor: "pointer" }}
                onClick={(e: any) => {
                  const p = e?.activePayload?.[0]?.payload;
                  if (p?.key) openDay(p.key);
                }}
              >
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
          <p className="text-xs text-muted-foreground mb-2">Click a bar to view referrals for that specialty.</p>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={bySpecialtyTop}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                <XAxis dataKey="specialty" fontSize={11} angle={-15} textAnchor="end" height={70} />
                <YAxis allowDecimals={false} fontSize={11} />
                <Tooltip />
                <Bar
                  dataKey="count"
                  fill="var(--chart-2)"
                  radius={[4, 4, 0, 0]}
                  style={{ cursor: "pointer" }}
                  onClick={(d: any) => d?.specialty && openSpecialty(d.specialty)}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="p-5 md:col-span-2">
          <div className="flex items-baseline justify-between mb-3 gap-3">
            <h2 className="font-semibold">Specialty breakdown</h2>
            <span className="text-xs text-muted-foreground">
              Mean age from referrals. Mean BMI is derived from matching post-op bookings in this period; specialties without a match show N/A.
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
                    <th className="text-right py-2 pr-3">Mean BMI</th>
                    <th className="text-right py-2 pr-3">Accepted</th>
                    <th className="text-right py-2 pr-3">Declined</th>
                    <th className="text-right py-2 pr-3">Pending</th>
                  </tr>
                </thead>
                <tbody>
                  {bySpecialty.map((s) => {
                    const bmi = lookupBmi(s.specialty);
                    return (
                      <tr
                        key={s.specialty}
                        className="border-b last:border-0 hover:bg-muted/40 cursor-pointer"
                        onClick={() => openSpecialty(s.specialty)}
                        title={`View referrals for ${s.specialty}`}
                      >
                        <td className="py-2 pr-3 font-medium">{s.specialty}</td>
                        <td className="py-2 pr-3 text-right">{s.count}</td>
                        <td className="py-2 pr-3 text-right">
                          {filtered.length ? ((s.count / filtered.length) * 100).toFixed(1) : "0.0"}%
                        </td>
                        <td className="py-2 pr-3 text-right">{s.meanAge != null ? `${s.meanAge.toFixed(1)} yrs` : "—"}</td>
                        <td className="py-2 pr-3 text-right">
                          {bmi ? (
                            <span title={`Based on ${bmi.n} post-op booking${bmi.n === 1 ? "" : "s"}`}>
                              {bmi.mean.toFixed(1)}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">N/A</span>
                          )}
                        </td>
                        <td className="py-2 pr-3 text-right">{s.accepted}</td>
                        <td className="py-2 pr-3 text-right">{s.declined}</td>
                        <td className="py-2 pr-3 text-right">{s.pending}</td>
                      </tr>
                    );
                  })}
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
        </TabsContent>
        <TabsContent value="postop">
          <PostopAnalyticsPanel />
        </TabsContent>
      </Tabs>
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

function IcnarcKpi({
  label, targetLabel, pct, median, n,
}: { label: string; targetLabel: string; pct: number; median: number; n: number }) {
  const tone =
    n === 0 ? "text-muted-foreground"
    : pct >= 90 ? "text-success"
    : pct >= 70 ? "text-warning-foreground"
    : "text-destructive";
  const barTone =
    pct >= 90 ? "bg-success"
    : pct >= 70 ? "bg-warning"
    : "bg-destructive";
  const fmtMedian = median >= 60 ? `${(median / 60).toFixed(1)} h` : `${Math.round(median)} min`;
  return (
    <div className="rounded-lg border p-4">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-sm font-medium">{label}</div>
        <Badge variant="outline" className="shrink-0">Target {targetLabel}</Badge>
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className={cn("text-3xl font-semibold tabular-nums", tone)}>
          {n ? `${pct.toFixed(0)}%` : "—"}
        </span>
        <span className="text-xs text-muted-foreground">within target</span>
      </div>
      <div className="mt-3 h-2 w-full rounded-full bg-muted overflow-hidden">
        <div
          className={cn("h-full transition-all", barTone)}
          style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
        />
      </div>
      <div className="mt-3 flex justify-between text-xs text-muted-foreground">
        <span>Median {n ? fmtMedian : "—"}</span>
        <span>n = {n}</span>
      </div>
    </div>
  );
}
