import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { listPostopBookings, deletePostopBooking } from "@/lib/postop-bookings.functions";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useRole } from "@/hooks/use-auth";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { Plus, CalendarClock, Pencil, Trash2, BarChart3 } from "lucide-react";
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
  deleted_at?: string | null;
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
  const remove = useServerFn(deletePostopBooking);
  const { hasRole: isAdmin } = useRole("admin");
  const [rows, setRows] = useState<Booking[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Booking | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [showDeleted, setShowDeleted] = useState(false);

  const onConfirmDelete = async () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setDeleting(true);
    // Optimistically remove from UI, snapshot previous rows for rollback.
    const previous = rows;
    setRows((prev) => (prev ? prev.filter((r) => r.id !== target.id) : prev));
    setPendingDelete(null);
    try {
      await remove({ data: { id: target.id } });
      toast.success("Post-op booking deleted");
    } catch (err: any) {
      // Roll back the optimistic removal.
      setRows(previous);
      toast.error(err?.message ?? "Could not delete booking. Changes reverted.");
    } finally {
      setDeleting(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    load(showDeleted ? { data: { includeDeleted: true } } : undefined)
      .then((data) => {
        if (!cancelled) setRows(data as Booking[]);
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message ?? "Could not load bookings");
      });
    return () => {
      cancelled = true;
    };
  }, [load, showDeleted]);

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">Post-op HDU/ICU bookings</h1>
          <p className="text-sm text-muted-foreground">
            Pre-booked critical care beds for planned high-risk surgical patients.
          </p>
        </div>
        <div className="flex gap-2 items-center flex-wrap">
          {isAdmin && (
            <div className="flex items-center gap-2 mr-1">
              <Switch
                id="show-deleted"
                checked={showDeleted}
                onCheckedChange={setShowDeleted}
              />
              <Label htmlFor="show-deleted" className="text-sm cursor-pointer">
                Show deleted
              </Label>
            </div>
          )}
          <Button asChild variant="outline">
            <Link to="/postop-bookings/analytics">
              <BarChart3 className="w-4 h-4 mr-1" /> Analytics
            </Link>
          </Button>
          <Button asChild>
            <Link to="/postop-bookings/new">
              <Plus className="w-4 h-4 mr-1" /> New booking
            </Link>
          </Button>
        </div>
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
            <Card key={b.id} className={`p-4 space-y-2 ${b.deleted_at ? "opacity-60 border-dashed" : ""}`}>
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium">
                      {b.hospital_number || <em className="text-muted-foreground">No hospital number</em>}
                    </span>
                    <Badge className={LEVEL_CLASS[b.predicted_level]} variant="secondary">
                      {LEVEL_LABEL[b.predicted_level]}
                    </Badge>
                    {b.deleted_at && (
                      <Badge variant="outline" className="text-destructive border-destructive/50">
                        Deleted
                      </Badge>
                    )}
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
                <div className="flex items-start gap-3 shrink-0">
                  <div className="text-sm text-right">
                    <div className="flex items-center gap-1 text-muted-foreground justify-end">
                      <CalendarClock className="w-3.5 h-3.5" />
                      {b.proposed_surgery_date
                        ? format(parseISO(b.proposed_surgery_date), "PP")
                        : "Date TBC"}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Booked {format(parseISO(b.created_at), "PP")}
                    </div>
                  </div>
                  <Button asChild size="sm" variant="outline">
                    <Link to="/postop-bookings/$id/edit" params={{ id: b.id }}>
                      <Pencil className="w-3.5 h-3.5 mr-1" /> Edit
                    </Link>
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setPendingDelete(b)}
                  >
                    <Trash2 className="w-3.5 h-3.5 mr-1" /> Delete
                  </Button>
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

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this post-op booking?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete?.hospital_number
                ? `This will remove the pre-booked ${LEVEL_LABEL[pendingDelete.predicted_level]} bed for hospital number ${pendingDelete.hospital_number}.`
                : "This will remove the pre-booked critical care bed."}{" "}
              This action cannot be undone from the app.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                onConfirmDelete();
              }}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? "Deleting…" : "Delete booking"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
