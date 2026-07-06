import { createFileRoute, Outlet, redirect, Link, useRouter, useNavigate, useRouterState } from "@tanstack/react-router";
import { usePush } from "@/hooks/use-push";
import { useShiftStatus } from "@/hooks/use-shift-status";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useE2ESession, initKeyStatusCrossTabSync } from "@/hooks/use-e2e-session";
import { Activity, BarChart3, ListChecks, Shield, LogOut, Plus, Menu, Bell, BellRing, Inbox, PanelLeftClose, PanelLeftOpen, CalendarClock, UserCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth, useRole } from "@/hooks/use-auth";
import { NotificationBell } from "@/components/notification-bell";
import { ShiftToggle } from "@/components/shift-toggle";
import { PushPermissionPrompt } from "@/components/push-permission-prompt";
import { E2EUnlockBanner } from "@/components/e2e-unlock-banner";
import { TestPushButton } from "@/components/test-push-button";
import { IdleTimeoutModal } from "@/components/idle-timeout-modal";
import { useIdleTimeout } from "@/hooks/use-idle-timeout";
import { Toaster } from "@/components/ui/sonner";
import { Sheet, SheetContent, SheetTrigger, SheetTitle, SheetHeader } from "@/components/ui/sheet";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { toast } from "sonner";

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
  const [desktopCollapsed, setDesktopCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("sidebar:collapsed") === "1";
  });
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("sidebar:collapsed", desktopCollapsed ? "1" : "0");
    }
  }, [desktopCollapsed]);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { supported, permission, subscribed } = usePush();
  const { atWork } = useShiftStatus();

  // Kick off a single global key-status fetch as soon as the user is
  // authenticated. Every page then reads from useE2ESession without
  // duplicating this network round-trip.
  useEffect(() => {
    if (!user?.id) return;
    useE2ESession.getState().refreshStatus().catch(() => { /* non-fatal */ });
  }, [user?.id]);

  // Subscribe to sibling tabs so a bootstrap / refresh / sign-out in one
  // tab propagates to this tab's badges and buttons without a reload.
  useEffect(() => {
    return initKeyStatusCrossTabSync();
  }, []);

  // Close the mobile drawer on route change
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);


  const handleSignOut = async (reason?: "timeout") => {
    setSigningOut(true);
    // Wipe the persisted E2E session so the next user on this device can't
    // resume the previous user's unlocked private key.
    try {
      const { useE2ESession } = await import("@/hooks/use-e2e-session");
      useE2ESession.getState().clear();
    } catch { /* non-fatal */ }
    await supabase.auth.signOut();
    router.invalidate();
    if (reason === "timeout") {
      toast.message("Signed out for inactivity", {
        description: "For patient safety, this session ended after a period of no activity.",
      });
    }
    navigate({ to: "/auth", replace: true });
  };

  // NHS DTAC / Technical Assurance — idle session timeout.
  // 30 min inactivity or 12 h absolute, whichever comes first, with a 60 s warning.
  const idle = useIdleTimeout({
    onTimeout: () => handleSignOut("timeout"),
    disabled: signingOut,
  });

  const renderSidebar = (collapsed: boolean) => (
    <div className="flex h-full flex-col">
      <div className={`${collapsed ? "px-2" : "px-5"} py-5 border-b`}>
        <div className={`flex items-center gap-2 ${collapsed ? "justify-center" : ""}`}>
          <div className="w-9 h-9 rounded-md bg-primary flex items-center justify-center shrink-0">
            <Activity className="w-5 h-5 text-primary-foreground" />
          </div>
          {!collapsed && (
            <div className="min-w-0">
              <div className="font-semibold text-sm leading-tight truncate">SDH Critical Care</div>
              <div className="text-xs text-muted-foreground">Referral tracker</div>
            </div>
          )}
        </div>
      </div>
      <nav className="flex-1 px-2 py-3 space-y-1 text-sm">
        <NavItem to="/" icon={<ListChecks className="w-4 h-4" />} collapsed={collapsed}>Referrals</NavItem>
        <NavItem to="/referrals/new" icon={<Plus className="w-4 h-4" />} collapsed={collapsed}>New referral</NavItem>
        <NavItem to="/postop-bookings" icon={<CalendarClock className="w-4 h-4" />} collapsed={collapsed}>Post-op bookings</NavItem>
        {isAdmin && (
          <NavItem to="/analytics" icon={<BarChart3 className="w-4 h-4" />} collapsed={collapsed}>Analytics</NavItem>
        )}
        <NavItem to="/inbox" icon={<Inbox className="w-4 h-4" />} collapsed={collapsed}>Inbox</NavItem>
        <NavItem to="/notifications" icon={<Bell className="w-4 h-4" />} collapsed={collapsed}>Notifications</NavItem>
        <NavItem to="/push-test" icon={<BellRing className="w-4 h-4" />} collapsed={collapsed}>Push test</NavItem>
        <NavItem to="/profile" icon={<UserCircle className="w-4 h-4" />} collapsed={collapsed}>Profile</NavItem>
        {isAdmin && (
          <NavItem to="/admin" icon={<Shield className="w-4 h-4" />} collapsed={collapsed}>Admin</NavItem>
        )}
      </nav>
      <div className="p-3 border-t text-xs space-y-2">
        {!collapsed && (
          <div className="text-muted-foreground truncate" title={user?.email ?? ""}>
            {user?.email}
          </div>
        )}
        <Button
          variant="ghost"
          size="sm"
          className={collapsed ? "w-full justify-center px-0" : "w-full justify-start"}
          onClick={handleSignOut}
          disabled={signingOut}
          aria-label="Sign out"
          title={collapsed ? "Sign out" : undefined}
        >
          <LogOut className={`w-4 h-4 ${collapsed ? "" : "mr-2"}`} />
          {!collapsed && "Sign out"}
        </Button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen flex bg-background">
      <aside
        className={`hidden md:flex ${desktopCollapsed ? "w-16" : "w-60"} border-r bg-sidebar flex-col shrink-0 transition-[width] duration-200`}
      >
        {renderSidebar(desktopCollapsed)}
      </aside>
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 border-b flex items-center px-2 sm:px-4 md:px-6 gap-2 sm:gap-3 bg-card">
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="md:hidden shrink-0"
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
              {renderSidebar(false)}
            </SheetContent>
          </Sheet>
          <Button
            variant="ghost"
            size="icon"
            className="hidden md:inline-flex shrink-0"
            onClick={() => setDesktopCollapsed((v) => !v)}
            aria-label={desktopCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={desktopCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {desktopCollapsed ? <PanelLeftOpen className="w-5 h-5" /> : <PanelLeftClose className="w-5 h-5" />}
          </Button>
          <div className="ml-auto flex items-center gap-2 min-w-0 flex-wrap justify-end">
            <ShiftToggle />
            {supported && permission === "granted" && subscribed && <TestPushButton />}
            <NotificationBell />
          </div>
        </header>
        <PushPermissionPrompt visible={supported && permission !== "granted" && atWork === true} />
        <E2EUnlockBanner />
        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
      <Toaster />
    </div>
  );
}

function NavItem({ to, icon, children, collapsed }: { to: string; icon: React.ReactNode; children: React.ReactNode; collapsed?: boolean }) {
  return (
    <Link
      to={to}
      className={`flex items-center gap-2 ${collapsed ? "justify-center px-2" : "px-3"} py-2 rounded-md hover:bg-sidebar-accent text-sidebar-foreground [&.active]:bg-sidebar-accent [&.active]:text-sidebar-accent-foreground [&.active]:font-medium`}
      activeOptions={{ exact: to === "/" }}
      title={collapsed ? String(children) : undefined}
      aria-label={collapsed ? String(children) : undefined}
    >
      {icon}
      {!collapsed && <span className="truncate">{children}</span>}
    </Link>
  );
}
