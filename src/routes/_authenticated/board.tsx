import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getBedBoard, getCapacitySnapshot } from "@/lib/beds.functions";
import { listReferralsForList } from "@/lib/referrals.functions";
import type { Referral } from "@/lib/referrals-list-utils";
import { formatElapsed } from "@/lib/referrals-list-utils";
import { dayOfStay } from "@/lib/bed-capacity";
import { X, Printer, Sun, Moon } from "lucide-react";

export const Route = createFileRoute("/_authenticated/board")({
  head: () => ({
    meta: [{ title: "Board — SDH Critical Care" }],
  }),
  component: BoardPage,
});

type Theme = "dark" | "light";
const THEME_KEY = "sdh-board-theme";

function useBoardTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>("dark");
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(THEME_KEY);
      if (stored === "light" || stored === "dark") setTheme(stored);
    } catch { /* ignore */ }
  }, []);
  const update = (t: Theme) => {
    setTheme(t);
    try { window.localStorage.setItem(THEME_KEY, t); } catch { /* ignore */ }
  };
  return [theme, update];
}

// Palette per theme. Keeps JSX readable and avoids `dark:` variants that
// depend on the app-wide theme class (the board is a fixed overlay).
type Palette = {
  root: string;
  border: string; // main dividers
  borderSoft: string;
  borderDashed: string;
  eyebrow: string; // small uppercase labels
  muted: string;
  subtle: string;
  cardFilled: string; // occupied bed card
  cardEmpty: string; // free bed card
  pill: string; // small L/day pill on beds
  chip: string; // pending referral card
  capOk: string;
  capFull: string;
  flagDefault: string;
  flagRed: string;
  flagOrange: string;
  flagBlue: string;
  timerWarn: string;
  timerCritical: string;
  exit: string;
  toggle: string;
};

const PALETTES: Record<Theme, Palette> = {
  dark: {
    root: "bg-black text-white",
    border: "border-white/10",
    borderSoft: "border-white/15",
    borderDashed: "border-white/10 border-dashed text-white/40",
    eyebrow: "text-white/50",
    muted: "text-white/60",
    subtle: "text-white/50",
    cardFilled: "bg-white/5 border-white/20",
    cardEmpty: "text-white/50",
    pill: "bg-white/10",
    chip: "border-white/15 bg-white/5",
    capOk: "bg-emerald-600/30 text-emerald-100",
    capFull: "bg-red-600/30 text-red-100",
    flagDefault: "bg-white/15 text-white/90",
    flagRed: "bg-red-500/40 text-red-100",
    flagOrange: "bg-orange-500/40 text-orange-100",
    flagBlue: "bg-blue-500/40 text-blue-100",
    timerWarn: "text-amber-300",
    timerCritical: "text-red-400",
    exit: "text-white/60 hover:text-white",
    toggle: "border-white/20 text-white/80 hover:bg-white/10",
  },
  light: {
    root: "bg-white text-slate-900",
    border: "border-slate-200",
    borderSoft: "border-slate-300",
    borderDashed: "border-slate-300 border-dashed text-slate-400",
    eyebrow: "text-slate-500",
    muted: "text-slate-600",
    subtle: "text-slate-500",
    cardFilled: "bg-slate-50 border-slate-300",
    cardEmpty: "text-slate-400",
    pill: "bg-slate-200 text-slate-700",
    chip: "border-slate-200 bg-slate-50",
    capOk: "bg-emerald-100 text-emerald-800",
    capFull: "bg-red-100 text-red-800",
    flagDefault: "bg-slate-200 text-slate-800",
    flagRed: "bg-red-200 text-red-900",
    flagOrange: "bg-orange-200 text-orange-900",
    flagBlue: "bg-blue-200 text-blue-900",
    timerWarn: "text-amber-700",
    timerCritical: "text-red-700",
    exit: "text-slate-600 hover:text-slate-900",
    toggle: "border-slate-300 text-slate-700 hover:bg-slate-100",
  },
};

const LEVEL_PILL: Record<number, string> = {
  0: "bg-emerald-500/40 text-emerald-50",
  1: "bg-sky-500/40 text-sky-50",
  2: "bg-amber-500/40 text-amber-50",
  3: "bg-rose-500/40 text-rose-50",
};

