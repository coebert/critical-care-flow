import type { Referral } from "@/lib/referrals-list-utils";
import { formatElapsed } from "@/lib/referrals-list-utils";
import { formatUnitTime } from "@/lib/shift-clock";

export type PendingPalette = {
  eyebrow: string;
  cardEmpty: string;
  subtle: string;
  capFull: string;
  toggle: string;
  chip: string;
  muted: string;
  timerCritical: string;
  timerWarn: string;
};

export type PendingReferralsState = {
  loading: boolean;
  failed: boolean;
  lastLoadedAt: string | null;
  retrying: boolean;
  retry: () => void;
};

/**
 * TV board pending-referrals column. Distinguishes loading, a true empty
 * list, a failure with no data, and a failure showing the last good list
 * (labelled NOT current) — a load error is never shown as "No pending
 * referrals".
 */
export function PendingReferralsColumn({
  rows,
  state,
  now,
  p,
}: {
  rows: Referral[] | null;
  state: PendingReferralsState;
  now: Date;
  p: PendingPalette;
}) {
  const nowMs = now.getTime();
  return (
    <div className="p-3">
      <h2 className={`text-sm uppercase tracking-widest mb-2 ${p.eyebrow}`}>
        Pending referrals · {rows ? rows.length : "—"}
      </h2>
      {state.failed && (
        <div role="status" className={`mb-2 rounded p-2 text-base font-semibold ${p.capFull}`}>
          {rows && state.lastLoadedAt
            ? `Referrals could not be refreshed — list is from ${formatUnitTime(state.lastLoadedAt, now)} and is NOT current.`
            : "Referrals could not be loaded."}
          <button
            type="button"
            onClick={state.retry}
            disabled={state.retrying}
            className={`ml-2 text-base rounded-md border px-3 py-1 min-h-9 ${p.toggle}`}
          >
            {state.retrying ? "Retrying…" : "Retry now"}
          </button>
        </div>
      )}
      {state.loading && <div className={`text-base ${p.subtle}`}>Loading referrals…</div>}
      {rows && rows.length === 0 && !state.failed && <div className={`text-base ${p.cardEmpty}`}>No pending referrals.</div>}
      <ul className="space-y-2">
        {(rows ?? []).map((r) => {
          const waitMs = r.status === "pending"
            ? nowMs - new Date(r.referral_received_at).getTime()
            : nowMs - new Date(r.decision_at ?? r.updated_at ?? r.referral_received_at).getTime();
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
