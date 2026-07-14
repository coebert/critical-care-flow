import { useEffect, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Global banner surface for shift-handover and other critical-care alerts.
 *
 * Currently surfaces a "shift handover" window banner (07:30–08:00 and
 * 19:30–20:00 local time). Dismissed per session via sessionStorage so
 * users don't see it every navigation but still see it next shift.
 */

function isHandoverWindow(now: Date): boolean {
  const h = now.getHours();
  const m = now.getMinutes();
  const t = h * 60 + m;
  const dayStart = 7 * 60 + 30;
  const dayEnd = 8 * 60;
  const nightStart = 19 * 60 + 30;
  const nightEnd = 20 * 60;
  return (t >= dayStart && t < dayEnd) || (t >= nightStart && t < nightEnd);
}

const DISMISS_KEY = "banner:handover-dismissed-at";

export function GlobalBannerSlot() {
  const [hydrated, setHydrated] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setHydrated(true);
    const raw = window.sessionStorage.getItem(DISMISS_KEY);
    if (raw) {
      const at = Number(raw);
      // Reset dismissal after 45 minutes so the next handover window shows again.
      if (Date.now() - at < 45 * 60 * 1000) setDismissed(true);
    }
    const id = window.setInterval(() => setNow(new Date()), 60 * 1000);
    return () => window.clearInterval(id);
  }, []);

  if (!hydrated) return null;
  if (dismissed) return null;
  if (!isHandoverWindow(now)) return null;

  const label = now.getHours() < 12 ? "Day handover in progress" : "Night handover in progress";

  return (
    <div
      role="status"
      className="flex items-center gap-2 px-3 sm:px-4 md:px-6 py-1.5 text-xs sm:text-sm border-b bg-amber-500/10 text-amber-900 dark:text-amber-100 border-amber-500/30"
    >
      <AlertTriangle className="w-4 h-4 shrink-0" />
      <span className="flex-1 min-w-0 truncate">
        {label} — take extra care with orders and transfers.
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 shrink-0"
        aria-label="Dismiss handover notice"
        onClick={() => {
          window.sessionStorage.setItem(DISMISS_KEY, String(Date.now()));
          setDismissed(true);
        }}
      >
        <X className="w-3.5 h-3.5" />
      </Button>
    </div>
  );
}
