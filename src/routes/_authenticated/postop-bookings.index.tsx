import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { listPostopBookings } from "@/lib/postop-bookings.functions";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Plus, CalendarClock } from "lucide-react";
import { format, parseISO } from "date-fns";

export const Route = createFileRoute("/_authenticated/postop-bookings/")({
  head: () => ({
    meta: [{ title: "Post-op HDU/ICU bookings — SDH Critical Care" }],
  }),
  component: PostopBookingsList,
});

type Booking = {
  id: string;
  hospital_number: string | null;
  age: number | null;
  sex: string | null;
  weight_kg: number | null;
  height_cm: number | null;
  bmi: number | null;
  proposed_procedure: string | null;
  reason_for_bed: string | null;
  predicted_level: "level_1" | "level_2" | "level_3";
  proposed_surgery_date: string | null;
  created_at: string;
};

const LEVEL_LABEL = {
  level_1: "Level 1",
  level_2: "Level 2 (HDU)",
  level_3: "Level 3 (ICU)",
} as const;

const LEVEL_CLASS = {
  level_1: "bg-sky-100 text-sky-900 dark:bg-sky-900/40 dark:text-sky-100",
  level_2: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100",
  level_3: "bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-100",
} as const;

function PostopBookingsList() {
  const load = useServerFn(listPostopBookings);
  const [rows, setRows] = useState<Booking[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((data) => {
        if (!cancelled) setRows(data as Booking[]);
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message ?? "Could not load bookings");
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">Post-op HDU/ICU bookings</h1>
          <p className="text-sm text-muted-foreground">
            Pre-booked critical care beds for planned high-risk surgical patients.
          </p>
        </div>
        <Button asChild>
          <Link to="/postop-bookings/new">
            <Plus className="w-4 h-4 mr-1" /> New booking
          </Link>
        </Button>
      </div>

      {error && (
        <Card className="p-4 border-destructive/50 text-destructive text-sm">{error}</Card>
      )}

      {rows === null && !error && (
        <Card className="p-6 text-sm text-muted-foreground">Loading…</Card>
      )}

      {rows && rows.length === 0 && (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          No post-op bookings yet. Use “New booking” to add one.
        </Card>
      )}

      {rows && rows.length > 0 && (
        <div className="grid gap-3">
          {rows.map((b) => (
            <Card key={b.id} className="p-4 space-y-2">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium">
                      {b.hospital_number || <em className="text-muted-foreground">No hospital number</em>}
                    </span>
                    <Badge className={LEVEL_CLASS[b.predicted_level]} variant="secondary">
                      {LEVEL_LABEL[b.predicted_level]}
                    </Badge>
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {[
                      b.age != null ? `${b.age}y` : null,
                      b.sex ?? null,
                      b.bmi != null ? `BMI ${b.bmi}` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "—"}
                  </div>
                </div>
                <div className="text-sm text-right shrink-0">
                  <div className="flex items-center gap-1 text-muted-foreground">
                    <CalendarClock className="w-3.5 h-3.5" />
                    {b.proposed_surgery_date
                      ? format(parseISO(b.proposed_surgery_date), "PP")
                      : "Date TBC"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Booked {format(parseISO(b.created_at), "PP")}
                  </div>
                </div>
              </div>
              {b.proposed_procedure && (
                <div className="text-sm">
                  <span className="text-muted-foreground">Procedure: </span>
                  {b.proposed_procedure}
                </div>
              )}
              {b.reason_for_bed && (
                <div className="text-sm">
                  <span className="text-muted-foreground">Reason: </span>
                  {b.reason_for_bed}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
