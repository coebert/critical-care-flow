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
    if (!uid) throw redirect({ to: "/auth" });
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
          <TabsTrigger value="audit">Audit log</TabsTrigger>
        </TabsList>
        <TabsContent value="users" className="mt-4 space-y-6">
          <InvitePanel />
          <UsersPanel />
        </TabsContent>
        <TabsContent value="beds" className="mt-4">
          <BedsAdminPanel />
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

function AuditPanel() {
  const fetchLog = useServerFn(getAuditLog);
  const [rows, setRows] = useState<any[]>([]);
  const [nextOffset, setNextOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    fetchLog({ data: { limit: 100, offset: 0 } })
      .then((page) => {
        setRows(page.rows);
        setHasMore(page.hasMore);
        setNextOffset(page.nextOffset);
      })
      .finally(() => setLoading(false));
  }, [fetchLog]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const page = await fetchLog({ data: { limit: 100, offset: nextOffset } });
      setRows((cur) => [...cur, ...page.rows]);
      setHasMore(page.hasMore);
      setNextOffset(page.nextOffset);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <Card className="p-5">
      <h2 className="font-semibold mb-3">Audit log</h2>
      {loading ? <p className="text-sm text-muted-foreground">Loading…</p> : (
        <>
          <div className="overflow-x-auto"><table className="w-full text-sm min-w-[640px]">
            <thead className="text-xs uppercase text-muted-foreground">
              <tr><th className="text-left py-2">When</th><th className="text-left">Action</th><th className="text-left">Entity</th><th className="text-left">ID</th><th className="text-left">User</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="py-1.5 whitespace-nowrap" title={tzTooltip(r.created_at)}>{format(new Date(r.created_at), "dd/MM/yyyy HH:mm:ss")}</td>
                  <td className="capitalize">{r.action}</td>
                  <td>{r.entity}</td>
                  <td className="font-mono text-xs">{r.entity_id?.slice(0, 8) ?? "—"}</td>
                  <td className="font-mono text-xs">{r.user_id?.slice(0, 8) ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
          {hasMore && (
            <div className="mt-3 flex justify-center">
              <Button variant="outline" size="sm" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? "Loading…" : "Load more"}
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}


