import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listPostopBookings } from "@/lib/postop-bookings.functions";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CalendarIcon, ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DateRange } from "react-day-picker";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid,
  BarChart, Bar, PieChart, Pie, Cell, Legend,
} from "recharts";
import {
  format, subDays, startOfDay, endOfDay,
  differenceInCalendarDays, eachDayOfInterval,
} from "date-fns";

import { AdminOnly } from "@/components/admin-only";

export const Route = createFileRoute("/_authenticated/postop-bookings/analytics")({
  head: () => ({ meta: [{ title: "Post-op bookings analytics — SDH Critical Care" }] }),
  component: () => (
    <AdminOnly>
      <PostopAnalyticsPage />
    </AdminOnly>
  ),
});

const COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];

const LEVEL_LABELS: Record<string, string> = {
  level_1: "Level 1",
  level_2: "Level 2",
  level_3: "Level 3",
};

function PostopAnalyticsPage() {
  const listFn = useServerFn(listPostopBookings);
  const { data: bookings = [] } = useQuery({
    queryKey: ["postop-bookings", "analytics"],
    queryFn: () => listFn(),
  });

  const [range, setRange] = useState<DateRange>(() => ({
    from: startOfDay(subDays(new Date(), 89)),
    to: endOfDay(new Date()),
  }));

  const from = range.from ? startOfDay(range.from) : startOfDay(subDays(new Date(), 89));
  const to = range.to ? endOfDay(range.to) : endOfDay(range.from ?? new Date());
  const days = Math.max(1, differenceInCalendarDays(to, from) + 1);

  const filtered = useMemo(
    () =>
      bookings.filter((b) => {
        const t = new Date(b.created_at).getTime();
        return t >= from.getTime() && t <= to.getTime();
      }),
    [bookings, from, to]
  );

  const dayKeys = useMemo(
    () => eachDayOfInterval({ start: from, end: to }).map((d) => format(d, "yyyy-MM-dd")),
    [from, to]
  );

  const perDay = useMemo(() => {
    const map = new Map<string, number>(dayKeys.map((k) => [k, 0]));
    filtered.forEach((b) => {
      const k = format(startOfDay(new Date(b.created_at)), "yyyy-MM-dd");
      if (map.has(k)) map.set(k, (map.get(k) ?? 0) + 1);
    });
    return Array.from(map.entries()).map(([date, count]) => ({
      date: format(new Date(date), "dd MMM"),
      count,
    }));
  }, [filtered, dayKeys]);

  const perDayByLevel = useMemo(() => {
    const levels = Object.keys(LEVEL_LABELS);
    const map = new Map<string, Record<string, number | string>>(
      dayKeys.map((k) => [
        k,
        { date: format(new Date(k), "dd MMM"), ...Object.fromEntries(levels.map((l) => [LEVEL_LABELS[l], 0])) },
      ])
    );
    filtered.forEach((b) => {
      const k = format(startOfDay(new Date(b.created_at)), "yyyy-MM-dd");
      const row = map.get(k);
      const label = LEVEL_LABELS[b.predicted_level as string];
      if (row && label) row[label] = ((row[label] as number) ?? 0) + 1;
    });
    return Array.from(map.values());
  }, [filtered, dayKeys]);

  const meanAge = useMemo(() => {
    const xs = filtered.map((b) => b.age).filter((x): x is number => x != null);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  }, [filtered]);

  const meanBmi = useMemo(() => {
    const xs = filtered
      .map((b) => (b.bmi != null ? Number(b.bmi) : null))
      .filter((x): x is number => x != null && !Number.isNaN(x));
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  }, [filtered]);

  const byLevel = useMemo(() => {
    const map = new Map<string, number>();
    filtered.forEach((b) => {
      const key = LEVEL_LABELS[b.predicted_level as string] ?? "Unknown";
      map.set(key, (map.get(key) ?? 0) + 1);
    });
    return Array.from(map.entries()).map(([name, value]) => ({ name, value }));
  }, [filtered]);

  const bySex = useMemo(() => {
    const map = new Map<string, number>();
    filtered.forEach((b) => {
      const k = b.sex ?? "unknown";
      map.set(k, (map.get(k) ?? 0) + 1);
    });
    return Array.from(map.entries()).map(([name, value]) => ({ name, value }));
  }, [filtered]);

  const arrivalDelays = useMemo(() => {
    return filtered
      .map((b: any) => {
        if (!b.arrived_at || !b.created_at) return null;
        const start = new Date(b.created_at).getTime();
        const end = new Date(b.arrived_at).getTime();
        if (!isFinite(start) || !isFinite(end) || end < start) return null;
        return (end - start) / 3_600_000; // hours
      })
      .filter((v): v is number => v != null);
  }, [filtered]);

  const arrivalStats = useMemo(() => {
    const xs = [...arrivalDelays].sort((a, b) => a - b);
    if (!xs.length) return { count: 0, mean: 0, median: 0, p90: 0, min: 0, max: 0 };
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const q = (p: number) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))];
    return { count: xs.length, mean, median: q(0.5), p90: q(0.9), min: xs[0], max: xs[xs.length - 1] };
  }, [arrivalDelays]);

  const arrivalBuckets = useMemo(() => {
    const buckets = [
      { name: "<1h", min: 0, max: 1 },
      { name: "1–3h", min: 1, max: 3 },
      { name: "3–6h", min: 3, max: 6 },
      { name: "6–12h", min: 6, max: 12 },
      { name: "12–24h", min: 12, max: 24 },
      { name: "1–2d", min: 24, max: 48 },
      { name: ">2d", min: 48, max: Infinity },
    ];
    return buckets.map((b) => ({
      name: b.name,
      count: arrivalDelays.filter((h) => h >= b.min && h < b.max).length,
    }));
  }, [arrivalDelays]);

  const fmtH = (h: number) => (h >= 24 ? `${(h / 24).toFixed(1)}d` : `${h.toFixed(1)}h`);

  const meanPerWeek = (filtered.length / Math.max(days, 1)) * 7;

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
        <div className="min-w-0">
          <div className="mb-1">
            <Button variant="ghost" size="sm" asChild>
              <Link to="/postop-bookings"><ArrowLeft className="w-4 h-4 mr-1" />Back to bookings</Link>
            </Button>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Post-op bookings analytics</h1>
          <p className="text-sm text-muted-foreground">
            {format(from, "dd MMM yyyy")} – {format(to, "dd MMM yyyy")} · {days} day{days === 1 ? "" : "s"} · {filtered.length} bookings
          </p>
        </div>
        <div className="flex gap-2 flex-wrap items-center">
          {[30, 90, 180, 365].map((d) => (
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
        <Kpi label="Total bookings" value={filtered.length.toString()} />
        <Kpi label="Mean / week" value={meanPerWeek.toFixed(1)} />
        <Kpi label="Mean age (yrs)" value={meanAge ? meanAge.toFixed(1) : "—"} />
        <Kpi label="Mean BMI" value={meanBmi ? meanBmi.toFixed(1) : "—"} />
      </div>

      <div className="grid md:grid-cols-4 gap-4 mb-6">
        <Kpi
          label="Arrivals recorded"
          value={`${arrivalStats.count}/${filtered.length}`}
        />
        <Kpi label="Mean delay" value={arrivalStats.count ? fmtH(arrivalStats.mean) : "—"} />
        <Kpi label="Median delay" value={arrivalStats.count ? fmtH(arrivalStats.median) : "—"} />
        <Kpi label="90th percentile" value={arrivalStats.count ? fmtH(arrivalStats.p90) : "—"} />
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <Card className="p-5 md:col-span-2">
          <h2 className="font-semibold mb-1">Referral-to-arrival delay distribution</h2>
          <p className="text-xs text-muted-foreground mb-3">
            Time from booking creation to the patient arriving at HDU/ICU.
            {arrivalStats.count > 0 && ` Range: ${fmtH(arrivalStats.min)} – ${fmtH(arrivalStats.max)}.`}
          </p>
          <div className="h-64">
            {arrivalStats.count === 0 ? (
              <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
                No arrival times recorded in this period.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={arrivalBuckets}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                  <XAxis dataKey="name" fontSize={11} />
                  <YAxis allowDecimals={false} fontSize={11} />
                  <Tooltip />
                  <Bar dataKey="count" fill="var(--chart-2)" />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>

        <Card className="p-5 md:col-span-2">
          <h2 className="font-semibold mb-3">Bookings over time</h2>
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
          <h2 className="font-semibold mb-3">Predicted level of support</h2>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={byLevel} dataKey="value" nameKey="name" innerRadius={50} outerRadius={90} label>
                  {byLevel.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie>
                <Legend />
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="font-semibold mb-3">Predicted level counts</h2>
          <ul className="space-y-2 text-sm">
            {byLevel.length === 0 && (
              <li className="text-muted-foreground">No bookings in this period.</li>
            )}
            {byLevel.map((l) => (
              <li key={l.name} className="flex justify-between">
                <span className="text-muted-foreground">{l.name}</span>
                <span className="font-medium">{l.value}</span>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="p-5 md:col-span-2">
          <h2 className="font-semibold mb-3">Bookings by predicted level over time</h2>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={perDayByLevel}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                <XAxis dataKey="date" fontSize={11} />
                <YAxis allowDecimals={false} fontSize={11} />
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {Object.values(LEVEL_LABELS).map((label, i) => (
                  <Bar key={label} dataKey={label} stackId="lvl" fill={COLORS[i % COLORS.length]} />
                ))}
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
          <h2 className="font-semibold mb-3">Summary</h2>
          <ul className="space-y-3 text-sm">
            <li className="flex justify-between"><span className="text-muted-foreground">Total bookings</span><span className="font-medium">{filtered.length}</span></li>
            <li className="flex justify-between"><span className="text-muted-foreground">Mean per week</span><span className="font-medium">{meanPerWeek.toFixed(2)}</span></li>
            <li className="flex justify-between"><span className="text-muted-foreground">Mean age</span><span className="font-medium">{meanAge ? `${meanAge.toFixed(1)} yrs` : "—"}</span></li>
            <li className="flex justify-between"><span className="text-muted-foreground">Mean BMI</span><span className="font-medium">{meanBmi ? meanBmi.toFixed(1) : "—"}</span></li>
            {Object.entries(LEVEL_LABELS).map(([key, label]) => (
              <li key={key} className="flex justify-between">
                <span className="text-muted-foreground">{label}</span>
                <span className="font-medium">{filtered.filter((b) => b.predicted_level === key).length}</span>
              </li>
            ))}
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
