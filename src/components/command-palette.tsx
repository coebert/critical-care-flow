import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import {
  ListChecks,
  Plus,
  Bed as BedIcon,
  Inbox,
  CalendarClock,
  BarChart3,
  Shield,
  UserCircle,
  Bell,
  ClipboardList,
  RefreshCw,
} from "lucide-react";
import { useRole, useClinicalAccess } from "@/hooks/use-auth";

type CmdAction = {
  id: string;
  label: string;
  icon: React.ReactNode;
  to?: string;
  keywords?: string;
  group: "Navigate" | "Create" | "Admin";
  admin?: boolean;
  clinical?: boolean;
};

export function CommandPalette({ open, onOpenChange }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const { hasRole: isAdmin } = useRole("admin");
  const { hasAccess: canAccessReferrals } = useClinicalAccess();

  const actions: CmdAction[] = [
    { id: "referrals", label: "Referrals", icon: <ListChecks className="w-4 h-4" />, to: "/", group: "Navigate", clinical: true, keywords: "list open critical care" },
    { id: "bed-board", label: "Bed board", icon: <BedIcon className="w-4 h-4" />, to: "/bed-board", group: "Navigate", keywords: "occupancy beds" },
    { id: "ward-round", label: "Ward round", icon: <ClipboardList className="w-4 h-4" />, to: "/board/ward-round", group: "Navigate", keywords: "board round list" },
    { id: "inbox", label: "Inbox", icon: <Inbox className="w-4 h-4" />, to: "/inbox", group: "Navigate", clinical: true },
    { id: "postop", label: "Post-op bookings", icon: <CalendarClock className="w-4 h-4" />, to: "/postop-bookings", group: "Navigate", keywords: "elective planned surgery" },
    { id: "notifications", label: "Notifications", icon: <Bell className="w-4 h-4" />, to: "/notifications", group: "Navigate" },
    { id: "profile", label: "Profile", icon: <UserCircle className="w-4 h-4" />, to: "/profile", group: "Navigate" },
    { id: "new-referral", label: "New referral", icon: <Plus className="w-4 h-4" />, to: "/referrals/new", group: "Create", clinical: true, keywords: "add create refer" },
    { id: "new-postop", label: "New post-op booking", icon: <Plus className="w-4 h-4" />, to: "/postop-bookings/new", group: "Create", keywords: "add elective surgery" },
    { id: "analytics", label: "Analytics", icon: <BarChart3 className="w-4 h-4" />, to: "/analytics", group: "Admin", admin: true },
    { id: "admin", label: "Admin", icon: <Shield className="w-4 h-4" />, to: "/admin", group: "Admin", admin: true },
    { id: "bridge", label: "Bridge sync", icon: <RefreshCw className="w-4 h-4" />, to: "/bridge-status", group: "Admin", admin: true },
  ];

  const visible = actions.filter((a) => {
    if (a.admin && !isAdmin) return false;
    if (a.clinical && !canAccessReferrals) return false;
    return true;
  });

  const grouped = {
    Navigate: visible.filter((a) => a.group === "Navigate"),
    Create: visible.filter((a) => a.group === "Create"),
    Admin: visible.filter((a) => a.group === "Admin"),
  };

  const run = (a: CmdAction) => {
    onOpenChange(false);
    if (a.to) navigate({ to: a.to });
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Search pages and actions..." />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        {(["Navigate", "Create", "Admin"] as const).map((g, i) =>
          grouped[g].length ? (
            <div key={g}>
              {i > 0 && <CommandSeparator />}
              <CommandGroup heading={g}>
                {grouped[g].map((a) => (
                  <CommandItem
                    key={a.id}
                    value={`${a.label} ${a.keywords ?? ""}`}
                    onSelect={() => run(a)}
                  >
                    <span className="mr-2">{a.icon}</span>
                    <span>{a.label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </div>
          ) : null,
        )}
      </CommandList>
      <div className="border-t px-3 py-2 text-[11px] text-muted-foreground flex items-center justify-between">
        <span>Type to search</span>
        <span>
          <CommandShortcut>⌘K</CommandShortcut>
        </span>
      </div>
    </CommandDialog>
  );
}

export function useCommandPaletteHotkey(setOpen: (v: boolean) => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);
}
