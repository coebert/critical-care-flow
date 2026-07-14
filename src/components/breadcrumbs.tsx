import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";

type Crumb = { label: string; to?: string };

function buildCrumbs(pathname: string): Crumb[] {
  if (pathname === "/" || pathname === "") return [];
  const parts = pathname.split("/").filter(Boolean);

  // Common patterns:
  if (parts[0] === "referrals") {
    if (parts[1] === "new") return [{ label: "Referrals", to: "/" }, { label: "New" }];
    return [{ label: "Referrals", to: "/" }, { label: "Detail" }];
  }
  if (parts[0] === "postop-bookings") {
    const base: Crumb[] = [{ label: "Post-op bookings", to: "/postop-bookings" }];
    if (!parts[1]) return [];
    if (parts[1] === "new") return [...base, { label: "New" }];
    if (parts[1] === "planner") return [...base, { label: "Planner" }];
    if (parts[1] === "analytics") return [...base, { label: "Analytics" }];
    if (parts[1] === "cancellations") return [...base, { label: "Cancellations" }];
    if (parts[2] === "edit") return [...base, { label: "Edit booking" }];
    return [...base, { label: "Booking" }];
  }
  if (parts[0] === "inbox" && parts[1]) return [{ label: "Inbox", to: "/inbox" }, { label: "Message" }];
  if (parts[0] === "board" && parts[1] === "ward-round") return [{ label: "Board", to: "/board" }, { label: "Ward round" }];
  return [];
}

export function Breadcrumbs({ pathname }: { pathname: string }) {
  const crumbs = buildCrumbs(pathname);
  if (crumbs.length === 0) return null;
  return (
    <nav
      aria-label="Breadcrumb"
      className="px-2 sm:px-4 md:px-6 py-1.5 text-xs text-muted-foreground border-b bg-card/60 flex items-center gap-1 overflow-x-auto"
    >
      {crumbs.map((c, i) => {
        const isLast = i === crumbs.length - 1;
        return (
          <span key={i} className="flex items-center gap-1 shrink-0">
            {c.to && !isLast ? (
              <Link to={c.to} className="hover:text-foreground underline-offset-2 hover:underline">
                {c.label}
              </Link>
            ) : (
              <span className={isLast ? "text-foreground font-medium" : undefined}>{c.label}</span>
            )}
            {!isLast && <ChevronRight className="w-3 h-3 opacity-60" />}
          </span>
        );
      })}
    </nav>
  );
}
