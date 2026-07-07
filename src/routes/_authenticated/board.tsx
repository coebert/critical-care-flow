import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getBedBoard, getCapacitySnapshot } from "@/lib/beds.functions";
import { listReferralsForList } from "@/lib/referrals.functions";
import type { Referral } from "@/lib/referrals-list-utils";
import { formatElapsed } from "@/lib/referrals-list-utils";
import { dayOfStay } from "@/lib/bed-capacity";
import { X, Printer } from "lucide-react";

export const Route = createFileRoute("/_authenticated/board")({
  head: () => ({
    meta: [{ title: "Board — SDH Critical Care" }],
  }),
  component: BoardPage,
});

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function BoardPage() {
  const navigate = useNavigate();
  const now = useClock();

  const bedBoard = useQuery({
    queryKey: ["board", "bed-board"],
    queryFn: () => getBedBoard(),
    refetchInterval: 30_000,
  });
  const capacity = useQuery({
    queryKey: ["board", "capacity"],
    queryFn: () => getCapacitySnapshot(),
    refetchInterval: 30_000,
  });
  const referrals = useQuery({
    queryKey: ["board", "referrals"],
    queryFn: () => listReferralsForList() as unknown as Promise<Referral[]>,
    refetchInterval: 30_000,
  });

  useEffect(() => {
    // Realtime nudge — no data payload needed, just re-fetch.
    const ch = supabase
      .channel("board-refresh")
      .on("postgres_changes", { event: "*", schema: "public", table: "referrals" }, () => referrals.refetch())
      .on("postgres_changes", { event: "*", schema: "public", table: "bed_occupancies" }, () => { bedBoard.refetch(); capacity.refetch(); })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [bedBoard, capacity, referrals]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") navigate({ to: "/bed-board" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  const cap = capacity.data;
  const pending = (referrals.data ?? []).filter((r) => r.status === "pending" || (r.status === "accepted" && !r.arrived_on_unit_at));
  pending.sort((a, b) => new Date(a.referral_received_at).getTime() - new Date(b.referral_received_at).getTime());

  return (
    <div className="fixed inset-0 z-50 bg-black text-white flex flex-col overflow-hidden">
      {/* Top bar */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-white/10">
        <div className="flex items-center gap-6">
          <div>
            <div className="text-xs uppercase tracking-widest text-white/50">SDH Critical Care</div>
            <div className="text-2xl font-semibold">Live Board</div>
          </div>
          {cap && (
            <div className="flex items-center gap-4 text-lg">
              <CapCell label="ICU" a={cap.icu.occupied} b={cap.icu.total} />
              <CapCell label="HDU" a={cap.hdu.occupied} b={cap.hdu.total} />
              <div className="text-white/80">
                <span className="text-white/50 text-sm mr-1">Outliers</span>{cap.outliers_count}
              </div>
              <div className="text-white/80">
                <span className="text-white/50 text-sm mr-1">Transfers</span>{cap.open_transfers_count}
              </div>
              <div className="text-white/80">
                <span className="text-white/50 text-sm mr-1">Pending referrals</span>{pending.length}
              </div>
            </div>
          )}
        </div>
        <div className="flex items-center gap-6">
          <div className="text-4xl font-mono tabular-nums">{now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
          <Link to="/board/ward-round" className="text-white/60 hover:text-white text-sm underline flex items-center gap-1">
            <Printer className="w-4 h-4" /> Ward round
          </Link>
          <button
            onClick={() => navigate({ to: "/bed-board" })}
            className="text-white/60 hover:text-white text-sm underline flex items-center gap-1"
            aria-label="Exit board mode"
          >
            <X className="w-4 h-4" /> Exit
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-[2fr_1fr] overflow-hidden">
        <div className="overflow-auto border-r border-white/10">
          <BedsColumn data={bedBoard.data} now={now.getTime()} />
        </div>
        <div className="overflow-auto">
          <PendingColumn rows={pending} now={now.getTime()} />
        </div>
      </div>
    </div>
  );
}

function CapCell({ label, a, b }: { label: string; a: number; b: number }) {
  const full = a >= b;
  return (
    <div className={`px-3 py-1 rounded ${full ? "bg-red-600/30 text-red-100" : "bg-emerald-600/30 text-emerald-100"}`}>
      <span className="text-xs uppercase tracking-wider mr-2 text-white/70">{label}</span>
      <span className="font-mono tabular-nums text-xl">{a}/{b}</span>
    </div>
  );
}

type BedBoardData = Awaited<ReturnType<typeof getBedBoard>>;

function BedsColumn({ data, now }: { data: BedBoardData | undefined; now: number }) {
  if (!data) return <div className="p-6 text-white/50">Loading beds…</div>;
  const { beds, occupancies } = data;
  const live = occupancies.filter((o) => !o.discharged_at);
  const byBed = new Map(live.map((o) => [o.bed_id, o]));
  const groups: Array<{ label: string; unit: "icu" | "hdu" }> = [
    { label: "ICU", unit: "icu" },
    { label: "HDU", unit: "hdu" },
  ];
  return (
    <div className="p-4 space-y-6">
      {groups.map(({ label, unit }) => {
        const unitBeds = beds.filter((b) => b.active && b.unit === unit);
        return (
          <div key={unit}>
            <h2 className="text-sm uppercase tracking-widest text-white/50 mb-2">{label} · {unitBeds.length} beds</h2>
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2">
              {unitBeds.map((b) => {
                const occ = byBed.get(b.id);
                return (
                  <div
                    key={b.id}
                    className={`rounded border p-3 ${occ ? "bg-white/5 border-white/20" : "border-white/10 border-dashed text-white/40"}`}
                  >
                    <div className="flex items-baseline justify-between">
                      <div className="text-xs uppercase tracking-wider text-white/50">{b.code}</div>
                      {occ && (
                        <div className="text-[10px] px-1.5 py-0.5 rounded bg-white/10">
                          L{occ.level ?? "?"} · d{dayOfStay(occ.admitted_at ?? "", now)}
                        </div>
                      )}
                    </div>
                    {occ ? (
                      <>
                        <div className="mt-1 text-lg font-semibold truncate">
                          {occ.hospital_number ?? occ.patient_initials ?? "—"}
                        </div>
                        <div className="text-xs text-white/60 truncate">{occ.admitting_consultant ?? ""}</div>
                        <div className="mt-1 flex gap-1 text-[10px]">
                          {occ.ventilated && <Flag>V</Flag>}
                          {occ.nippv_cpap && <Flag>N</Flag>}
                          {occ.hfno && <Flag>H</Flag>}
                          {occ.vasopressors && <Flag tone="orange">P</Flag>}
                          {occ.renal_replacement && <Flag tone="blue">R</Flag>}
                          {occ.tracheostomy && <Flag>T</Flag>}
                          {occ.isolation && occ.isolation !== "none" && <Flag tone="red">ISO</Flag>}
                        </div>
                        {occ.predicted_discharge_at && (
                          <div className="mt-1 text-[10px] text-emerald-300/80">
                            ↗ {new Date(occ.predicted_discharge_at).toLocaleDateString([], { day: "2-digit", month: "short" })}
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="mt-2 text-sm text-white/50">Free</div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Flag({ children, tone }: { children: React.ReactNode; tone?: "red" | "orange" | "blue" }) {
  const cls =
    tone === "red" ? "bg-red-500/40 text-red-100" :
    tone === "orange" ? "bg-orange-500/40 text-orange-100" :
    tone === "blue" ? "bg-blue-500/40 text-blue-100" :
    "bg-white/15 text-white/90";
  return <span className={`px-1 py-0.5 rounded ${cls}`}>{children}</span>;
}

function PendingColumn({ rows, now }: { rows: Referral[]; now: number }) {
  return (
    <div className="p-4">
      <h2 className="text-sm uppercase tracking-widest text-white/50 mb-2">Pending referrals · {rows.length}</h2>
      {rows.length === 0 && <div className="text-white/40">No pending referrals.</div>}
      <ul className="space-y-2">
        {rows.map((r) => {
          const waitMs = r.status === "pending"
            ? now - new Date(r.referral_received_at).getTime()
            : now - new Date(r.decision_at ?? r.updated_at ?? r.referral_received_at).getTime();
          const critical = waitMs > 4 * 60 * 60 * 1000;
          return (
            <li key={r.id} className="rounded border border-white/15 bg-white/5 p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-lg font-semibold truncate">{r.hospital_number ?? r.patient_initials_last4 ?? "—"}</div>
                  <div className="text-xs text-white/60 truncate">{r.referring_specialty ?? "Unknown"} · {r.current_ward ?? ""}</div>
                </div>
                <div className={`text-2xl font-mono tabular-nums ${critical ? "text-red-400" : "text-amber-300"}`}>
                  {formatElapsed(waitMs)}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
