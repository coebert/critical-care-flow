import { useEffect, useState } from "react";
import { getTimerInfo, type Referral } from "@/lib/referrals-list-utils";

/**
 * Live-updating elapsed-time counter for a single referral row. Ticks every
 * 30 s (the list also re-sorts on the same cadence when timer sort is on).
 */
export function ReferralTimer({ r }: { r: Referral }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);
  const info = getTimerInfo(r, now);
  if (!info) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <div className="flex flex-col leading-tight">
      <span className={`font-mono text-sm tabular-nums ${info.tone}`}>{info.value}</span>
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{info.label}</span>
    </div>
  );
}
