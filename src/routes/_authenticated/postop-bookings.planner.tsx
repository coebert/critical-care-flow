import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { listBookingsInRange } from "@/lib/postop-bookings.functions";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PostopStatusBadge } from "@/components/postop/status-badge";
import { ChevronLeft, ChevronRight, ArrowLeft } from "lucide-react";
import { addDays, format, parseISO, startOfWeek } from "date-fns";
import type { PostopBookingStatus } from "@/lib/postop-lifecycle";

export const Route = createFileRoute("/_authenticated/postop-bookings/planner")({
  head: () => ({
    meta: [{ title: "Post-op booking planner — SDH Critical Care" }],
  }),
  component: PlannerPage,
});

type Row = {
  id: string;
  hospital_number: string | null;
  proposed_procedure: string | null;
  proposed_surgery_date: string | null;
  predicted_level: "level_1" | "level_2" | "level_3";
  booking_status: PostopBookingStatus;
};

const LEVEL_SHORT = { level_1: "L1", level_2: "L2 HDU", level_3: "L3 ICU" } as const;
const LEVEL_RANK = { level_3: 0, level_2: 1, level_1: 2 } as const;
const COUNTED: PostopBookingStatus[] = [
  "requested",
  "provisionally_confirmed",
  "confirmed",
];

function PlannerPage() {
  const navigate = useNavigate();
  const load = useServerFn(listBookingsInRange);
  const [weekStart, setWeekStart] = useState(() =>
    startOfWeek(new Date(), { weekStartsOn: 1 }),
  );
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    const from = format(weekStart, "yyyy-MM-dd");
    const to = format(addDays(weekStart, 6), "yyyy-MM-dd");
    load({ data: { from, to } })
      .then((d) => {
        if (!cancelled) setRows(d as Row[]);
      })
      .catch((e) => {
        if (!cancelled) setError(e?.message ?? "Failed to load planner");
      });
    return () => {
      cancelled = true;
    };
  }, [load, weekStart]);

  const byDay = useMemo(() => {
    const map = new Map<string, Row[]>();
    (rows ?? []).forEach((r) => {
      if (!r.proposed_surgery_date) return;
      const key = r.proposed_surgery_date;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    });
    for (const list of map.values()) {
      list.sort((a, b) => LEVEL_RANK[a.predicted_level] - LEVEL_RANK[b.predicted_level]);
    }
    return map;
  }, [rows]);

  return (
    <div className="max-w-7xl mx-auto p-4 sm:p-6 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Button asChild size="sm" variant="ghost">
            <Link to="/postop-bookings">
              <ArrowLeft className="w-4 h-4 mr-1" /> Bookings
            </Link>
          </Button>
          <h1 className="text-2xl font-semibold">Post-op planner</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setWeekStart((w) => addDays(w, -7))}>
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <div className="text-sm w-56 text-center">
            Week of {format(weekStart, "dd/MM/yyyy")}
          </div>
          <Button size="sm" variant="outline" onClick={() => setWeekStart((w) => addDays(w, 7))}>
            <ChevronRight className="w-4 h-4" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setWeekStart(startOfWeek(new Date(), { weekStartsOn: 1 }))}
          >
            This week
          </Button>
        </div>
      </div>

      {error && (
        <Card className="p-4 border-destructive/50 text-destructive text-sm">{error}</Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-7 gap-2">
        {days.map((d) => {
          const key = format(d, "yyyy-MM-dd");
          const list = byDay.get(key) ?? [];
          const committed = list.filter((r) => COUNTED.includes(r.booking_status));
          const l3 = committed.filter((r) => r.predicted_level === "level_3").length;
          const l2 = committed.filter((r) => r.predicted_level === "level_2").length;
          return (
            <Card key={key} className="p-2 min-h-[220px] flex flex-col">
              <div className="mb-2">
                <div className="text-xs uppercase text-muted-foreground">
                  {format(d, "EEE")}
                </div>
                <div className="font-medium">{format(d, "dd/MM/yyyy")}</div>
                <div className="text-[11px] text-muted-foreground mt-1">
                  Committed: {committed.length}
                  {(l3 || l2) ? (
                    <span> ({l3 ? `${l3} L3` : ""}{l3 && l2 ? ", " : ""}{l2 ? `${l2} L2` : ""})</span>
                  ) : null}
                </div>
              </div>
              <div className="flex-1 space-y-1.5">
                {list.length === 0 && (
                  <div className="text-xs text-muted-foreground italic">No bookings</div>
                )}
                {list.map((r) => {
                  const muted = ["cancelled", "admitted"].includes(r.booking_status);
                  return (
                    <button
                      key={r.id}
                      onClick={() =>
                        navigate({ to: "/postop-bookings/$id/edit", params: { id: r.id } })
                      }
                      className={`w-full text-left p-2 rounded border text-xs hover:bg-accent transition ${
                        muted ? "opacity-60" : ""
                      }`}
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span className="font-medium truncate">
                          {r.hospital_number || <em>No HN</em>}
                        </span>
                        <span className="text-[10px] font-semibold text-muted-foreground">
                          {LEVEL_SHORT[r.predicted_level]}
                        </span>
                      </div>
                      <div className="mt-1">
                        <PostopStatusBadge status={r.booking_status} className="text-[10px]" />
                      </div>
                      {r.proposed_procedure && (
                        <div className="mt-1 truncate text-muted-foreground">
                          {r.proposed_procedure}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
