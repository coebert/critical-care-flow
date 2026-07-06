import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { z } from "zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { PostopAnalyticsPanel } from "@/components/postop-analytics-panel";
import { getReferralsAnalytics, getPostopAnalytics } from "@/lib/analytics.functions";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
  DialogFooter, DialogTrigger, DialogClose,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CalendarIcon, Settings2, X, Baby } from "lucide-react";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
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
  const [complianceBucket, setComplianceBucket] = useState<"day" | "week" | "month">("day");
  const [complianceSpecialty, setComplianceSpecialty] = useState<string | null>(null);
  const [pediatricFilter, setPediatricFilter] = useState<"all" | "pediatric">("all");

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

  const queryClient = useQueryClient();
  const { data: icnarcTargets } = useQuery({
    queryKey: ["icnarc-targets"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("icnarc_targets")
        .select("time_to_seen_target_min, decision_to_arrival_target_min")
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
  // ICNARC / GPICS-aligned targets, configurable via the dialog below.
  const ICNARC_TIME_TO_SEEN_TARGET_MIN = icnarcTargets?.time_to_seen_target_min ?? 30;
  const ICNARC_DECISION_TO_ARRIVAL_TARGET_MIN = icnarcTargets?.decision_to_arrival_target_min ?? 240;

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      const t = new Date(r.referral_received_at).getTime();
      return t >= from.getTime() && t <= to.getTime();
    });
  }, [rows, from, to]);

  const complianceFiltered = useMemo(() => {
    if (!complianceSpecialty) return filtered;
    return filtered.filter((r) => (r.referring_specialty || "Unknown") === complianceSpecialty);
  }, [filtered, complianceSpecialty]);

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

  // Pediatric analytics — patients aged 16 and under.
  const pediatricFiltered = useMemo(
    () => filtered.filter((r) => typeof r.age === "number" && r.age <= 16),
    [filtered]
  );

  const pediatricPerDay = useMemo(() => {
    const map = new Map<string, number>(dayKeys.map((k) => [k, 0]));
    pediatricFiltered.forEach((r) => {
      const k = format(startOfDay(new Date(r.referral_received_at)), "yyyy-MM-dd");
      if (map.has(k)) map.set(k, (map.get(k) ?? 0) + 1);
    });
    return Array.from(map.entries()).map(([date, count]) => ({
      key: date,
      date: format(new Date(date), "dd MMM"),
      count,
    }));
  }, [pediatricFiltered, dayKeys]);

  const pediatricBySpecialty = useMemo(() => {
    const map = new Map<string, number>();
    pediatricFiltered.forEach((r) => {
      const k = r.referring_specialty || "Unknown";
      map.set(k, (map.get(k) ?? 0) + 1);
    });
    return Array.from(map.entries())
      .map(([specialty, count]) => ({ specialty, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  }, [pediatricFiltered]);

  const pediatricPct = filtered.length
    ? (pediatricFiltered.length / filtered.length) * 100
    : 0;

  const missingAgeCount = useMemo(
    () => filtered.filter((r) => r.age === null || r.age === undefined).length,
    [filtered]
  );

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

  const complianceTrend = useMemo(() => {
    const bucketStart = (d: Date) =>
      complianceBucket === "day" ? startOfDay(d)
      : complianceBucket === "week" ? startOfISOWeek(d)
      : startOfMonth(d);
    const starts =
      complianceBucket === "day" ? eachDayOfInterval({ start: from, end: to })
      : complianceBucket === "week" ? eachWeekOfInterval({ start: from, end: to }, { weekStartsOn: 1 })
      : eachMonthOfInterval({ start: from, end: to });
    const labelFmt =
      complianceBucket === "day" ? "dd MMM"
      : complianceBucket === "week" ? "'W'II · dd MMM"
      : "MMM yyyy";
    type Bucket = { seen: number[]; arrival: number[] };
    const map = new Map<string, Bucket>();
    starts.forEach((d) => map.set(bucketStart(d).toISOString(), { seen: [], arrival: [] }));
    complianceFiltered.forEach((r) => {
      const k = bucketStart(new Date(r.referral_received_at)).toISOString();
      const b = map.get(k);
      if (!b) return;
      if (r.referral_received_at && r.first_seen_at) {
        const m = differenceInMinutes(new Date(r.first_seen_at), new Date(r.referral_received_at));
        if (m >= 0) b.seen.push(m);
      }
      if (r.decision_at && r.arrived_on_unit_at) {
        const m = differenceInMinutes(new Date(r.arrived_on_unit_at), new Date(r.decision_at));
        if (m >= 0) b.arrival.push(m);
      }
    });
    return starts.map((d) => {
      const b = map.get(bucketStart(d).toISOString())!;
      const seenNum = b.seen.filter((m) => m <= ICNARC_TIME_TO_SEEN_TARGET_MIN).length;
      const arrivalNum = b.arrival.filter((m) => m <= ICNARC_DECISION_TO_ARRIVAL_TARGET_MIN).length;
      return {
        date: format(d, labelFmt),
        seenPct: b.seen.length ? pctWithin(b.seen, ICNARC_TIME_TO_SEEN_TARGET_MIN) : null,
        arrivalPct: b.arrival.length ? pctWithin(b.arrival, ICNARC_DECISION_TO_ARRIVAL_TARGET_MIN) : null,
        seenNum,
        seenN: b.seen.length,
        arrivalNum,
        arrivalN: b.arrival.length,
      };
    });
  }, [complianceFiltered, from, to, complianceBucket, complianceSpecialty, ICNARC_TIME_TO_SEEN_TARGET_MIN, ICNARC_DECISION_TO_ARRIVAL_TARGET_MIN]);



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

      <div className="grid md:grid-cols-3 lg:grid-cols-5 gap-4 mb-6">
        <Kpi label="Total referrals" value={filtered.length.toString()} />
        <Kpi label="Mean / 24h" value={meanPer24h.toFixed(1)} />
        <Kpi label="Mean age (yrs)" value={meanAge ? meanAge.toFixed(1) : "—"} />
        <Kpi label="Mean time-to-first-seen" value={meanTimeToSeen ? `${Math.round(meanTimeToSeen)} min` : "—"} />
        <Kpi
          label="Pediatric (≤16)"
          value={`${pediatricFiltered.length}${filtered.length ? ` · ${pediatricPct.toFixed(0)}%` : ""}`}
        />
      </div>

      <Card className="p-5 mb-6">
        <div className="flex items-baseline justify-between gap-3 mb-3 flex-wrap">
          <div>
            <h2 className="font-semibold">Pediatric referrals (≤16 years)</h2>
            <p className="text-xs text-muted-foreground">
              {pediatricFiltered.length} of {filtered.length} referrals ({pediatricPct.toFixed(1)}%) in the selected range.
            </p>
          </div>
          {missingAgeCount > 0 && (
            <Badge
              variant="outline"
              title="These referrals have no recorded age and are excluded from pediatric counts."
              className="border-amber-500/60 text-amber-800 dark:text-amber-200 bg-amber-100/60 dark:bg-amber-900/30"
            >
              <TriangleAlert className="w-3 h-3 mr-1" />
              {missingAgeCount} missing age — not counted
            </Badge>
          )}
        </div>

        <div className="grid md:grid-cols-2 gap-4">
          <div className="h-64">
            <p className="text-xs text-muted-foreground mb-1">Over time · click a day to open</p>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={pediatricPerDay}
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
                <Line type="monotone" dataKey="count" name="Pediatric" stroke="var(--chart-4)" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="h-64">
            <p className="text-xs text-muted-foreground mb-1">By referring specialty · click a bar to filter</p>
            {pediatricBySpecialty.length === 0 ? (
              <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
                No pediatric referrals in this range.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={pediatricBySpecialty}
                  layout="vertical"
                  style={{ cursor: "pointer" }}
                  onClick={(e: any) => {
                    const p = e?.activePayload?.[0]?.payload;
                    if (p?.specialty) openSpecialty(p.specialty);
                  }}
                >
                  <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                  <XAxis type="number" allowDecimals={false} fontSize={11} />
                  <YAxis type="category" dataKey="specialty" width={140} fontSize={11} />
                  <Tooltip />
                  <Bar dataKey="count" fill="var(--chart-4)" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </Card>


      <Card className="p-5 mb-6">
        <div className="flex items-baseline justify-between gap-3 mb-4 flex-wrap">
          <div className="flex items-baseline gap-3 flex-wrap">
            <h2 className="font-semibold">ICNARC timing KPIs</h2>
            <span className="text-xs text-muted-foreground">
              Referral-workflow targets aligned to ICNARC / GPICS timing standards.
            </span>
          </div>
          <IcnarcTargetsDialog
            timeToSeen={ICNARC_TIME_TO_SEEN_TARGET_MIN}
            decisionToArrival={ICNARC_DECISION_TO_ARRIVAL_TARGET_MIN}
            onSaved={() => queryClient.invalidateQueries({ queryKey: ["icnarc-targets"] })}
          />
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

      <Card className="p-5 mb-6">
        <div className="flex items-baseline justify-between gap-3 mb-3 flex-wrap">
          <div>
            <h2 className="font-semibold">ICNARC compliance trend</h2>
            <p className="text-xs text-muted-foreground">
              {complianceSpecialty
                ? `Showing ${complianceSpecialty} only · `
                : "All specialties · "}
              % within target for referral → first seen (≤{ICNARC_TIME_TO_SEEN_TARGET_MIN} min) and decision → on unit (≤{Math.round(ICNARC_DECISION_TO_ARRIVAL_TARGET_MIN / 60)} h).
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Select
              value={complianceSpecialty ?? "__all__"}
              onValueChange={(v) => setComplianceSpecialty(v === "__all__" ? null : v)}
            >
              <SelectTrigger className="w-[220px] h-8 text-xs">
                <SelectValue placeholder="All specialties" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All specialties</SelectItem>
                {bySpecialty.map((s) => (
                  <SelectItem key={s.specialty} value={s.specialty}>
                    {s.specialty} ({s.count})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex gap-1">
              {(["day", "week", "month"] as const).map((g) => (
                <Button
                  key={g}
                  size="sm"
                  variant={complianceBucket === g ? "default" : "outline"}
                  onClick={() => setComplianceBucket(g)}
                >
                  {g[0].toUpperCase() + g.slice(1)}
                </Button>
              ))}
            </div>
          </div>
        </div>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={complianceTrend}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
              <XAxis dataKey="date" fontSize={11} />
              <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} fontSize={11} />
              <Tooltip content={({ active, payload, label }) => {
                if (!active || !payload || payload.length === 0) return null;
                const p = payload[0]?.payload as any;
                return (
                  <div className="rounded-md border bg-popover p-2 text-xs shadow-sm">
                    <div className="font-medium mb-1">{label}</div>
                    {payload.map((item: any, i: number) => {
                      const name = item.name as string;
                      const val = item.value;
                      const isSeen = name === "Referral → first seen";
                      const num = isSeen ? p?.seenNum : p?.arrivalNum;
                      const den = isSeen ? p?.seenN : p?.arrivalN;
                      return (
                        <div key={i} className="flex items-center gap-2 py-0.5">
                          <span
                            className="inline-block h-2 w-2 rounded-full"
                            style={{ background: item.color }}
                          />
                          <span className="text-muted-foreground">{name}:</span>
                          <span className="font-medium tabular-nums">
                            {val == null ? "—" : `${Number(val).toFixed(0)}%`}
                            {val != null && den > 0 ? ` (${num}/${den})` : ""}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                );
              }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line
                type="monotone"
                dataKey="seenPct"
                name="Referral → first seen"
                stroke="var(--chart-1)"
                strokeWidth={2}
                connectNulls
                dot={{ r: 3 }}
              />
              <Line
                type="monotone"
                dataKey="arrivalPct"
                name="Decision → on unit"
                stroke="var(--chart-2)"
                strokeWidth={2}
                connectNulls
                dot={{ r: 3 }}
              />
            </LineChart>
          </ResponsiveContainer>
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

function IcnarcTargetsDialog({
  timeToSeen,
  decisionToArrival,
  onSaved,
}: {
  timeToSeen: number;
  decisionToArrival: number;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(String(timeToSeen));
  const [arrival, setArrival] = useState(String(decisionToArrival));
  const [saving, setSaving] = useState(false);

  // Re-sync inputs when the dialog opens or upstream targets change.
  const openDialog = (next: boolean) => {
    if (next) {
      setSeen(String(timeToSeen));
      setArrival(String(decisionToArrival));
    }
    setOpen(next);
  };

  const handleSave = async () => {
    const seenMin = Number(seen);
    const arrivalMin = Number(arrival);
    if (!Number.isFinite(seenMin) || seenMin <= 0 || seenMin > 100000) {
      toast.error("Referral → first seen must be between 1 and 100000 minutes.");
      return;
    }
    if (!Number.isFinite(arrivalMin) || arrivalMin <= 0 || arrivalMin > 100000) {
      toast.error("Decision → on unit must be between 1 and 100000 minutes.");
      return;
    }
    setSaving(true);
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase
      .from("icnarc_targets")
      .update({
        time_to_seen_target_min: Math.round(seenMin),
        decision_to_arrival_target_min: Math.round(arrivalMin),
        updated_by: user?.id ?? null,
      })
      .eq("id", true);
    setSaving(false);
    if (error) {
      toast.error(error.message || "Could not save thresholds.");
      return;
    }
    toast.success("ICNARC thresholds updated.");
    onSaved();
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={openDialog}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Settings2 className="mr-2 h-4 w-4" />
          Edit targets
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>ICNARC timing targets</DialogTitle>
          <DialogDescription>
            Thresholds are shared across all clinicians and used to compute % within target
            on this page.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="icnarc-seen">Referral → first seen (minutes)</Label>
            <Input
              id="icnarc-seen"
              type="number"
              min={1}
              max={100000}
              step={1}
              value={seen}
              onChange={(e) => setSeen(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Default 30 min. Currently {timeToSeen} min.
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="icnarc-arrival">Decision → on unit (minutes)</Label>
            <Input
              id="icnarc-arrival"
              type="number"
              min={1}
              max={100000}
              step={1}
              value={arrival}
              onChange={(e) => setArrival(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Default 240 min (4 h). Currently {decisionToArrival} min
              {" "}(≈ {(decisionToArrival / 60).toFixed(1)} h).
            </p>
          </div>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" disabled={saving}>Cancel</Button>
          </DialogClose>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save thresholds"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
