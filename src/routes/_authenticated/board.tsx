import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import {
  getPartnerBedBoard,
  type PartnerBedBoardOk,
  type PartnerBedSlot,
} from "@/lib/partner-bed-board.functions";
import { getPatientAcuity } from "@/lib/patient-acuity.functions";
import { listReferralsForList } from "@/lib/referrals.functions";
import type { Referral } from "@/lib/referrals-list-utils";
import { formatElapsed } from "@/lib/referrals-list-utils";
import { X, Printer, Sun, Moon, Maximize, Minimize, ZoomIn, ZoomOut, Contrast } from "lucide-react";

export const Route = createFileRoute("/_authenticated/board")({
  head: () => ({
    meta: [{ title: "Board — SDH Critical Care" }],
  }),
  component: BoardPage,
});

type Theme = "dark" | "light" | "hc";
const THEME_KEY = "sdh-board-theme";

function useBoardTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>("dark");
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(THEME_KEY);
      if (stored === "light" || stored === "dark" || stored === "hc") setTheme(stored);
    } catch { /* ignore */ }
  }, []);
  const update = (t: Theme) => {
    setTheme(t);
    try { window.localStorage.setItem(THEME_KEY, t); } catch { /* ignore */ }
  };
  return [theme, update];
}

const ZOOM_KEY = "sdh-board-zoom";
const ZOOM_MIN = 0.7;
const ZOOM_MAX = 1.8;
const ZOOM_STEP = 0.1;
const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));

