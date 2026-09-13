import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { inviteClinician, listUsers, setUserRole, getAuditLog } from "@/lib/admin.functions";
import { tzTooltip } from "@/lib/format-timestamp";
import { supabase } from "@/integrations/supabase/client";

import { useRole } from "@/hooks/use-auth";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CalendarIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DateRange } from "react-day-picker";
import { BedsAdminPanel } from "@/components/bed-board/beds-admin-panel";
import { MessageTemplatesPanel } from "@/components/admin/message-templates-panel";
import { toast } from "sonner";
import { format } from "date-fns";


export const Route = createFileRoute("/_authenticated/admin")({
  head: () => ({ meta: [{ title: "Admin — SDH Critical Care" }, { name: "robots", content: "noindex" }] }),
  // Route-level defence-in-depth: gate the page before the component even
  // mounts. `_authenticated` already ensures a signed-in user; here we also
  // require the admin role via has_role() so a non-admin can't hit the
  // route directly and briefly see any admin UI shell before useRole()
  // finishes its lookup.
  beforeLoad: async () => {
    const { data: userRes } = await supabase.auth.getUser();
    const uid = userRes.user?.id;
    if (!uid) throw redirect({ to: "/auth", search: {} });
    const { data: isAdmin } = await supabase.rpc("has_role", {
      _user_id: uid,
      _role: "admin",
    });
    if (!isAdmin) throw redirect({ to: "/" });
  },
  component: AdminPage,
});

function AdminPage() {
  // Route beforeLoad has already asserted admin; useRole here is only used
  // by nested widgets that also want to render conditionally.
  const { hasRole, loading } = useRole("admin");
  if (loading) return <div className="p-6 text-muted-foreground">Loading…</div>;
  if (!hasRole) return <div className="p-6"><Card className="p-6 max-w-md"><h1 className="font-semibold mb-2">Admin only</h1><p className="text-sm text-muted-foreground">You don't have permission to view this page.</p></Card></div>;


  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      <h1 className="text-2xl font-semibold tracking-tight mb-6">Admin</h1>
      <Tabs defaultValue="users">
        <TabsList>
          <TabsTrigger value="users">Team members</TabsTrigger>
          <TabsTrigger value="beds">Beds</TabsTrigger>
          <TabsTrigger value="templates">Templates</TabsTrigger>
          <TabsTrigger value="audit">Audit log</TabsTrigger>
        </TabsList>
        <TabsContent value="users" className="mt-4 space-y-6">
          <InvitePanel />
          <UsersPanel />
        </TabsContent>
        <TabsContent value="beds" className="mt-4">
          <BedsAdminPanel />
        </TabsContent>
        <TabsContent value="templates" className="mt-4">
          <MessageTemplatesPanel />
        </TabsContent>
        <TabsContent value="audit" className="mt-4">
          <AuditPanel />
        </TabsContent>
      </Tabs>


    </div>
  );
}

function InvitePanel() {
  const invite = useServerFn(inviteClinician);
  const [f, setF] = useState({ email: "", full_name: "", job_title: "", role: "clinician" as "clinician" | "admin" });
  const [busy, setBusy] = useState(false);
  const [lastEmail, setLastEmail] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await invite({ data: f });
      setLastEmail(f.email);
      setF({ email: "", full_name: "", job_title: "", role: "clinician" });
      toast.success("Invitation email sent");
    } catch (err: any) {
      toast.error(err.message ?? "Failed to invite");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-5">
      <h2 className="font-semibold mb-1">Invite a team member</h2>
      <p className="text-sm text-muted-foreground mb-4">Sends a time-limited invitation email. The user clicks the link to set their own password — no temporary password is created or shared.</p>
      <form onSubmit={submit} className="grid md:grid-cols-2 gap-4">
        <div className="space-y-1.5"><Label>Email</Label><Input type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
        <div className="space-y-1.5"><Label>Full name</Label><Input required value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} /></div>
        <div className="space-y-1.5"><Label>Job title</Label><Input value={f.job_title} onChange={(e) => setF({ ...f, job_title: e.target.value })} placeholder="e.g. ICU Registrar" /></div>
        <div className="space-y-1.5"><Label>Role</Label>
          <select className="border rounded-md h-9 px-2 bg-background" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as any })}>
            <option value="clinician">Clinician</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <div className="md:col-span-2 flex justify-end">
          <Button type="submit" disabled={busy}>{busy ? "Sending…" : "Send invitation"}</Button>
        </div>
      </form>
      {lastEmail && (
        <div className="mt-4 p-3 rounded-md border bg-accent/40 text-sm">
          <div><span className="text-muted-foreground">Invitation sent to:</span> <span className="font-mono">{lastEmail}</span></div>
          <p className="text-xs text-muted-foreground mt-2">The link in their email expires after a short window. If they don't sign in, send another invitation.</p>
        </div>
      )}
    </Card>
  );
}

