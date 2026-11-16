/**
 * Session-scoped client cache.
 *
 * Cached clinical snapshots (bed board, acuity, staffing, referral lists…)
 * belong to ONE signed-in identity. On sign-out or identity change every
 * cached query is cancelled and dropped synchronously — before React renders
 * the next screen — and any fetch that was still in flight for the previous
 * identity is discarded instead of populating the new user's cache.
 *
 * Normal token refreshes for the same user change nothing.
 */
import type { QueryClient, QueryKey } from "@tanstack/react-query";

let epoch = 0;
/** `undefined` = identity not yet observed in this tab. */
let scopeUser: string | null | undefined = undefined;

export class SessionScopeChangedError extends Error {
  constructor() {
    super("Signed-in account changed while this request was in flight");
    this.name = "SessionScopeChangedError";
  }
}

export function currentSessionEpoch(): number {
  return epoch;
}

/** Synchronously cancel and drop every cached query; bump the epoch. */
export function resetSessionScope(qc: QueryClient, nextUserId: string | null): void {
  epoch += 1;
  scopeUser = nextUserId;
  void qc.cancelQueries();
  qc.clear();
}

/**
 * Report the identity the auth layer currently sees. Returns true when the
 * cache was reset because the identity changed (sign-out, or a different
 * user). The first observation in a tab only records the identity.
 */
export function observeSessionIdentity(qc: QueryClient, userId: string | null): boolean {
  if (scopeUser === undefined) {
    scopeUser = userId;
    return false;
  }
  if (scopeUser !== userId) {
    resetSessionScope(qc, userId);
    return true;
  }
  return false;
}

/**
 * Wrap a query function so its result is only accepted if the session is
 * still the one it started under. A late response for a previous user
 * rejects instead of being cached.
 */
export function sessionScoped<T>(fn: () => Promise<T>): () => Promise<T> {
  return async () => {
    const started = epoch;
    const result = await fn();
    if (epoch !== started) throw new SessionScopeChangedError();
    return result;
  };
}

/** Roots of every query key that holds clinical data. */
export const CLINICAL_QUERY_ROOTS: readonly QueryKey[] = [
  ["partner-bed-board"],
  ["patient-acuity"],
  ["nurse-staffing"],
  ["board", "referrals"],
  ["patient-wardable-status"],
  ["patient-airways"],
  ["patient-isolations"],
  ["patient-violence-risk"],
  ["patient-end-of-life"],
  ["patient-scan-transfer"],
  ["admission-source-context"],
];

const sameKey = (a: QueryKey, b: QueryKey) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The server just denied this user clinical access: drop every cached
 * clinical snapshot (except `keep`, which the caller is replacing itself)
 * so nothing from before the revocation stays on screen.
 */
export function purgeClinicalSnapshots(qc: QueryClient, keep?: QueryKey): void {
  for (const root of CLINICAL_QUERY_ROOTS) {
    if (keep && sameKey(root, keep)) continue;
    void qc.cancelQueries({ queryKey: root });
    qc.removeQueries({ queryKey: root });
  }
}

/** Test helper. */
export function __resetSessionScopeForTests(): void {
  epoch = 0;
  scopeUser = undefined;
}
