import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { z } from "zod";
import { useUnitCapacity, usePatientAcuityRows } from "@/hooks/use-unit-capacity";
import { WardRoundList, wardRoundIsCurrent } from "@/components/board/ward-round-list";

export const Route = createFileRoute("/_authenticated/board_/ward-round")({
  head: () => ({
    meta: [
      { title: "Ward round list — SDH Critical Care" },
      { name: "description", content: "Printable ward round list from the ICU Handover Hub bed snapshot." },
    ],
  }),
  validateSearch: zodValidator(z.object({
    auto: fallback(z.string(), "").default(""),
  })),
  component: WardRoundPage,
});

/**
 * Printable ward round list. Uses the same shared Hub snapshot hooks as the
 * Bed Board; auto-print only fires for a current, complete list.
 */
function WardRoundPage() {
  const { auto } = Route.useSearch();
  const capacity = useUnitCapacity();
  const acuity = usePatientAcuityRows();
  const current = wardRoundIsCurrent(capacity);
  const acuityFailed = acuity.status === "error";

  useEffect(() => {
    if (auto === "1" && current && !acuityFailed) {
      const t = setTimeout(() => window.print(), 400);
      return () => clearTimeout(t);
    }
  }, [auto, current, acuityFailed]);

  return (
    <div className="p-6 max-w-6xl mx-auto text-sm print:p-0 print:max-w-none">
      <style>{`
        @media print {
          @page { size: A4 landscape; margin: 10mm; }
          body { background: white !important; }
          .no-print { display: none !important; }
        }
      `}</style>

      <div className="flex flex-wrap items-center justify-between gap-2 mb-4 no-print">
        <div>
          <h1 className="text-xl font-semibold">Ward round list</h1>
          <p className="text-xs text-muted-foreground">One row per occupied bed from ICU Handover Hub. Blank column for jobs &amp; plan.</p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className="min-h-9 rounded-md border px-3 text-sm disabled:opacity-50"
            onClick={() => window.print()}
            disabled={!capacity.board}
          >
            Print
          </button>
          <button type="button" className="min-h-9 rounded-md border px-3 text-sm" onClick={() => capacity.refresh()}>
            Refresh
          </button>
          <button type="button" className="min-h-9 px-2 text-sm underline" onClick={() => window.history.back()}>
            Back
          </button>
        </div>
      </div>
      <WardRoundList capacity={capacity} acuity={{ status: acuity.status, data: acuity.data }} />
    </div>
  );
}