const LEVEL_TITLE: Record<number, string> = {
  0: "Level 0 — ward-level care",
  1: "Level 1 — at risk of deterioration",
  2: "Level 2 — HDU care",
  3: "Level 3 — ICU care",
};

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
  const [theme, setTheme] = useBoardTheme();
  const p = PALETTES[theme];

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
    const refreshBeds = () => { bedBoard.refetch(); capacity.refetch(); };
    const ch = supabase
      .channel("board-refresh")
      .on("postgres_changes", { event: "*", schema: "public", table: "referrals" }, () => referrals.refetch())
      .on("postgres_changes", { event: "*", schema: "public", table: "bed_occupancies" }, refreshBeds)
      .on("postgres_changes", { event: "*", schema: "public", table: "beds" }, refreshBeds)
      .on("postgres_changes", { event: "*", schema: "public", table: "bed_outliers" }, refreshBeds)
      .on("postgres_changes", { event: "*", schema: "public", table: "bed_transfers_out" }, refreshBeds)
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
    <div className={`fixed inset-0 z-50 flex flex-col overflow-hidden ${p.root}`}>
      {/* Top bar */}
      <div className={`flex items-center justify-between px-6 py-3 border-b ${p.border}`}>
        <div className="flex items-center gap-6">
          <div>
            <div className={`text-xs uppercase tracking-widest ${p.eyebrow}`}>SDH Critical Care</div>
            <div className="text-2xl font-semibold">Live Board</div>
          </div>
          {cap && (
            <div className="flex items-center gap-4 text-lg">
              <CapCell label="ICU" a={cap.icu.occupied} b={cap.icu.total} p={p} />
              <CapCell label="HDU" a={cap.hdu.occupied} b={cap.hdu.total} p={p} />
              <div className={p.muted}>
                <span className={`${p.eyebrow} text-sm mr-1`}>Outliers</span>{cap.outliers_count}
              </div>
              <div className={p.muted}>
                <span className={`${p.eyebrow} text-sm mr-1`}>Transfers</span>{cap.open_transfers_count}
              </div>
              <div className={p.muted}>
                <span className={`${p.eyebrow} text-sm mr-1`}>Pending referrals</span>{pending.length}
              </div>
            </div>
          )}
        </div>
        <div className="flex items-center gap-6">
          <div className="text-4xl font-mono tabular-nums">{now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
          <button
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            className={`text-sm rounded-md border px-2 py-1 flex items-center gap-1.5 ${p.toggle}`}
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          >
            {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            {theme === "dark" ? "Light" : "Dark"}
          </button>
          <Link to="/board/ward-round" className={`${p.exit} text-sm underline flex items-center gap-1`}>
            <Printer className="w-4 h-4" /> Ward round
          </Link>
          <button
            onClick={() => navigate({ to: "/bed-board" })}
            className={`${p.exit} text-sm underline flex items-center gap-1`}
            aria-label="Exit board mode"
          >
            <X className="w-4 h-4" /> Exit
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-[2fr_1fr] overflow-hidden">
        <div className={`overflow-auto border-r ${p.border}`}>
          <BedsColumn data={bedBoard.data} now={now.getTime()} p={p} />
        </div>
        <div className="overflow-auto">
          <PendingColumn rows={pending} now={now.getTime()} p={p} />
        </div>
      </div>
    </div>
  );
}

function CapCell({ label, a, b, p }: { label: string; a: number; b: number; p: Palette }) {
  const full = a >= b;
  return (
    <div className={`px-3 py-1 rounded ${full ? p.capFull : p.capOk}`}>
      <span className={`text-xs uppercase tracking-wider mr-2 ${p.eyebrow}`}>{label}</span>
      <span className="font-mono tabular-nums text-xl">{a}/{b}</span>
    </div>
  );
}

type BedBoardData = Awaited<ReturnType<typeof getBedBoard>>;

