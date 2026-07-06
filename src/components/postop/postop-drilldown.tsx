import { Link } from "@tanstack/react-router";
import { format } from "date-fns";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  arrivalHoursOf,
  fmtH,
  LEVEL_LABELS,
  type PostopBookingRow,
} from "@/lib/postop-analytics-utils";

export interface Drilldown {
  title: string;
  rows: PostopBookingRow[];
}

interface PostopDrilldownProps {
  drill: Drilldown;
  onClose: () => void;
}

/**
 * Table card rendered below the charts whenever the user drills into a
 * slice (day, level, sex, arrival bucket). Read-only summary with an Open
 * link per row.
 */
export function PostopDrilldown({ drill, onClose }: PostopDrilldownProps) {
  return (
    <Card className="p-5 mt-6">
      <div className="flex items-center justify-between mb-3 gap-3">
        <h2 className="font-semibold">{drill.title}</h2>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
      {drill.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No bookings match this selection.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-muted-foreground border-b">
              <tr>
                <th className="text-left py-2 pr-3">Created</th>
                <th className="text-left py-2 pr-3">Age</th>
                <th className="text-left py-2 pr-3">Sex</th>
                <th className="text-left py-2 pr-3">BMI</th>
                <th className="text-left py-2 pr-3">Level</th>
                <th className="text-left py-2 pr-3">Arrived</th>
                <th className="text-left py-2 pr-3">Delay</th>
                <th className="text-left py-2 pr-3"></th>
              </tr>
            </thead>
            <tbody>
              {drill.rows.map((b) => {
                const h = arrivalHoursOf(b);
                return (
                  <tr key={b.id} className="border-b last:border-0 hover:bg-muted/40 transition-colors duration-150">
                    <td className="py-2 pr-3 whitespace-nowrap">
                      {format(new Date(b.created_at), "dd/MM/yyyy HH:mm")}
                    </td>
                    <td className="py-2 pr-3">{b.age ?? "—"}</td>
                    <td className="py-2 pr-3">{b.sex ?? "—"}</td>
                    <td className="py-2 pr-3">{b.bmi != null ? Number(b.bmi).toFixed(1) : "—"}</td>
                    <td className="py-2 pr-3">
                      {(b.predicted_level && LEVEL_LABELS[b.predicted_level]) ?? "—"}
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap">
                      {b.arrived_at ? format(new Date(b.arrived_at), "dd/MM/yyyy HH:mm") : "—"}
                    </td>
                    <td className="py-2 pr-3">{h != null ? fmtH(h) : "—"}</td>
                    <td className="py-2 pr-3">
                      <Button variant="link" size="sm" asChild className="h-auto p-0">
                        <Link to="/postop-bookings/$id/edit" params={{ id: b.id }}>
                          Open
                        </Link>
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
