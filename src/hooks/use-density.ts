import { useCallback, useEffect, useState } from "react";

/** Card density mode persisted in localStorage. Comfortable is the default. */
export type Density = "comfortable" | "compact";

const STORAGE_KEY = "bedboard.density";

/**
 * SSR-safe density hook. Always returns `"comfortable"` on the first render
 * (and during SSR) then hydrates the persisted value in an effect to avoid
 * a hydration mismatch. Writes back to localStorage on change.
 */
export function useDensity(defaultDensity: Density = "comfortable") {
  const [density, setDensityState] = useState<Density>(defaultDensity);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === "comfortable" || stored === "compact") {
        setDensityState(stored);
      }
    } catch {
      // localStorage unavailable — keep default.
    }
  }, []);

  const setDensity = useCallback((next: Density) => {
    setDensityState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore
    }
  }, []);

  const toggle = useCallback(() => {
    setDensity(density === "comfortable" ? "compact" : "comfortable");
  }, [density, setDensity]);

  return { density, setDensity, toggle };
}
