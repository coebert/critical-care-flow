import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { getBedBoard } from "@/lib/beds.functions";
import { dayOfStay } from "@/lib/bed-capacity";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { z } from "zod";

export const Route = createFileRoute("/_authenticated/board/ward-round")({
  head: () => ({
    meta: [{ title: "Ward round list — SDH Critical Care" }],
  }),
  validateSearch: zodValidator(z.object({
    auto: fallback(z.string(), "").default(""),
  })),
  component: WardRoundPage,
});

function WardRoundPage() {
  const { auto } = Route.useSearch();
  const now = Date.now();
  const bedBoard = useQuery({
    queryKey: ["ward-round", "bed-board"],
    queryFn: () => getBedBoard(),
  });

  useEffect(() => {
    if (auto === "1" && bedBoard.data) {
      const t = setTimeout(() => window.print(), 400);
      return () => clearTimeout(t);
    }
  }, [auto, bedBoard.data]);

  const beds = bedBoard.data?.beds ?? [];
  const occ = (bedBoard.data?.occupancies ?? []).filter((o) => !o.discharged_at);
  const byBed = new Map(occ.map((o) => [o.bed_id, o]));
  const rows = beds
    .filter((b) => b.active && byBed.has(b.id))
    .sort((a, b) => (a.unit === b.unit ? a.sort_order - b.sort_order : a.unit === "icu" ? -1 : 1));

  return (
    <div className="p-6 max-w-6xl mx-auto text-sm print:p-0 print:max-w-none">
      <style>{`
        @media print {
          @page { size: A4 landscape; margin: 10mm; }
          body { background: white !important; }
          .no-print { display: none !important; }
        }
      `}</style>

      <div className="flex items-center justify-between mb-4 no-print">
        <div>
          <h1 className="text-xl font-semibold">Ward round list</h1>
          <p className="text-xs text-muted-foreground">One row per occupied bed. Blank column for jobs & plan.</p>
        </div>
        <div className="flex gap-2">
          <button className="text-sm underline" onClick={() => window.print()}>Print</button>
          <button className="text-sm underline" onClick={() => window.history.back()}>Back</button>
        </div>
      </div>

      <div className="mb-2 text-xs text-muted-foreground">
        Printed {new Date().toLocaleString()} · {rows.length} occupied beds
      </div>

      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="bg-muted/40 text-left">
            <th className="border p-1 w-14">Bed</th>
            <th className="border p-1 w-32">Patient</th>
            <th className="border p-1 w-16">Level / day</th>
            <th className="border p-1 w-40">Consultant</th>
            <th className="border p-1 w-40">Support</th>
            <th className="border p-1 w-24">Predicted d/c</th>
            <th className="border p-1">Jobs &amp; plan</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => {
            const o = byBed.get(b.id)!;
            const flags = [
              o.ventilated && "IPPV",
              o.nippv_cpap && "NIV",
              o.hfno && "HFNO",
              o.vasopressors && "Vaso",
              o.renal_replacement && "RRT",
              o.tracheostomy && "Trach",
              o.isolation && o.isolation !== "none" && `Iso (${o.isolation})`,
            ].filter(Boolean).join(" · ");
            return (
              <tr key={b.id} className="align-top">
                <td className="border p-1 font-semibold">{b.name}</td>
                <td className="border p-1">
                  <div className="font-medium">{o.hospital_number ?? o.patient_initials ?? "—"}</div>
                  {o.patient_initials && o.hospital_number && (
                    <div className="text-[10px] text-muted-foreground">{o.patient_initials}</div>
                  )}
                </td>
                <td className="border p-1">L{o.level ?? "?"} · d{dayOfStay(o.admitted_at ?? "", now)}</td>
                <td className="border p-1">{o.admitting_consultant ?? ""}</td>
                <td className="border p-1">{flags || "—"}</td>
                <td className="border p-1">
                  {o.predicted_discharge_at
                    ? new Date(o.predicted_discharge_at).toLocaleDateString([], { day: "2-digit", month: "short" })
                    : "—"}
                </td>
                <td className="border p-1 h-16"></td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr><td colSpan={7} className="border p-4 text-center text-muted-foreground">No occupied beds.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
