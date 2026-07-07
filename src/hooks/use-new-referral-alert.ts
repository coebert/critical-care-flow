import { useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";

const STORAGE_KEY = "sdh-referral-alerts";
const DEBOUNCE_MS = 3000;

export function isAlertsEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(STORAGE_KEY) === "1";
}

export function setAlertsEnabled(v: boolean) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, v ? "1" : "0");
  window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
}

let sharedCtx: AudioContext | null = null;
function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!sharedCtx) sharedCtx = new Ctor();
  return sharedCtx;
}

/** Prime the AudioContext from a user gesture so subsequent programmatic beeps work. */
export async function primeAudio() {
  const ctx = getCtx();
  if (!ctx) return;
  if (ctx.state === "suspended") {
    try { await ctx.resume(); } catch { /* noop */ }
  }
}

function beep() {
  const ctx = getCtx();
  if (!ctx) return;
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(880, now);
  osc.frequency.setValueAtTime(660, now + 0.15);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.25, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
  osc.connect(gain).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.4);
  if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
    try { navigator.vibrate([200, 100, 200]); } catch { /* noop */ }
  }
}

export function useNewReferralAlert() {
  const lastFiredRef = useRef(0);

  useEffect(() => {
    const channel = supabase
      .channel("new-referral-alert")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "referrals" }, () => {
        if (!isAlertsEnabled()) return;
        const now = Date.now();
        if (now - lastFiredRef.current < DEBOUNCE_MS) return;
        lastFiredRef.current = now;
        beep();
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, []);
}
