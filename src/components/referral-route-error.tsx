import { ClinicalAccessGate } from "./clinical-access-gate";
import { RouteErrorFallback } from "./route-error-fallback";

/**
 * Error boundary for referral surfaces. When the server function throws
 * "Forbidden: clinical access required" (see `assertClinicalAccess` in
 * `referrals.functions.ts`), render the Clinical Access Gate so the user
 * gets a clear "access restricted" screen instead of a raw error stack.
 *
 * For any other error, fall back to the standard route error UI.
 */
export function ReferralRouteError({
  error,
  label,
}: {
  error: Error;
  label: string;
}) {
  if (/clinical access required/i.test(error.message ?? "")) {
    // Rendering the gate with `null` children is intentional — the gate
    // will short-circuit to its "access restricted" branch because the
    // current user lacks clinical access.
    return <ClinicalAccessGate>{null}</ClinicalAccessGate>;
  }
  return <RouteErrorFallback error={error} label={label} />;
}