function useBoardZoom(): [number, (z: number) => void] {
  const [zoom, setZoom] = useState<number>(1);
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(ZOOM_KEY);
      const n = stored ? parseFloat(stored) : NaN;
      if (isFinite(n)) setZoom(clampZoom(n));
    } catch { /* ignore */ }
  }, []);
  const update = (z: number) => {
    const c = clampZoom(z);
    setZoom(c);
    try { window.localStorage.setItem(ZOOM_KEY, String(c)); } catch { /* ignore */ }
  };
  return [zoom, update];
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
  hc: {
    root: "bg-black text-white",
    border: "border-white",
    borderSoft: "border-white",
    borderDashed: "border-white border-dashed text-white",
    eyebrow: "text-yellow-300",
    muted: "text-white",
    subtle: "text-white",
    cardFilled: "bg-black border-white border-2",
    cardEmpty: "text-white",
    pill: "bg-white text-black font-bold",
    chip: "border-white border-2 bg-black",
    capOk: "bg-emerald-400 text-black font-bold",
    capFull: "bg-red-500 text-white font-bold",
    flagDefault: "bg-white text-black font-bold",
    flagRed: "bg-red-500 text-white font-bold",
    flagOrange: "bg-orange-400 text-black font-bold",
    flagBlue: "bg-sky-400 text-black font-bold",
    timerWarn: "text-yellow-300 font-bold",
    timerCritical: "text-red-400 font-bold",
    exit: "text-white hover:text-yellow-300",
    toggle: "border-white border-2 text-white hover:bg-white hover:text-black",
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

// Returns null until after hydration. Reading the wall clock during render
// would make the server-rendered markup differ from the client's first
// render (and `toLocaleTimeString` is timezone-dependent), which React 19
// reports as a hydration mismatch.
function useClock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function useBoardFullscreen() {
  const [active, setActive] = useState(false);
  useEffect(() => {
    const sync = () => setActive(Boolean(document.fullscreenElement));
    sync();
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);
  const toggle = () => {
    if (typeof document === "undefined") return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  };
  return [active, toggle] as const;
}

function BoardPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const clock = useClock();
  const now = clock ?? new Date(0);
  const [theme, setTheme] = useBoardTheme();
  const [isFullscreen, toggleFullscreen] = useBoardFullscreen();
  const [zoom, setZoom] = useBoardZoom();
  const p = PALETTES[theme];


  const fetchBoard = useServerFn(getPartnerBedBoard);
  const fetchAcuity = useServerFn(getPatientAcuity);
  const bedBoard = useQuery({
    queryKey: ["board", "partner-bed-board"],
    queryFn: () => fetchBoard(),
    refetchInterval: 20_000,
  });
  const acuity = useQuery({
    queryKey: ["board", "patient-acuity"],
    queryFn: () => fetchAcuity(),
    refetchInterval: 30_000,
  });
  const referrals = useQuery({
    queryKey: ["board", "referrals"],
    queryFn: () => listReferralsForList() as unknown as Promise<Referral[]>,
    refetchInterval: 30_000,
  });

  useEffect(() => {
    const ch = supabase
      .channel("board-refresh")
      .on("postgres_changes", { event: "*", schema: "public", table: "referrals" }, () =>
        qc.invalidateQueries({ queryKey: ["board", "referrals"] }),
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "patient_acuity_overrides" }, () =>
        qc.invalidateQueries({ queryKey: ["board", "patient-acuity"] }),
      )
      .subscribe();
    return () => { supabase.removeChannel(ch); };
    // `qc` is stable; depending on the query objects re-subscribed the
    // realtime channel on nearly every render.
  }, [qc]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") navigate({ to: "/bed-board" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  const partner = bedBoard.data && bedBoard.data.ok ? bedBoard.data : null;
  const acuityMap = new Map<string, { level: number; one_to_one: boolean }>();
  for (const r of acuity.data ?? []) {
    acuityMap.set(r.partner_patient_id, {
      level: Number(r.level),
      one_to_one: r.one_to_one === true,
    });
  }
  const pending = (referrals.data ?? []).filter((r) => r.status === "pending" || (r.status === "accepted" && !r.arrived_on_unit_at));
  pending.sort((a, b) => new Date(a.referral_received_at).getTime() - new Date(b.referral_received_at).getTime());

  return (
    <div
      className={`fixed inset-0 z-50 flex flex-col overflow-hidden ${p.root}`}
      style={{ zoom }}
    >
      {/* Top bar */}
      <div className={`flex items-center justify-between px-4 py-2 border-b ${p.border}`}>
        <div className="flex items-center gap-6">
          <div>
            <div className={`text-sm uppercase tracking-widest ${p.eyebrow}`}>SDH Critical Care</div>
            <div className="text-4xl font-semibold">Live Board</div>
          </div>
          {partner && (
            <div className="flex items-center gap-4 text-2xl">
              <CapCell label="ICU" a={partner.stats.occupied} b={partner.stats.total_beds} p={p} />
              <div className={p.muted}>
                <span className={`${p.eyebrow} text-base mr-1`}>Available</span>{partner.stats.available}
              </div>
              <div className={p.muted}>
                <span className={`${p.eyebrow} text-base mr-1`}>Unassigned</span>{partner.stats.unassigned}
              </div>
              <div className={p.muted}>
                <span className={`${p.eyebrow} text-base mr-1`}>Pending referrals</span>{pending.length}
              </div>
            </div>
          )}
        </div>
        <div className="flex items-center gap-6">
          <div className="text-6xl font-mono tabular-nums">{clock ? clock.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "--:--"}</div>
          <div className={`inline-flex items-center rounded-md border overflow-hidden ${p.toggle}`}>
            <button
              onClick={() => setZoom(zoom - ZOOM_STEP)}
              disabled={zoom <= ZOOM_MIN + 0.001}
              className="px-2 py-1.5 disabled:opacity-40"
              aria-label="Decrease zoom"
              title="Decrease zoom"
            >
              <ZoomOut className="w-4 h-4" />
            </button>
            <button
              onClick={() => setZoom(1)}
              className="px-2 py-1.5 text-sm font-mono tabular-nums min-w-[3rem] border-x border-inherit"
              aria-label={`Reset zoom (currently ${Math.round(zoom * 100)}%)`}
              title="Reset zoom to 100%"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              onClick={() => setZoom(zoom + ZOOM_STEP)}
              disabled={zoom >= ZOOM_MAX - 0.001}
              className="px-2 py-1.5 disabled:opacity-40"
              aria-label="Increase zoom"
              title="Increase zoom"
            >
              <ZoomIn className="w-4 h-4" />
            </button>
          </div>
          {(() => {
            const order: Theme[] = ["dark", "light", "hc"];
            const labels: Record<Theme, string> = { dark: "Dark", light: "Light", hc: "High contrast" };
            const next = order[(order.indexOf(theme) + 1) % order.length];
            const Icon = theme === "dark" ? Sun : theme === "light" ? Contrast : Moon;
            return (
              <button
                onClick={() => setTheme(next)}
                className={`text-base rounded-md border px-3 py-1.5 flex items-center gap-2 ${p.toggle}`}
                aria-label={`Switch to ${labels[next]} mode (currently ${labels[theme]})`}
                title={`Switch to ${labels[next]} mode`}
              >
                <Icon className="w-4 h-4" />
                {labels[next]}
              </button>
            );
          })()}
          <button
            onClick={toggleFullscreen}
            className={`text-base rounded-md border px-3 py-1.5 flex items-center gap-2 ${p.toggle}`}
            aria-label={isFullscreen ? "Exit full screen" : "Enter full screen"}
            title={isFullscreen ? "Exit full screen (F11)" : "Enter full screen (F11)"}
          >
            {isFullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
            {isFullscreen ? "Exit" : "Full screen"}
          </button>
          <Link to="/board/ward-round" className={`${p.exit} text-base underline flex items-center gap-2`}>
            <Printer className="w-4 h-4" /> Ward round
          </Link>
          <button
            onClick={() => navigate({ to: "/bed-board" })}
            className={`${p.exit} text-base underline flex items-center gap-2`}
            aria-label="Exit board mode"
          >
            <X className="w-4 h-4" /> Exit
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-[3fr_1fr] xl:grid-cols-[4fr_1fr] overflow-hidden">
        <div className={`overflow-auto border-r ${p.border}`}>
          <BedsColumn data={partner} acuityMap={acuityMap} now={clock ? clock.getTime() : 0} p={p} />
        </div>
        <div className="overflow-auto">
          <PendingColumn rows={pending} now={clock ? clock.getTime() : 0} p={p} />
        </div>
      </div>
    </div>
  );
}

function CapCell({ label, a, b, p }: { label: string; a: number; b: number; p: Palette }) {
  const full = a >= b;
  return (
    <div className={`px-3 py-1 rounded ${full ? p.capFull : p.capOk}`}>
      <span className={`text-sm uppercase tracking-wider mr-2 ${p.eyebrow}`}>{label}</span>
      <span className="font-mono tabular-nums text-2xl">{a}/{b}</span>
    </div>
  );
}

function BedsColumn({
  data,
  acuityMap,
  now,
  p,
}: {
  data: PartnerBedBoardOk | null;
  acuityMap: Map<string, { level: number; one_to_one: boolean }>;
  now: number;
  p: Palette;
}) {
  if (!data) return <div className={`p-6 ${p.subtle}`}>Loading beds…</div>;
  const slots: PartnerBedSlot[] = [...data.bed_board].sort((a, b) =>
    a.bed.localeCompare(b.bed, undefined, { numeric: true }),
  );
  const dayOfStay = (iso: string | null | undefined): number | null => {
    if (!iso) return null;
    const t = Date.parse(iso);
    if (!isFinite(t)) return null;
    return Math.max(1, Math.floor((now - t) / 86_400_000) + 1);
  };
  return (
    <div className="p-3 min-h-full grid grid-rows-[auto_1fr]">
      <div>
        <h2 className={`text-sm uppercase tracking-widest mb-2 ${p.eyebrow}`}>
          {data.unit} · {slots.length} beds
        </h2>
      </div>
        <div className="grid grid-cols-1 sm:grid-cols-[repeat(auto-fit,minmax(320px,1fr))] gap-2 auto-rows-[minmax(160px,1fr)]">
          {slots.map((s) => {
            const occ = s.occupant;
            const info = occ ? acuityMap.get(occ.id) : undefined;
            const level = info?.level;
            const day = occ ? dayOfStay(occ.admission_date) : null;
            return (
              <div
                key={s.bed}
                className={`rounded border p-3 h-full flex flex-col ${occ ? p.cardFilled : p.borderDashed}`}
              >
                <div className="flex items-baseline justify-between gap-1">
                  <div className={`text-[11px] uppercase tracking-wider ${p.eyebrow}`}>{s.bed}</div>
                  {occ && (
                    <div
                      className={`text-xs px-2 py-0.5 rounded font-semibold ${level != null ? LEVEL_PILL[level] ?? p.pill : p.pill}`}
                      title={level != null ? LEVEL_TITLE[level] ?? `Level ${level}` : "Acuity not set"}
                    >
                      L{level ?? "?"}{day != null ? ` · d${day}` : ""}
                    </div>
                  )}
                </div>
                {occ ? (
                  <>
                    <div className="mt-0.5 text-xl leading-tight font-semibold truncate">
                      {occ.full_name || occ.hospital_number || "—"}
                    </div>
                    <div className={`text-sm leading-tight truncate ${p.muted}`}>
                      {occ.hospital_number ?? ""}
                      {occ.age != null ? ` · ${occ.age}y` : ""}
                    </div>
                    <div className="mt-auto pt-1 flex gap-1.5 text-xs flex-wrap">
                      {info?.one_to_one && <Flag p={p} tone="red">1:1</Flag>}
                      {occ.tep_in_place && <Flag p={p} tone="blue">TEP</Flag>}
                      {occ.dnacpr_decision && <Flag p={p} tone="orange">DNACPR</Flag>}
                      {s.is_side_room && <Flag p={p}>SR</Flag>}
                    </div>
                  </>
                ) : (
                  <div className={`mt-1 text-base ${p.cardEmpty}`}>Free</div>
                )}
              </div>
            );
          })}
      </div>
    </div>

  );
}


function Flag({ children, tone, p }: { children: React.ReactNode; tone?: "red" | "orange" | "blue"; p: Palette }) {
  const cls =
    tone === "red" ? p.flagRed :
    tone === "orange" ? p.flagOrange :
    tone === "blue" ? p.flagBlue :
    p.flagDefault;
  return <span className={`px-1.5 py-0.5 rounded text-sm ${cls}`}>{children}</span>;
}

function PendingColumn({ rows, now, p }: { rows: Referral[]; now: number; p: Palette }) {
  return (
    <div className="p-3">
      <h2 className={`text-sm uppercase tracking-widest mb-2 ${p.eyebrow}`}>Pending referrals · {rows.length}</h2>
      {rows.length === 0 && <div className={`text-base ${p.cardEmpty}`}>No pending referrals.</div>}
      <ul className="space-y-2">
        {rows.map((r) => {
          const waitMs = r.status === "pending"
            ? now - new Date(r.referral_received_at).getTime()
            : now - new Date(r.decision_at ?? r.updated_at ?? r.referral_received_at).getTime();
          const critical = waitMs > 4 * 60 * 60 * 1000;
          return (
            <li key={r.id} className={`rounded border p-2 ${p.chip}`}>
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-xl font-semibold truncate">{r.hospital_number ?? "—"}</div>
                  <div className={`text-sm truncate ${p.muted}`}>{r.referring_specialty ?? "Unknown"} · {r.current_ward ?? ""}</div>
                </div>
                <div className={`text-3xl font-mono tabular-nums ${critical ? p.timerCritical : p.timerWarn}`}>
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
