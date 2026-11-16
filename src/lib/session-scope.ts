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

/**
 * Shared clinical gate. An AUTHORITATIVE server denial (403 / "forbidden:
 * clinical … required") flips `denied` for the whole tab at once — every
 * clinical surface hides even if a role hook still holds an older `true`.
 * `epoch` bumps on every denial, recovery and identity change; clinical UI
 * is keyed by it so selections, drafts, decrypted detail, previews and
 * dialogs unmount, and late replies tagged with an older epoch are dropped.
 * Only a fresh authorised check that STARTED after the denial clears it.
 */
export type ClinicalScope = { denied: boolean; epoch: number };
let clinical: ClinicalScope = { denied: false, epoch: 0 };
const clinicalListeners = new Set<() => void>();
const setClinical = (next: ClinicalScope) => {
  clinical = next;
  for (const l of clinicalListeners) l();
};
export function subscribeClinicalScope(l: () => void): () => void {
  clinicalListeners.add(l);
  return () => clinicalListeners.delete(l);
}
export function getClinicalScope(): ClinicalScope {
  return clinical;
}
export function currentClinicalEpoch(): number {
  return clinical.epoch;
}

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
  // A denial belonged to the previous identity; the new one must prove
  // access itself (role hooks reload for the new user). Clinical UI keyed
  // by the epoch unmounts either way.
  setClinical({ denied: false, epoch: clinical.epoch + 1 });
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
  // Referral list, detail (decrypted), notes, unread counts, prior-declined.
  ["referrals"],
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

const DENIAL_RE = /^forbidden: clinical (access|role) required/i;
/** Prefill's clinical refusal message (partner-handover-prefill-core). */
const PREFILL_DENIAL = "Your account does not have clinical access.";

/**
 * Is this server reply/error an authoritative clinical-role denial by THIS
 * app's server? Hub refusals (partner outcomes) and permission-check
 * failures (503) are deliberately not treated as denials.
 */
export function isClinicalDenial(x: unknown): boolean {
  if (!x || typeof x !== "object") return false;
  if (x instanceof Error) return DENIAL_RE.test(x.message);
  const o = x as Record<string, unknown>;
  if (o.forbidden === true && o.status === 403) return true;
  if (o.ok === false && typeof o.error === "string" && DENIAL_RE.test(o.error)) return true;
  if (o.ok === false && o.code === "forbidden" && o.message === PREFILL_DENIAL) return true;
  return false;
}

/**
 * Authoritative denial: drop every clinical snapshot (except `keep`, which
 * the caller replaces itself) and hide all clinical UI. Idempotent while
 * already denied so repeated refusals cannot loop.
 */
export function reportClinicalDenial(qc: QueryClient, keep?: QueryKey): void {
  if (typeof window === "undefined") return; // never mutate shared server state during SSR
  purgeClinicalSnapshots(qc, keep);
  if (!clinical.denied) setClinical({ denied: true, epoch: clinical.epoch + 1 });
}

/** Global cache hook: report denials seen by any query or mutation. */
export function noteClinicalResult(qc: QueryClient, x: unknown): void {
  if (isClinicalDenial(x)) reportClinicalDenial(qc);
}

/**
 * Recover after a FRESH authorised check. `startedAtEpoch` is the clinical
 * epoch when that check began; a check that started before the denial (or
 * before any later change) cannot clear it. Returns whether access is open.
 */
export function clearClinicalDenial(qc: QueryClient, startedAtEpoch: number): boolean {
  if (!clinical.denied) return true;
  if (startedAtEpoch !== clinical.epoch) return false;
  purgeClinicalSnapshots(qc); // includes the cached denial for the board
  setClinical({ denied: false, epoch: clinical.epoch + 1 });
  return true;
}

/** Test helper. */
export function __resetSessionScopeForTests(): void {
  epoch = 0;
  scopeUser = undefined;
  clinical = { denied: false, epoch: 0 };
}