function BedsColumn({ data, now, p }: { data: BedBoardData | undefined; now: number; p: Palette }) {
  if (!data) return <div className={`p-6 ${p.subtle}`}>Loading beds…</div>;
  const { beds, occupancies } = data;
  const live = occupancies.filter((o) => !o.discharged_at);
  const byBed = new Map(live.map((o) => [o.bed_id, o]));
  const groups: Array<{ label: string; filter: (b: (typeof beds)[number]) => boolean }> = [
    { label: "Radnor Critical Care", filter: (b) => b.active },
  ];
  return (
    <div className="p-4 space-y-6">
      {groups.map(({ label, filter }) => {
        const unitBeds = beds.filter(filter).sort((a, b) => a.sort_order - b.sort_order);
        return (
          <div key={label}>
            <h2 className={`text-sm uppercase tracking-widest mb-2 ${p.eyebrow}`}>{label} · {unitBeds.length} beds</h2>
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2">
              {unitBeds.map((b) => {
                const occ = byBed.get(b.id);
                return (
                  <div
                    key={b.id}
                    className={`rounded border p-3 ${occ ? p.cardFilled : p.borderDashed}`}
                  >
                    <div className="flex items-baseline justify-between">
                      <div className={`text-xs uppercase tracking-wider ${p.eyebrow}`}>{b.code}</div>
                      {occ && (
                        <div
                          className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${LEVEL_PILL[occ.level ?? -1] ?? p.pill}`}
                          title={LEVEL_TITLE[occ.level ?? -1] ?? `Level ${occ.level ?? "?"}`}
                        >
                          L{occ.level ?? "?"} · d{dayOfStay(occ.admitted_at ?? "", now)}
                        </div>
                      )}
                    </div>
                    {occ ? (
                      <>
                        <div className="mt-1 text-lg font-semibold truncate">
                          {occ.hospital_number ?? occ.patient_initials ?? "—"}
                        </div>
                        <div className={`text-xs truncate ${p.muted}`}>{occ.admitting_consultant ?? ""}</div>
                        <div className="mt-1 flex gap-1 text-[10px]">
                          {occ.ventilated && <Flag p={p}>V</Flag>}
                          {occ.nippv_cpap && <Flag p={p}>N</Flag>}
                          {occ.hfno && <Flag p={p}>H</Flag>}
                          {occ.vasopressors && <Flag p={p} tone="orange">P</Flag>}
                          {occ.renal_replacement && <Flag p={p} tone="blue">R</Flag>}
                          {occ.tracheostomy && <Flag p={p}>T</Flag>}
                          {occ.isolation && occ.isolation !== "none" && <Flag p={p} tone="red">ISO</Flag>}
                          {(occ as { wardable?: boolean }).wardable && (
                            <span
                              className="px-1 py-0.5 rounded bg-emerald-500/40 text-emerald-100 font-semibold"
                              title="Wardable — ready for a ward bed"
                            >
                              WARDABLE
                            </span>
                          )}
                        </div>
                        {occ.predicted_discharge_at && (
                          <div className="mt-1 text-[10px] text-emerald-600 dark:text-emerald-300/80">
                            ↗ {new Date(occ.predicted_discharge_at).toLocaleDateString([], { day: "2-digit", month: "short" })}
                          </div>
                        )}
                      </>
                    ) : (
                      <div className={`mt-2 text-sm ${p.cardEmpty}`}>Free</div>
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

function Flag({ children, tone, p }: { children: React.ReactNode; tone?: "red" | "orange" | "blue"; p: Palette }) {
  const cls =
    tone === "red" ? p.flagRed :
    tone === "orange" ? p.flagOrange :
    tone === "blue" ? p.flagBlue :
    p.flagDefault;
  return <span className={`px-1 py-0.5 rounded ${cls}`}>{children}</span>;
}

function PendingColumn({ rows, now, p }: { rows: Referral[]; now: number; p: Palette }) {
  return (
    <div className="p-4">
      <h2 className={`text-sm uppercase tracking-widest mb-2 ${p.eyebrow}`}>Pending referrals · {rows.length}</h2>
      {rows.length === 0 && <div className={p.cardEmpty}>No pending referrals.</div>}
      <ul className="space-y-2">
        {rows.map((r) => {
          const waitMs = r.status === "pending"
            ? now - new Date(r.referral_received_at).getTime()
            : now - new Date(r.decision_at ?? r.updated_at ?? r.referral_received_at).getTime();
          const critical = waitMs > 4 * 60 * 60 * 1000;
          return (
            <li key={r.id} className={`rounded border p-3 ${p.chip}`}>
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-lg font-semibold truncate">{r.hospital_number ?? "—"}</div>
                  <div className={`text-xs truncate ${p.muted}`}>{r.referring_specialty ?? "Unknown"} · {r.current_ward ?? ""}</div>
                </div>
                <div className={`text-2xl font-mono tabular-nums ${critical ? p.timerCritical : p.timerWarn}`}>
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
