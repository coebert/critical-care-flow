import { Link } from "@tanstack/react-router";
import { ShieldAlert } from "lucide-react";
import { useClinicalAccess } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * UI-side role gate for the referral surfaces (list, new, detail, inbox).
 *
 * Database RLS on `referrals`, `referral_messages`, `referral_notes` and
 * `referral_tasks` already restricts reads and writes to users with an
 * 'admin' or 'clinician' role via `public.has_clinical_access()`. Without
 * this gate, a signed-in non-clinical user (e.g. someone freshly invited
 * with no role yet, or a role that was revoked) would see empty lists,
 * blank detail screens and cryptic "row-level security" failures on save.
 * This component gives them a clear "no access" screen instead.
 */
export function ClinicalAccessGate({ children }: { children: React.ReactNode }) {
  const { hasAccess, loading } = useClinicalAccess();

  if (loading) {
    return (
      <div className="p-6 space-y-3" aria-busy="true">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (!hasAccess) {
    return (
      <div className="p-6 md:p-10 max-w-xl">
        <div className="rounded-lg border bg-card p-6 space-y-4">
          <div className="flex items-center gap-2 text-destructive">
            <ShieldAlert className="w-5 h-5" aria-hidden="true" />
            <h1 className="text-lg font-semibold">Access restricted</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Referrals contain patient-identifiable information and are only
            available to members of the critical care team. Your account
            doesn't currently have clinical access.
          </p>
          <p className="text-sm text-muted-foreground">
            If you believe this is a mistake, please ask a critical care
            administrator to grant you the clinician role.
          </p>
          <div className="flex gap-2">
            <Button asChild variant="outline" size="sm">
              <Link to="/profile">Go to profile</Link>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