function UsersPanel() {
  const list = useServerFn(listUsers);
  const setRole = useServerFn(setUserRole);
  const [users, setUsers] = useState<any[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const PER_PAGE = 50;

  const loadPage = async (nextPage: number, append: boolean) => {
    const setBusy = append ? setLoadingMore : setLoading;
    setBusy(true);
    try {
      const res = await list({ data: { page: nextPage, perPage: PER_PAGE } });
      setUsers((cur) => (append ? [...cur, ...res.users] : res.users));
      setHasMore(res.hasMore);
      setPage(nextPage);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { void loadPage(1, false); }, []);

  const toggle = async (user_id: string, role: "admin" | "clinician", grant: boolean) => {
    try {
      await setRole({ data: { user_id, role, grant } });
      // Refresh from page 1 to keep counts and order consistent.
      await loadPage(1, false);
    } catch (err: any) {
      toast.error(err.message ?? "Failed");
    }
  };

  return (
    <Card className="p-5">
      <h2 className="font-semibold mb-3">Team members</h2>
      {loading ? <p className="text-sm text-muted-foreground">Loading…</p> : (
        <div className="overflow-x-auto"><table className="w-full text-sm min-w-[640px]">
          <thead className="text-xs uppercase text-muted-foreground">
            <tr><th className="text-left py-2">Name</th><th className="text-left">Email</th><th className="text-left">Roles</th><th className="text-left">Last sign-in</th><th></th></tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-t">
                <td className="py-2">{u.profile?.full_name ?? "—"}</td>
                <td>{u.email}</td>
                <td className="space-x-1">{u.roles.map((r: string) => <Badge key={r} variant="outline" className="capitalize">{r}</Badge>)}</td>
                <td title={u.last_sign_in_at ? tzTooltip(u.last_sign_in_at) : undefined}>{u.last_sign_in_at ? format(new Date(u.last_sign_in_at), "dd/MM/yyyy HH:mm") : "—"}</td>
                <td className="text-right space-x-2">
                  {u.roles.includes("admin") ? (
                    <Button size="sm" variant="outline" onClick={() => toggle(u.id, "admin", false)}>Remove admin</Button>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => toggle(u.id, "admin", true)}>Make admin</Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      {hasMore && !loading && (
        <div className="mt-3 flex justify-center">
          <Button size="sm" variant="outline" disabled={loadingMore} onClick={() => loadPage(page + 1, true)}>
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </Card>
  );
}

type AuditSortColumn = "created_at" | "action" | "entity";
const PAGE_SIZE_OPTIONS = [25, 50, 100, 200] as const;
const AUDIT_ENTITY_OPTIONS = [
  "referral",
  "referral_note",
  "patient",
  "postop_booking",
  "microbiology",
  "investigation",
  "user",
  "user_keypair",
  "patient_acuity",
] as const;
const AUDIT_ACTION_OPTIONS = ["create", "update", "delete"] as const;

const AUDIT_QUICK_FILTERS = [
  { label: "Referral created", entity: "referral", action: "create" },
  { label: "Referral updated", entity: "referral", action: "update" },
  { label: "Referral note updated", entity: "referral_note", action: "update" },
  { label: "Patient updated", entity: "patient", action: "update" },
] as const;

type AuditFilters = {
  entity: string;
  action: string;
  clinician: string;
  specialty: string;
  from: string;
  to: string;
};
const EMPTY_FILTERS: AuditFilters = {
  entity: "",
  action: "",
  clinician: "",
  specialty: "",
  from: "",
  to: "",
};

// Date-only string (YYYY-MM-DD) → ISO. `endOfDay` extends the upper bound
// to 23:59:59.999 so the range is inclusive of the selected end date.
const dateToIso = (v: string, endOfDay = false): string | undefined => {
  if (!v) return undefined;
  const d = new Date(`${v}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}`);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
};
const isoToDate = (v: string): Date | undefined => {
  if (!v) return undefined;
  const [y, m, d] = v.split("-").map((n) => parseInt(n, 10));
  if (!y || !m || !d) return undefined;
  return new Date(y, m - 1, d);
};
const dateToIsoDay = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;


function AuditPanel() {
  const fetchLog = useServerFn(getAuditLog);
  const [rows, setRows] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [pageSize, setPageSize] = useState<number>(50);
  const [offset, setOffset] = useState(0);
  const [sortBy, setSortBy] = useState<AuditSortColumn>("created_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  // Draft filters are what the user is typing; applied filters are what's
  // actually sent to the server. Applying resets pagination to page 1.
  const [draft, setDraft] = useState<AuditFilters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<AuditFilters>(EMPTY_FILTERS);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchLog({
      data: {
        limit: pageSize,
        offset,
        sortBy,
        sortDir,
        entity: applied.entity || undefined,
        action: (applied.action || undefined) as any,
        clinician: applied.clinician || undefined,
        specialty: applied.specialty || undefined,
        from: dateToIso(applied.from),
        to: dateToIso(applied.to, true),

      },
    })
      .then((page) => {
        if (cancelled) return;
        setRows(page.rows);
        setTotal(page.total);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchLog, pageSize, offset, sortBy, sortDir, applied]);

  const applyFilters = (next: AuditFilters) => {
    setApplied(next);
    setOffset(0);
  };
  const onApply = (e: React.FormEvent) => {
    e.preventDefault();
    applyFilters(draft);
  };
  const onReset = () => {
    setDraft(EMPTY_FILTERS);
    applyFilters(EMPTY_FILTERS);
  };

  const toggleSort = (col: AuditSortColumn) => {
    if (sortBy === col) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(col);
      setSortDir(col === "created_at" ? "desc" : "asc");
    }
    setOffset(0);
  };

  const currentPage = Math.floor(offset / pageSize) + 1;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const rangeStart = total === 0 ? 0 : offset + 1;
  const rangeEnd = Math.min(offset + rows.length, total);

  const goPrev = () => setOffset((o) => Math.max(0, o - pageSize));
  const goNext = () =>
    setOffset((o) => (o + pageSize < total ? o + pageSize : o));
  const goFirst = () => setOffset(0);
  const goLast = () => setOffset(Math.max(0, (totalPages - 1) * pageSize));

  const sortIndicator = (col: AuditSortColumn) =>
    sortBy === col ? (sortDir === "asc" ? " ▲" : " ▼") : "";

  const SortableTh = ({
    col,
    label,
  }: {
    col: AuditSortColumn;
    label: string;
  }) => (
    <th className="text-left py-2">
      <button
        type="button"
        onClick={() => toggleSort(col)}
        aria-sort={
          sortBy === col
            ? sortDir === "asc"
              ? "ascending"
              : "descending"
            : "none"
        }
        className="inline-flex items-center gap-1 uppercase text-xs font-medium text-muted-foreground hover:text-foreground focus:outline-none focus:underline"
      >
        {label}
        <span aria-hidden="true">{sortIndicator(col)}</span>
      </button>
    </th>
  );

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
        <h2 className="font-semibold">Audit log</h2>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <label htmlFor="audit-page-size">Rows per page</label>
          <select
            id="audit-page-size"
            className="border rounded px-2 py-1 bg-background text-foreground"
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number(e.target.value));
              setOffset(0);
            }}
          >
            {PAGE_SIZE_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Quick filters:</span>
        {AUDIT_QUICK_FILTERS.map((preset) => {
          const active =
            applied.entity === preset.entity &&
            applied.action === preset.action;
          return (
            <Button
              key={preset.label}
              type="button"
              size="sm"
              variant={active ? "default" : "outline"}
              aria-pressed={active}
              onClick={() => {
                const next = {
                  ...EMPTY_FILTERS,
                  entity: active ? "" : preset.entity,
                  action: active ? "" : preset.action,
                };
                setDraft(next);
                applyFilters(next);
              }}
            >
              {preset.label}
            </Button>
          );
        })}
        {(applied.entity || applied.action) && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onReset}
            aria-label="Clear quick filters"
          >
            Clear
          </Button>
        )}
      </div>

      <form
        onSubmit={onApply}
        aria-label="Filter audit log"
        className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3"
      >
        <div className="flex flex-col gap-1">
          <Label htmlFor="audit-filter-entity" className="text-xs">Entity</Label>
          <select
            id="audit-filter-entity"
            className="border rounded px-2 py-1.5 text-sm bg-background text-foreground"
            value={draft.entity}
            onChange={(e) => setDraft((d) => ({ ...d, entity: e.target.value }))}
          >
            <option value="">All entities</option>
            {AUDIT_ENTITY_OPTIONS.map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="audit-filter-action" className="text-xs">Action</Label>
          <select
            id="audit-filter-action"
            className="border rounded px-2 py-1.5 text-sm bg-background text-foreground"
            value={draft.action}
            onChange={(e) => setDraft((d) => ({ ...d, action: e.target.value }))}
          >
            <option value="">All actions</option>
            {AUDIT_ACTION_OPTIONS.map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="audit-filter-clinician" className="text-xs">Clinician</Label>
          <Input
            id="audit-filter-clinician"
            placeholder="Name or user ID"
            value={draft.clinician}
            onChange={(e) => setDraft((d) => ({ ...d, clinician: e.target.value }))}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="audit-filter-specialty" className="text-xs">Specialty (referrals)</Label>
          <Input
            id="audit-filter-specialty"
            placeholder="e.g. General Surgery"
            value={draft.specialty}
            onChange={(e) => setDraft((d) => ({ ...d, specialty: e.target.value }))}
          />
        </div>
        <div className="flex flex-col gap-1 sm:col-span-2">
          <Label className="text-xs" id="audit-filter-range-label">Referral date range</Label>
          <AuditDateRangePicker
            value={{ from: isoToDate(draft.from), to: isoToDate(draft.to) }}
            onChange={(range) =>
              setDraft((d) => ({
                ...d,
                from: range?.from ? dateToIsoDay(range.from) : "",
                to: range?.to ? dateToIsoDay(range.to) : "",
              }))
            }
          />
        </div>

        <div className="sm:col-span-2 lg:col-span-3 flex items-center gap-2">
          <Button type="submit" size="sm">Apply filters</Button>
          <Button type="button" size="sm" variant="outline" onClick={onReset}>
            Reset
          </Button>
        </div>
      </form>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead>
                <tr>
                  <SortableTh col="created_at" label="When" />
                  <SortableTh col="action" label="Action" />
                  <SortableTh col="entity" label="Entity" />
                  <th className="text-left py-2 uppercase text-xs text-muted-foreground">ID</th>
                  <th className="text-left py-2 uppercase text-xs text-muted-foreground">User</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-4 text-center text-muted-foreground">
                      No audit entries.
                    </td>
                  </tr>
                ) : (
                  rows.map((r) => (
                    <tr key={r.id} className="border-t">
                      <td
                        className="py-1.5 whitespace-nowrap"
                        title={tzTooltip(r.created_at)}
                      >
                        {format(new Date(r.created_at), "dd/MM/yyyy HH:mm:ss")}
                      </td>
                      <td className="capitalize">{r.action}</td>
                      <td>{r.entity}</td>
                      <td className="font-mono text-xs">
                        {r.entity_id?.slice(0, 8) ?? "—"}
                      </td>
                      <td className="font-mono text-xs">
                        {r.user_id?.slice(0, 8) ?? "—"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <div aria-live="polite">
              {total === 0
                ? "0 entries"
                : `Showing ${rangeStart}–${rangeEnd} of ${total} — page ${currentPage} of ${totalPages}`}
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                onClick={goFirst}
                disabled={offset === 0}
                aria-label="First page"
              >
                « First
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={goPrev}
                disabled={offset === 0}
                aria-label="Previous page"
              >
                ‹ Prev
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={goNext}
                disabled={offset + pageSize >= total}
                aria-label="Next page"
              >
                Next ›
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={goLast}
                disabled={offset + pageSize >= total}
                aria-label="Last page"
              >
                Last »
              </Button>
            </div>
          </div>
        </>
      )}
    </Card>
  );
}

/**
 * Popover-anchored range calendar for the Audit tab. The trigger shows
 * the current selection in "dd/MM/yyyy" or a "Pick a date range"
 * placeholder. Selecting a range fires `onChange`; clearing it fires
 * `onChange(undefined)`.
 */
function AuditDateRangePicker({
  value,
  onChange,
}: {
  value: DateRange | undefined;
  onChange: (range: DateRange | undefined) => void;
}) {
  const label = value?.from
    ? value.to
      ? `${format(value.from, "dd/MM/yyyy")} – ${format(value.to, "dd/MM/yyyy")}`
      : format(value.from, "dd/MM/yyyy")
    : "Pick a date range";
  const hasValue = Boolean(value?.from || value?.to);
  return (
    <div className="flex items-center gap-2">
      <Popover>
        <PopoverTrigger asChild>
          <Button
            id="audit-filter-range"
            type="button"
            variant="outline"
            aria-labelledby="audit-filter-range-label"
            className={cn(
              "justify-start text-left font-normal w-full sm:w-[280px]",
              !hasValue && "text-muted-foreground",
            )}
          >
            <CalendarIcon className="mr-2 h-4 w-4" />
            {label}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="range"
            selected={value}
            onSelect={onChange}
            numberOfMonths={2}
            initialFocus
            className={cn("p-3 pointer-events-auto")}
          />
        </PopoverContent>
      </Popover>
      {hasValue && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onChange(undefined)}
          aria-label="Clear date range"
        >
          Clear
        </Button>
      )}
    </div>
  );
}




