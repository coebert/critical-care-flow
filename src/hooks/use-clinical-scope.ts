import { useSyncExternalStore } from "react";
import { getClinicalScope, subscribeClinicalScope, type ClinicalScope } from "@/lib/session-scope";

/** Shared clinical gate state (denied + epoch), see session-scope.ts. */
export function useClinicalScope(): ClinicalScope {
  return useSyncExternalStore(subscribeClinicalScope, getClinicalScope, getClinicalScope);
}
