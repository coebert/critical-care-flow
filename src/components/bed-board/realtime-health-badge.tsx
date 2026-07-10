import { useEffect, useRef, useState } from "react";
import { Activity, AlertTriangle, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";

type Status = "connecting" | "healthy" | "slow" | "degraded";

/**
 * Realtime latency / health indicator.
 *
 * Opens a dedicated Realtime broadcast channel and pings itself every few
 * seconds. Round-trip time approximates the delivery latency clinicians
 * would see for a `postgres_changes` event from the sibling apps: both
 * travel over the same websocket, so if this indicator is green at
 * <1000 ms the bed board is receiving DB events at roughly that speed.
 *
 * Colour thresholds:
 *   green  ≤ 1000 ms   healthy
 *   amber  ≤ 3000 ms   slow (still usable)
 *   red    > 3000 ms, no ping in 15 s, or channel error → degraded
 */
export function RealtimeHealthBadge() {
  const [status, setStatus] = useState<Status>("connecting");
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [lastAt, setLastAt] = useState<number | null>(null);
  const pendingRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let watchdog: ReturnType<typeof setInterval> | null = null;

    const channel = supabase.channel("bed-board-health", {
      config: { broadcast: { self: true, ack: false } },
    });

    channel.on("broadcast", { event: "ping" }, (payload) => {
      if (cancelled) return;
      const sentAt = (payload.payload as { t?: number } | undefined)?.t;
      if (typeof sentAt !== "number") return;
      const rtt = Date.now() - sentAt;
      pendingRef.current = null;
      setLatencyMs(rtt);
      setLastAt(Date.now());
      setStatus(rtt <= 1000 ? "healthy" : rtt <= 3000 ? "slow" : "degraded");
    });

    const sendPing = () => {
      const t = Date.now();
      pendingRef.current = t;
      channel.send({ type: "broadcast", event: "ping", payload: { t } }).catch(() => {
        if (!cancelled) setStatus("degraded");
      });
    };

    channel.subscribe((state) => {
      if (cancelled) return;
      if (state === "SUBSCRIBED") {
        sendPing();
        pingTimer = setInterval(sendPing, 5000);
        watchdog = setInterval(() => {
          // No round-trip in the last 15 s → treat as degraded.
          const last = lastRef.current;
          if (last && Date.now() - last > 15_000) {
            setStatus("degraded");
          }
          // A ping that never round-tripped for >5 s is also degraded.
          const pending = pendingRef.current;
          if (pending && Date.now() - pending > 5000) {
            setStatus((s) => (s === "healthy" ? "slow" : "degraded"));
          }
        }, 2000);
      } else if (state === "CHANNEL_ERROR" || state === "TIMED_OUT" || state === "CLOSED") {
        setStatus("degraded");
      }
    });

    return () => {
      cancelled = true;
      if (pingTimer) clearInterval(pingTimer);
      if (watchdog) clearInterval(watchdog);
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep a ref of lastAt for the watchdog interval without re-subscribing.
  const lastRef = useRef<number | null>(null);
  useEffect(() => {
    lastRef.current = lastAt;
  }, [lastAt]);

  const dotClass =
    status === "healthy"
      ? "bg-emerald-500"
      : status === "slow"
        ? "bg-amber-500"
        : status === "degraded"
          ? "bg-red-500"
          : "bg-muted-foreground/40";

  const label =
    status === "connecting"
      ? "Connecting…"
      : status === "degraded"
        ? latencyMs != null
          ? `Realtime degraded · ${latencyMs} ms`
          : "Realtime degraded"
        : `Realtime · ${latencyMs ?? "…"} ms`;

  const title =
    status === "connecting"
      ? "Opening the realtime channel…"
      : status === "degraded"
        ? "No recent round-trip on the realtime channel. Updates from other apps may be delayed. Try reloading if this persists."
        : `Round-trip latency on the realtime channel. Green ≤ 1s, amber ≤ 3s, red > 3s. Last measured ${latencyMs} ms.`;

  const Icon =
    status === "connecting" ? Loader2 : status === "degraded" ? AlertTriangle : Activity;

  return (
    <div
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs",
        status === "degraded"
          ? "border-red-500/40 bg-red-500/5 text-red-700 dark:text-red-400"
          : status === "slow"
            ? "border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-400"
            : "border-border bg-background text-muted-foreground",
      )}
      role="status"
      aria-live="polite"
      aria-label={label}
      title={title}
    >
      <span className={cn("inline-block h-2 w-2 rounded-full", dotClass)} aria-hidden="true" />
      <Icon
        className={cn("h-3.5 w-3.5", status === "connecting" && "animate-spin")}
        aria-hidden="true"
      />
      <span className="tabular-nums">{label}</span>
    </div>
  );
}
