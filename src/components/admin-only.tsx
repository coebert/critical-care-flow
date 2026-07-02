import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useRole } from "@/hooks/use-auth";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ShieldAlert } from "lucide-react";

export function AdminOnly({ children }: { children: ReactNode }) {
  const { hasRole, loading } = useRole("admin");

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto p-6">
        <Card className="p-6 text-sm text-muted-foreground">Checking access…</Card>
      </div>
    );
  }

  if (!hasRole) {
    return (
      <div className="max-w-2xl mx-auto p-6">
        <Card className="p-6 space-y-3">
          <div className="flex items-center gap-2 text-destructive">
            <ShieldAlert className="w-5 h-5" />
            <h1 className="text-lg font-semibold">Admins only</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Analytics are restricted to administrators. If you need access, ask an
            existing admin to grant you the admin role.
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
