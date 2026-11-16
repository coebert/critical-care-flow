/**
 * Lets client-only route guards wait for hydration before redirecting.
 *
 * Client-only (`ssr: false`) route guards run while React is still hydrating
 * the server HTML. A redirect from such a guard to a server-rendered page
 * (e.g. signed-out "/" -> "/auth") swaps the route tree before hydration and
 * React reports a hydration mismatch (#418) or loses the pending match.
 *
 * - `markShellHydrated()` runs from the root component's first effect.
 * - `markBoundaryHydrated()` runs from the client-only layout's pending
 *   placeholder, i.e. once the Suspense boundary the server rendered for the
 *   client-only subtree has hydrated too.
 *
 * A guard that starts before the shell hydrated is on the cold-load path and
 * waits for the boundary (with a short fallback after the shell so it can
 * never hang). Guards on later client navigations do not wait.
 */
type Waiter = () => void;
let shellHydrated = false;
let boundaryHydrated = false;
let waiters: Waiter[] = [];
const FALLBACK_MS = 300;

function release(): void {
  const w = waiters;
  waiters = [];
  for (const fn of w) fn();
}

export function markShellHydrated(): void {
  if (shellHydrated) return;
  shellHydrated = true;
  if (waiters.length > 0 && !boundaryHydrated) setTimeout(release, FALLBACK_MS);
}

export function markBoundaryHydrated(): void {
  if (boundaryHydrated) return;
  boundaryHydrated = true;
  // Let React commit the hydrated boundary before the redirect replaces it.
  setTimeout(release, 0);
}

export function afterHydration(): Promise<void> {
  if (typeof window === "undefined" || boundaryHydrated) return Promise.resolve();
  if (shellHydrated && waiters.length === 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    waiters.push(resolve);
    if (shellHydrated) setTimeout(release, FALLBACK_MS);
  });
}

export function __resetHydrationGateForTests(): void {
  shellHydrated = false;
  boundaryHydrated = false;
  waiters = [];
}
