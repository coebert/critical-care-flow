/**
 * Late-reply guard for clinical UI. A ticket is taken when a request
 * starts; its result may update state / toast / callbacks only if, when it
 * resolves, the component is still mounted, the selection (patient,
 * referral) is unchanged, no newer request on the same channel started, and
 * the session + clinical epochs are unchanged (no sign-out, account change,
 * denial or recovery in between).
 */
import { useEffect, useRef } from "react";
import { currentClinicalEpoch, currentSessionEpoch } from "./session-scope";

export type RequestTicket = {
  readonly channel: string;
  readonly gen: number;
  readonly scope: string;
  readonly scopeGen: number;
  readonly session: number;
  readonly clinical: number;
};

export class RequestGuard {
  private gens = new Map<string, number>();
  private scopeGen = 0;
  private alive = true;
  constructor(private scope: string) {}

  /** Selection changed: every outstanding ticket becomes obsolete. */
  setScope(scope: string): void {
    if (scope === this.scope) return;
    this.scope = scope;
    this.scopeGen += 1;
  }

  begin(channel: string): RequestTicket {
    const gen = (this.gens.get(channel) ?? 0) + 1;
    this.gens.set(channel, gen);
    return {
      channel,
      gen,
      scope: this.scope,
      scopeGen: this.scopeGen,
      session: currentSessionEpoch(),
      clinical: currentClinicalEpoch(),
    };
  }

  isCurrent(t: RequestTicket | null | undefined): boolean {
    return (
      !!t &&
      this.alive &&
      t.scope === this.scope &&
      t.scopeGen === this.scopeGen &&
      this.gens.get(t.channel) === t.gen &&
      t.session === currentSessionEpoch() &&
      t.clinical === currentClinicalEpoch()
    );
  }

  /** Invalidate every channel (e.g. dialog closed). */
  invalidateAll(): void {
    this.scopeGen += 1;
  }

  dispose(): void {
    this.alive = false;
  }
  revive(): void {
    this.alive = true;
  }
}

/** One guard per mounted component, bound to the current selection key. */
export function useRequestGuard(scope: string): RequestGuard {
  const ref = useRef<RequestGuard | null>(null);
  if (!ref.current) ref.current = new RequestGuard(scope);
  ref.current.setScope(scope);
  const g = ref.current;
  useEffect(() => {
    g.revive();
    return () => g.dispose();
  }, [g]);
  return g;
}
