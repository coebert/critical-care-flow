import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { listCancellations } from "@/lib/postop-bookings.functions";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { format, parseISO } from "date-fns";
import { ArrowLeft, Download } from "lucide-react";
import {
  POSTOP_CANCELLATION_LABEL,
  POSTOP_CANCELLATION_REASONS,
  type PostopCancellationReason,
} from "@/lib/postop-lifecycle";

export const Route = createFileRoute(
  "/_authenticated/postop-bookings/cancellations",
)({
  head: () => ({
    meta: [{ title: "Post-op cancellations — SDH Critical Care" }],
  }),
  component: CancellationsPage,
});

type Row = {
  id: string;
  hospital_number: string | null;
  proposed_procedure: string | null;
  proposed_surgery_date: string | null;
  predicted_level: string;
  surgical_specialty: string | null;
  cancellation_reason: PostopCancellationReason | null;
  cancellation_notes: string | null;
  cancelled_at: string | null;
  cancelled_by_name: string | null;
};

function CancellationsPage() {
  const load = useServerFn(listCancellations);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [reason, setReason] = useState<PostopCancellationReason | "">("");

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    const args: Record<string, string> = {};
    if (from) args.from = from;
    if (to) args.to = to;
    if (reason) args.reason = reason;
    load(Object.keys(args).length ? ({ data: args as any } as any) : undefined)
      .then((d) => {
        if (!cancelled) setRows(d as Row[]);
      })
      .catch((e) => {
        if (!cancelled) setError(e?.message ?? "Not authorised or failed to load");
      });
    return () => {
      cancelled = true;
    };
  }, [load, from, to, reason]);

  const noBedCount = useMemo(
    () => (rows ?? []).filter((r) => r.cancellation_reason === "no_bed").length,
    [rows],
  );

  const downloadCsv = () => {
    if (!rows) return;
    const headers = [
      "cancelled_at",
      "hospital_number",
      "proposed_surgery_date",
      "predicted_level",
      "specialty",
      "reason",
      "notes",
      "cancelled_by",
    ];
    const escape = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [headers.join(",")];
    for (const r of rows) {
      lines.push(
        [
          r.cancelled_at ?? "",
          r.hospital_number ?? "",
          r.proposed_surgery_date ?? "",
          r.predicted_level ?? "",
          r.surgical_specialty ?? "",
          r.cancellation_reason ? POSTOP_CANCELLATION_LABEL[r.cancellation_reason] : "",
          r.cancellation_notes ?? "",
          r.cancelled_by_name ?? "",
        ].map(escape).join(","),
      );
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `postop-cancellations-${format(new Date(), "yyyy-MM-dd")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="max-w-6xl mx-auto p-4 sm:p-6 space-y-4">
      <div className="flex items-center gap-2">
        <Button asChild size="sm" variant="ghost">
          <Link to="/postop-bookings">
            <ArrowLeft className="w-4 h-4 mr-1" /> Bookings
          </Link>
        </Button>
        <h1 className="text-2xl font-semibold">Cancellation register</h1>
      </div>

      <Card className="p-4 grid gap-3 sm:grid-cols-4">
        <div>
          <Label className="text-xs">From</Label>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <Label className="text-xs">To</Label>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div>
          <Label className="text-xs">Reason</Label>
          <Select
            value={reason || "all"}
            onValueChange={(v) => setReason(v === "all" ? "" : (v as PostopCancellationReason))}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All reasons</SelectItem>
              {POSTOP_CANCELLATION_REASONS.map((r) => (
                <SelectItem key={r} value={r}>
                  {POSTOP_CANCELLATION_LABEL[r]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-end">
          <Button variant="outline" onClick={downloadCsv} disabled={!rows?.length}>
            <Download className="w-4 h-4 mr-1" /> CSV
          </Button>
        </div>
      </Card>

      {error && (
        <Card className="p-4 border-destructive/50 text-destructive text-sm">{error}</Card>
      )}

      {rows && (
        <Card className="p-4">
          <div className="text-sm text-muted-foreground mb-3">
            {rows.length} cancellation{rows.length === 1 ? "" : "s"} · {noBedCount} due to no bed
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b">
                  <th className="py-2 pr-2">Cancelled</th>
                  <th className="py-2 pr-2">HN</th>
                  <th className="py-2 pr-2">Surgery date</th>
                  <th className="py-2 pr-2">Specialty</th>
                  <th className="py-2 pr-2">Reason</th>
                  <th className="py-2 pr-2">Notes</th>
                  <th className="py-2 pr-2">By</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="py-6 text-center text-muted-foreground">
                      No cancellations match the current filters.
                    </td>
                  </tr>
                )}
                {rows.map((r) => (
                  <tr key={r.id} className="border-b last:border-0">
                    <td className="py-2 pr-2 whitespace-nowrap">
                      {r.cancelled_at ? format(parseISO(r.cancelled_at), "dd/MM/yyyy HH:mm") : "—"}
                    </td>
                    <td className="py-2 pr-2">{r.hospital_number ?? "—"}</td>
                    <td className="py-2 pr-2 whitespace-nowrap">
                      {r.proposed_surgery_date
                        ? format(parseISO(r.proposed_surgery_date), "dd/MM/yyyy")
                        : "—"}
                    </td>
                    <td className="py-2 pr-2">{r.surgical_specialty ?? "—"}</td>
                    <td className="py-2 pr-2">
                      {r.cancellation_reason
                        ? POSTOP_CANCELLATION_LABEL[r.cancellation_reason]
                        : "—"}
                    </td>
                    <td className="py-2 pr-2 max-w-xs truncate" title={r.cancellation_notes ?? ""}>
                      {r.cancellation_notes ?? "—"}
                    </td>
                    <td className="py-2 pr-2">{r.cancelled_by_name ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
