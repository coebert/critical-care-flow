import { Card } from "@/components/ui/card";
import { fmtH, type ArrivalStats } from "@/lib/postop-analytics-utils";

interface KpiProps {
  label: string;
  value: string;
}

export function Kpi({ label, value }: KpiProps) {
  return (
    <Card className="p-5">
      <div className="text-xs text-muted-foreground uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
    </Card>
  );
}

interface PostopKpiCardsProps {
  totalBookings: number;
  meanPerWeek: number;
  meanAge: number;
  meanBmi: number;
  arrivalStats: ArrivalStats;
}

/**
 * Two rows of KPI tiles: booking counts / demographics on top,
 * arrival-delay quantiles below.
 */
export function PostopKpiCards({
  totalBookings,
  meanPerWeek,
  meanAge,
  meanBmi,
  arrivalStats,
}: PostopKpiCardsProps) {
  return (
    <>
      <div className="grid md:grid-cols-4 gap-4 mb-6">
        <Kpi label="Total bookings" value={totalBookings.toString()} />
        <Kpi label="Mean / week" value={meanPerWeek.toFixed(1)} />
        <Kpi label="Mean age (yrs)" value={meanAge ? meanAge.toFixed(1) : "—"} />
        <Kpi label="Mean BMI" value={meanBmi ? meanBmi.toFixed(1) : "—"} />
      </div>

      <div className="grid md:grid-cols-4 gap-4 mb-6">
        <Kpi label="Arrivals recorded" value={`${arrivalStats.count}/${totalBookings}`} />
        <Kpi label="Mean delay" value={arrivalStats.count ? fmtH(arrivalStats.mean) : "—"} />
        <Kpi label="Median delay" value={arrivalStats.count ? fmtH(arrivalStats.median) : "—"} />
        <Kpi label="90th percentile" value={arrivalStats.count ? fmtH(arrivalStats.p90) : "—"} />
      </div>
    </>
  );
}
