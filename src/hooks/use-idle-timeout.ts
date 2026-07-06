import { useEffect, useRef, useState } from "react";

/**
 * NHS DTAC / Technical Assurance — idle session timeout.
 *
 * Signs the user out after `idleMs` of no interaction, or after `absoluteMs`
 * since sign-in regardless of activity, whichever comes first. Emits a
 * warning `warnMs` before expiry so the user can extend the session.
 *
 * Activity is coalesced (throttled to once per second) so it doesn't thrash.
 * `BroadcastChannel` keeps sibling tabs in sync: activity in one tab keeps
 * the others alive; sign-out in one tab wakes the others too.
 *
 * The timer resets on real user input (pointer / key / touch / visibility),
 * not on background fetches, so a Query poll can't keep a walked-away
 * session alive.
 */

const ACTIVITY_KEY = "idle:lastActivity";
const CHANNEL = "idle-timeout";

export interface UseIdleTimeoutOptions {
  /** Idle window before sign-out. Default 30 minutes. */
  idleMs?: number;
  /** Absolute maximum session length. Default 12 hours. */
  absoluteMs?: number;
  /** How long the warning modal shows before forced sign-out. Default 60s. */
  warnMs?: number;
  /** Called when the user is signed out for inactivity. */
  onTimeout: () => void | Promise<void>;
  /** Disable the whole thing (e.g. on the auth screen). */
  disabled?: boolean;
}

export interface IdleTimeoutState {
  /** True while the pre-expiry warning is showing. */
  warning: boolean;
  /** Seconds remaining until forced sign-out, when `warning` is true. */
  secondsLeft: number;
  /** Extend the session — resets the idle timer. */
  stayActive: () => void;
}

export function useIdleTimeout(options: UseIdleTimeoutOptions): IdleTimeoutState {
  const {
    idleMs = 30 * 60 * 1000,
    absoluteMs = 12 * 60 * 60 * 1000,
    warnMs = 60 * 1000,
    onTimeout,
    disabled = false,
  } = options;

  const [warning, setWarning] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(Math.ceil(warnMs / 1000));

  const startedAtRef = useRef<number>(Date.now());
  const lastActivityRef = useRef<number>(Date.now());
  const channelRef = useRef<BroadcastChannel | null>(null);
  const firedRef = useRef(false);
  const onTimeoutRef = useRef(onTimeout);
  onTimeoutRef.current = onTimeout;

  useEffect(() => {
    if (disabled || typeof window === "undefined") return;

    startedAtRef.current = Date.now();
    lastActivityRef.current = Date.now();
    firedRef.current = false;

    const channel: BroadcastChannel | null =
      typeof BroadcastChannel === "function" ? new BroadcastChannel(CHANNEL) : null;
    channelRef.current = channel;

    const recordActivity = (broadcast = true) => {
      const now = Date.now();
      // Coalesce to once per second — cheap enough for pointermove.
      if (now - lastActivityRef.current < 1000) return;
      lastActivityRef.current = now;
      try {
        window.sessionStorage.setItem(ACTIVITY_KEY, String(now));
      } catch {
        /* private mode etc. */
      }
      if (broadcast) channel?.postMessage({ type: "activity", ts: now });
      if (warning) setWarning(false);
    };

    const handleUserEvent = () => recordActivity(true);

    const handleVisibility = () => {
      if (document.visibilityState === "visible") recordActivity(true);
    };

    channel?.addEventListener("message", (ev) => {
      const data = ev.data as { type?: string; ts?: number } | null;
      if (!data) return;
      if (data.type === "activity" && typeof data.ts === "number") {
        lastActivityRef.current = Math.max(lastActivityRef.current, data.ts);
        if (warning) setWarning(false);
      } else if (data.type === "signout") {
        // Sibling tab already signed out — mirror it.
        if (!firedRef.current) {
          firedRef.current = true;
          void onTimeoutRef.current();
        }
      }
    });

    window.addEventListener("pointerdown", handleUserEvent, { passive: true });
    window.addEventListener("keydown", handleUserEvent, { passive: true });
    window.addEventListener("touchstart", handleUserEvent, { passive: true });
    window.addEventListener("visibilitychange", handleVisibility);

    const tick = window.setInterval(() => {
      if (firedRef.current) return;
      const now = Date.now();
      const idleFor = now - lastActivityRef.current;
      const sessionFor = now - startedAtRef.current;
      const absoluteRemaining = absoluteMs - sessionFor;
      const idleRemaining = idleMs - idleFor;
      const remaining = Math.min(idleRemaining, absoluteRemaining);

      if (remaining <= 0) {
        firedRef.current = true;
        setWarning(false);
        channel?.postMessage({ type: "signout" });
        void onTimeoutRef.current();
        return;
      }
      if (remaining <= warnMs) {
        setWarning(true);
        setSecondsLeft(Math.max(1, Math.ceil(remaining / 1000)));
      } else if (warning) {
        setWarning(false);
      }
    }, 1000);

    return () => {
      window.clearInterval(tick);
      window.removeEventListener("pointerdown", handleUserEvent);
      window.removeEventListener("keydown", handleUserEvent);
      window.removeEventListener("touchstart", handleUserEvent);
      window.removeEventListener("visibilitychange", handleVisibility);
      channel?.close();
      channelRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, idleMs, absoluteMs, warnMs]);

  const stayActive = () => {
    lastActivityRef.current = Date.now();
    setWarning(false);
    channelRef.current?.postMessage({ type: "activity", ts: lastActivityRef.current });
  };

  return { warning, secondsLeft, stayActive };
}
