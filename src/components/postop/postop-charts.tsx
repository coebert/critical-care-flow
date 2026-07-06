import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Card } from "@/components/ui/card";
import {
  CHART_COLORS,
  LEVEL_LABELS,
  fmtH,
  type ArrivalStats,
  type PostopBookingRow,
} from "@/lib/postop-analytics-utils";

interface DrillHandlers {
  onDrillDay: (key: string, extraLabel?: string) => void;
  onDrillLevel: (levelLabel: string) => void;
  onDrillSex: (sex: string) => void;
  onDrillBucket: (name: string, min: number, max: number) => void;
}

interface PostopChartsProps extends DrillHandlers {
  filtered: PostopBookingRow[];
  perDay: Array<{ key: string; date: string; count: number }>;
  perDayByLevel: Array<Record<string, number | string>>;
  byLevel: Array<{ name: string; value: number }>;
  bySex: Array<{ name: string; value: number }>;
  arrivalStats: ArrivalStats;
  arrivalBuckets: Array<{ name: string; min: number; max: number; count: number }>;
  meanAge: number;
  meanBmi: number;
  meanPerWeek: number;
}

/**
 * All six chart cards plus the two textual summary cards for the post-op
 * analytics panel. Every chart accepts click callbacks so the parent panel
 * owns drill-down state.
 */
export function PostopCharts({
  filtered,
  perDay,
  perDayByLevel,
  byLevel,
  bySex,
  arrivalStats,
  arrivalBuckets,
  meanAge,
  meanBmi,
  meanPerWeek,
  onDrillDay,
  onDrillLevel,
  onDrillSex,
  onDrillBucket,
}: PostopChartsProps) {
  return (
    <div className="grid md:grid-cols-2 gap-6">
      <Card className="p-5 md:col-span-2">
        <h2 className="font-semibold mb-1">Referral-to-arrival delay distribution</h2>
        <p className="text-xs text-muted-foreground mb-3">
          Time from booking creation to the patient arriving at HDU/ICU.
          {arrivalStats.count > 0 &&
            ` Range: ${fmtH(arrivalStats.min)} – ${fmtH(arrivalStats.max)}.`}
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
                <Bar
                  dataKey="count"
                  fill="var(--chart-2)"
                  cursor="pointer"
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  onClick={(d: any) => onDrillBucket(d.name, d.min, d.max)}
                />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </Card>

      <Card className="p-5 md:col-span-2">
        <h2 className="font-semibold mb-3">Bookings over time</h2>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={perDay}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              onClick={(e: any) => {
                const p = e?.activePayload?.[0]?.payload;
                if (p?.key) onDrillDay(p.key);
              }}
            >
              <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
              <XAxis dataKey="date" fontSize={11} />
              <YAxis allowDecimals={false} fontSize={11} />
              <Tooltip />
              <Line
                type="monotone"
                dataKey="count"
                stroke="var(--chart-1)"
                strokeWidth={2}
                dot={{ r: 3, cursor: "pointer" }}
                activeDot={{ r: 5, cursor: "pointer" }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <Card className="p-5">
        <h2 className="font-semibold mb-3">Predicted level of support</h2>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={byLevel}
                dataKey="value"
                nameKey="name"
                innerRadius={50}
                outerRadius={90}
                label
                cursor="pointer"
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                onClick={(d: any) => onDrillLevel(d.name)}
              >
                {byLevel.map((_, i) => (
                  <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                ))}
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
                <Bar
                  key={label}
                  dataKey={label}
                  stackId="lvl"
                  fill={CHART_COLORS[i % CHART_COLORS.length]}
                  cursor="pointer"
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  onClick={(d: any) => d?.key && onDrillDay(d.key, label)}
                />
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
              <Pie
                data={bySex}
                dataKey="value"
                nameKey="name"
                outerRadius={80}
                label
                cursor="pointer"
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                onClick={(d: any) => onDrillSex(d.name)}
              >
                {bySex.map((_, i) => (
                  <Cell key={i} fill={CHART_COLORS[(i + 1) % CHART_COLORS.length]} />
                ))}
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
          <li className="flex justify-between">
            <span className="text-muted-foreground">Total bookings</span>
            <span className="font-medium">{filtered.length}</span>
          </li>
          <li className="flex justify-between">
            <span className="text-muted-foreground">Mean per week</span>
            <span className="font-medium">{meanPerWeek.toFixed(2)}</span>
          </li>
          <li className="flex justify-between">
            <span className="text-muted-foreground">Mean age</span>
            <span className="font-medium">{meanAge ? `${meanAge.toFixed(1)} yrs` : "—"}</span>
          </li>
          <li className="flex justify-between">
            <span className="text-muted-foreground">Mean BMI</span>
            <span className="font-medium">{meanBmi ? meanBmi.toFixed(1) : "—"}</span>
          </li>
          {Object.entries(LEVEL_LABELS).map(([key, label]) => (
            <li key={key} className="flex justify-between">
              <span className="text-muted-foreground">{label}</span>
              <span className="font-medium">
                {filtered.filter((b) => b.predicted_level === key).length}
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
