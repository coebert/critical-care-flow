import { createFileRoute, Outlet, redirect, Link, useRouter, useNavigate, useRouterState } from "@tanstack/react-router";
import { usePush } from "@/hooks/use-push";
import { useShiftStatus } from "@/hooks/use-shift-status";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Activity, BarChart3, ListChecks, Shield, LogOut, Plus, Menu, Bell, BellRing } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth, useRole } from "@/hooks/use-auth";
import { NotificationBell } from "@/components/notification-bell";
import { ShiftToggle } from "@/components/shift-toggle";
import { PushPermissionPrompt } from "@/components/push-permission-prompt";
import { TestPushButton } from "@/components/test-push-button";
import { Toaster } from "@/components/ui/sonner";
import { Sheet, SheetContent, SheetTrigger, SheetTitle, SheetHeader } from "@/components/ui/sheet";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async ({ location }) => {
    // Use the locally persisted session so transient network failures
    // against /auth/v1/user don't bounce signed-in users back to /auth.
    // Server functions re-validate the bearer via requireSupabaseAuth.
    const { data } = await supabase.auth.getSession();
    if (!data.session?.user) {
      // Preserve the intended deep link (e.g. /referrals/{id} from a push
      // notification) so the user lands there after signing in.
      const target = `${location.pathname}${location.searchStr ?? ""}`;
      throw redirect({
        to: "/auth",
        search: target && target !== "/" ? { redirect: target } : undefined,
      });
    }
    return { user: data.session.user };
  },
  component: AuthedShell,
});

function AuthedShell() {
  const { user } = useAuth();
  const { hasRole: isAdmin } = useRole("admin");
  const router = useRouter();
  const navigate = useNavigate();
  const [signingOut, setSigningOut] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { supported, permission, subscribed } = usePush();
  const { atWork } = useShiftStatus();

  // Close the mobile drawer on route change
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);


  const handleSignOut = async () => {
    setSigningOut(true);
    await supabase.auth.signOut();
    router.invalidate();
    navigate({ to: "/auth", replace: true });
  };

  const sidebarContent = (
    <div className="flex h-full flex-col">
      <div className="px-5 py-5 border-b">
        <div className="flex items-center gap-2">
          <div className="w-9 h-9 rounded-md bg-primary flex items-center justify-center shrink-0">
            <Activity className="w-5 h-5 text-primary-foreground" />
          </div>
          <div className="min-w-0">
            <div className="font-semibold text-sm leading-tight truncate">SDH Critical Care</div>
            <div className="text-xs text-muted-foreground">Referral tracker</div>
          </div>
        </div>
      </div>
      <nav className="flex-1 px-2 py-3 space-y-1 text-sm">
        <NavItem to="/" icon={<ListChecks className="w-4 h-4" />}>Referrals</NavItem>
        <NavItem to="/referrals/new" icon={<Plus className="w-4 h-4" />}>New referral</NavItem>
        <NavItem to="/analytics" icon={<BarChart3 className="w-4 h-4" />}>Analytics</NavItem>
        <NavItem to="/notifications" icon={<Bell className="w-4 h-4" />}>Notifications</NavItem>
        <NavItem to="/push-test" icon={<BellRing className="w-4 h-4" />}>Push test</NavItem>
        {isAdmin && (
          <NavItem to="/admin" icon={<Shield className="w-4 h-4" />}>Admin</NavItem>
        )}
      </nav>
      <div className="p-3 border-t text-xs space-y-2">
        <div className="text-muted-foreground truncate" title={user?.email ?? ""}>
          {user?.email}
        </div>
        <Button variant="ghost" size="sm" className="w-full justify-start" onClick={handleSignOut} disabled={signingOut}>
          <LogOut className="w-4 h-4 mr-2" /> Sign out
        </Button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen flex bg-background">
      <aside className="hidden md:flex w-60 border-r bg-sidebar flex-col shrink-0">
        {sidebarContent}
      </aside>
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 border-b flex items-center justify-between md:justify-end px-4 md:px-6 gap-3 bg-card">
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="md:hidden"
                aria-label="Open navigation menu"
                aria-expanded={mobileOpen}
                aria-controls="mobile-sidebar"
              >
                <Menu className="w-5 h-5" />
              </Button>
            </SheetTrigger>
            <SheetContent
              side="left"
              className="p-0 w-64 bg-sidebar"
              id="mobile-sidebar"
              onInteractOutside={() => setMobileOpen(false)}
              onEscapeKeyDown={() => setMobileOpen(false)}
            >
              <SheetHeader>
                <VisuallyHidden>
                  <SheetTitle>Navigation</SheetTitle>
                </VisuallyHidden>
              </SheetHeader>
              {sidebarContent}
            </SheetContent>
          </Sheet>
          <div className="ml-auto flex items-center gap-2">
            <ShiftToggle />
            {supported && permission === "granted" && subscribed && <TestPushButton />}
            <NotificationBell />
          </div>
        </header>
        <PushPermissionPrompt visible={supported && permission !== "granted" && atWork === true} />
        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
      <Toaster />
    </div>
  );
}

function NavItem({ to, icon, children }: { to: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <Link
      to={to}
      className="flex items-center gap-2 px-3 py-2 rounded-md hover:bg-sidebar-accent text-sidebar-foreground [&.active]:bg-sidebar-accent [&.active]:text-sidebar-accent-foreground [&.active]:font-medium"
      activeOptions={{ exact: to === "/" }}
    >
      {icon}
      {children}
    </Link>
  );
}
