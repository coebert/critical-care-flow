import { createFileRoute, Outlet, redirect, Link, useRouter, useNavigate, useRouterState } from "@tanstack/react-router";
import { usePush } from "@/hooks/use-push";
import { useShiftStatus } from "@/hooks/use-shift-status";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useE2ESession, initKeyStatusCrossTabSync } from "@/hooks/use-e2e-session";
import { Activity, BarChart3, ListChecks, Shield, LogOut, Plus, Menu, Bell, BellRing, Inbox, PanelLeftClose, PanelLeftOpen, CalendarClock, UserCircle, Bed as BedIcon, RefreshCw, Search, ClipboardList } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth, useRole, useClinicalAccess } from "@/hooks/use-auth";
import { NotificationBell } from "@/components/notification-bell";
import { AlertToggle } from "@/components/alert-toggle";
import { useNewReferralAlert } from "@/hooks/use-new-referral-alert";
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
import { CommandPalette, useCommandPaletteHotkey } from "@/components/command-palette";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { GlobalBannerSlot } from "@/components/global-banner-slot";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  // Every route under this layout renders behind sign-in and holds patient
  // data. Explicitly ask search engines not to index or follow any of it,
  // even though `ssr:false` already means no HTML is served to crawlers.
  // (`ssr:false` disables SSR; the client-side `head()` still emits meta
  // tags for compliant bots that render the app, and this layout tag is
  // inherited by every child route.)
  head: () => ({
    meta: [{ name: "robots", content: "noindex, nofollow, noarchive" }],
  }),
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
  // Referral surfaces (list, new, detail, inbox of referral notifications)
  // are restricted to critical care team members by RLS + server guards.
  // Hide the nav links for anyone else so we don't offer a link that leads
  // to an "access restricted" screen. Admins retain clinical access via the
  // `has_clinical_access` predicate, so this only hides the entries for
  // signed-in users with no clinical role.
  const { hasAccess: canAccessReferrals } = useClinicalAccess();
  const router = useRouter();
  const navigate = useNavigate();
  const [signingOut, setSigningOut] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  useCommandPaletteHotkey(setPaletteOpen);
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
  useNewReferralAlert();

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

  const pageTitle = getPageTitle(pathname);

  const renderSidebar = (collapsed: boolean) => (
    <div className="flex h-full flex-col">
      <div className={`${collapsed ? "px-2" : "px-5"} h-12 border-b flex items-center`}>
        <div className={`flex items-center gap-2 ${collapsed ? "justify-center w-full" : ""}`}>
          <div className="w-8 h-8 rounded-md bg-primary flex items-center justify-center shrink-0">
            <Activity className="w-4 h-4 text-primary-foreground" />
          </div>
          {!collapsed && (
            <div className="min-w-0">
              <div className="font-semibold text-sm leading-tight truncate">SDH Critical Care</div>
              <div className="text-[11px] text-muted-foreground leading-tight">Referral tracker</div>
            </div>
          )}
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 py-3 text-sm">
        <NavGroup label="Clinical" collapsed={collapsed}>
          {canAccessReferrals && (
            <>
              <NavItem to="/" icon={<ListChecks className="w-4 h-4" />} collapsed={collapsed} label="Referrals" />
              <NavItem to="/referrals/new" icon={<Plus className="w-4 h-4" />} collapsed={collapsed} label="New referral" />
              <NavItem to="/inbox" icon={<Inbox className="w-4 h-4" />} collapsed={collapsed} label="Inbox" />
            </>
          )}
          <NavItem to="/bed-board" icon={<BedIcon className="w-4 h-4" />} collapsed={collapsed} label="Bed board" />
          <NavItem to="/board/ward-round" icon={<ClipboardList className="w-4 h-4" />} collapsed={collapsed} label="Ward round" />
        </NavGroup>
        <NavGroup label="Planning" collapsed={collapsed}>
          <NavItem to="/postop-bookings" icon={<CalendarClock className="w-4 h-4" />} collapsed={collapsed} label="Post-op bookings" />
        </NavGroup>
        <NavGroup label="Alerts" collapsed={collapsed}>
          <NavItem to="/notifications" icon={<Bell className="w-4 h-4" />} collapsed={collapsed} label="Notifications" />
        </NavGroup>
        <NavGroup label="You" collapsed={collapsed}>
          <NavItem to="/profile" icon={<UserCircle className="w-4 h-4" />} collapsed={collapsed} label="Profile" />
        </NavGroup>
        {isAdmin && (
          <NavGroup label="Insight" collapsed={collapsed}>
            <NavItem to="/analytics" icon={<BarChart3 className="w-4 h-4" />} collapsed={collapsed} label="Analytics" />
          </NavGroup>
        )}
        {isAdmin && (
          <NavGroup label="Admin" collapsed={collapsed}>
            <NavItem to="/admin" icon={<Shield className="w-4 h-4" />} collapsed={collapsed} label="Admin" />
            <NavItem to="/bridge-status" icon={<RefreshCw className="w-4 h-4" />} collapsed={collapsed} label="Bridge sync" />
            <NavItem to="/push-test" icon={<BellRing className="w-4 h-4" />} collapsed={collapsed} label="Push test" />
          </NavGroup>
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
          onClick={() => handleSignOut()}
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
    <div className="min-h-dvh flex bg-background">
      <aside
        className={`hidden md:flex ${desktopCollapsed ? "w-16" : "w-60"} border-r bg-sidebar flex-col shrink-0 transition-[width] duration-200`}
      >
        {renderSidebar(desktopCollapsed)}
      </aside>
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-12 border-b bg-card grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-2 sm:px-4 md:px-6">
          <div className="flex items-center gap-1 shrink-0">
            <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
              <SheetTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="md:hidden shrink-0 h-9 w-9"
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
              className="hidden md:inline-flex shrink-0 h-9 w-9"
              onClick={() => setDesktopCollapsed((v) => !v)}
              aria-label={desktopCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              title={desktopCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              {desktopCollapsed ? <PanelLeftOpen className="w-5 h-5" /> : <PanelLeftClose className="w-5 h-5" />}
            </Button>
          </div>
          <h1 className="min-w-0 truncate text-sm sm:text-base font-semibold text-foreground">
            {pageTitle}
          </h1>
          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0 justify-end">
            <Button
              variant="ghost"
              size="sm"
              className="hidden sm:inline-flex h-9 gap-2 text-muted-foreground"
              onClick={() => setPaletteOpen(true)}
              aria-label="Open command palette"
              title="Search & actions (⌘K)"
            >
              <Search className="w-4 h-4" />
              <span className="hidden md:inline">Search</span>
              <kbd className="hidden md:inline-flex items-center rounded border bg-muted px-1.5 py-0.5 text-[10px] font-mono">⌘K</kbd>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="sm:hidden h-9 w-9"
              onClick={() => setPaletteOpen(true)}
              aria-label="Open command palette"
            >
              <Search className="w-5 h-5" />
            </Button>
            <ShiftToggle />
            {supported && permission === "granted" && subscribed && <TestPushButton />}
            <AlertToggle />
            <NotificationBell />
          </div>
        </header>
        <Breadcrumbs pathname={pathname} />
        <GlobalBannerSlot />
        <PushPermissionPrompt visible={supported && permission !== "granted" && atWork === true} />
        <E2EUnlockBanner />
        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <Toaster />
      <IdleTimeoutModal
        open={idle.warning && !signingOut}
        secondsLeft={idle.secondsLeft}
        onStayActive={idle.stayActive}
        onSignOutNow={() => handleSignOut()}
      />
    </div>
  );
}

function NavGroup({
  label,
  collapsed,
  children,
}: {
  label: string;
  collapsed: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-3 last:mb-0">
      {!collapsed && (
        <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
          {label}
        </div>
      )}
      {collapsed && <div className="h-px bg-sidebar-border/60 mx-2 mb-1" aria-hidden="true" />}
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

// Maps the current pathname to the human-facing page title shown in the
// authenticated header. Falls back to the app name for unknown routes.
function getPageTitle(pathname: string): string {
  if (pathname === "/") return "Referrals";
  if (pathname === "/referrals/new") return "New referral";
  if (pathname.startsWith("/referrals/")) return "Referral";
  if (pathname === "/postop-bookings") return "Post-op bookings";
  if (pathname.startsWith("/postop-bookings/")) return "Post-op booking";
  if (pathname === "/bed-board") return "Bed board";
  if (pathname === "/board") return "Board mode";
  if (pathname === "/board/ward-round") return "Ward round list";
  if (pathname === "/inbox") return "Inbox";
  if (pathname === "/notifications") return "Notifications";
  if (pathname === "/profile") return "Profile";
  if (pathname === "/analytics") return "Analytics";
  if (pathname === "/admin") return "Admin";
  if (pathname === "/bridge-status") return "Bridge sync";
  if (pathname === "/push-test") return "Push test";
  return "SDH Critical Care";
}

function NavItem({
  to,
  icon,
  label,
  collapsed,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
  collapsed?: boolean;
}) {
  return (
    <Link
      to={to}
      className={`flex items-center gap-2 ${collapsed ? "justify-center px-2" : "px-3"} py-2 rounded-md hover:bg-sidebar-accent text-sidebar-foreground [&.active]:bg-sidebar-accent [&.active]:text-sidebar-accent-foreground [&.active]:font-medium`}
      // Exact match everywhere so a leaf link (e.g. Analytics → /analytics)
      // is never highlighted while viewing a sibling route (e.g.
      // /postop-bookings or /postop-bookings/analytics). Without exact,
      // TanStack Router's default prefix match can activate a link for any
      // descendant path that begins with `to`.
      activeOptions={{ exact: true }}
      title={collapsed ? label : undefined}
      aria-label={collapsed ? label : undefined}
    >
      {icon}
      {!collapsed && <span className="truncate">{label}</span>}
    </Link>
  );
}
