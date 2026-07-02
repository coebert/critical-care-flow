import { useEffect, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useRole } from "@/hooks/use-auth";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ShieldAlert } from "lucide-react";

interface AdminOnlyProps {
  children: ReactNode;
  /** If set, non-admin users are redirected to this path instead of seeing the 403 state. */
  redirectTo?: string;
}

export function AdminOnly({ children, redirectTo }: AdminOnlyProps) {
  const { hasRole, loading } = useRole("admin");
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && !hasRole && redirectTo) {
      navigate({ to: redirectTo, replace: true });
    }
  }, [loading, hasRole, redirectTo, navigate]);

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto p-6">
        <Card className="p-6 text-sm text-muted-foreground">Checking access…</Card>
      </div>
    );
  }

  if (!hasRole) {
    if (redirectTo) {
      return (
        <div className="max-w-5xl mx-auto p-6">
          <Card className="p-6 text-sm text-muted-foreground">Redirecting…</Card>
        </div>
      );
    }
    return (
      <div className="max-w-2xl mx-auto p-6" role="alert" aria-labelledby="admin-only-title">
        <Card className="p-6 space-y-3">
          <div className="flex items-center gap-2 text-destructive">
            <ShieldAlert className="w-5 h-5" />
            <h1 id="admin-only-title" className="text-lg font-semibold">
              403 — Forbidden
            </h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Analytics are restricted to administrators. Your account does not
            have the admin role, so this page and its data endpoints are
            unavailable. If you need access, ask an existing admin to grant you
            the admin role.
          </p>
          <Button asChild variant="outline" size="sm">
            <Link to="/">Back to referrals</Link>
          </Button>
        </Card>
      </div>
    );
  }

  return <>{children}</>;
}
