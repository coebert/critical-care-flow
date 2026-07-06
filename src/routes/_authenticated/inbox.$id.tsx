import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArrowLeft, Check, ExternalLink, Inbox as InboxIcon } from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/inbox/$id")({
  head: () => ({
    meta: [
      { title: "Notification — SDH Critical Care" },
      { name: "description", content: "Notification details." },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: NotificationDetailPage,
  errorComponent: ({ error }) => (
    <div className="max-w-2xl mx-auto p-6 text-sm text-destructive" role="alert">
      {error.message}
    </div>
  ),
  notFoundComponent: () => (
    <div className="max-w-2xl mx-auto p-6 text-sm text-muted-foreground">
      Notification not found.
    </div>
  ),
});

interface Notification {
  id: string;
  referral_id: string | null;
  kind: string;
  message: string;
  read_at: string | null;
  created_at: string;
}

interface ReferralSummary {
  id: string;
  age: number | null;
  current_ward: string | null;
  status: string | null;
  referral_received_at: string | null;
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "new": return "New referral";
    case "status": return "Status change";
    case "note": return "New note";
    case "updated": return "Referral updated";
    case "warning": return "Warning";
    default: return kind;
  }
}

function NotificationDetailPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const [n, setN] = useState<Notification | null>(null);
  const [ref, setRef] = useState<ReferralSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    supabase
      .from("notifications")
      .select("*")
      .eq("id", id)
      .maybeSingle()
      .then(async ({ data, error }) => {
        if (cancelled) return;
        if (error || !data) {
          setN(null);
          setLoading(false);
          return;
        }
        setN(data);
        if (data.referral_id) {
          const { data: r } = await supabase
            .from("referrals")
            .select("id, age, current_ward, status, referral_received_at")
            .eq("id", data.referral_id)
            .maybeSingle();
          if (!cancelled) setRef(r ?? null);
        }
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const markRead = async () => {
    if (!n || n.read_at) return;
    setBusy(true);
    const now = new Date().toISOString();
    const { error } = await supabase
      .from("notifications")
      .update({ read_at: now })
      .eq("id", n.id);
    setBusy(false);
    if (error) {
      toast.error("Could not mark as read");
      return;
    }
    setN({ ...n, read_at: now });
    toast.success("Marked as read");
  };

  const markUnread = async () => {
    if (!n || !n.read_at) return;
    setBusy(true);
    const { error } = await supabase
      .from("notifications")
      .update({ read_at: null })
      .eq("id", n.id);
    setBusy(false);
    if (error) {
      toast.error("Could not mark as unread");
      return;
    }
    setN({ ...n, read_at: null });
  };

  if (loading) {
    return <div className="max-w-2xl mx-auto p-6 text-sm text-muted-foreground">Loading…</div>;
  }

  if (!n) {
    return (
      <div className="max-w-2xl mx-auto p-6 space-y-3">
        <Button variant="ghost" size="sm" onClick={() => navigate({ to: "/inbox" })}>
          <ArrowLeft className="w-4 h-4 mr-1" /> Back to inbox
        </Button>
        <div className="text-sm text-muted-foreground">Notification not found.</div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto p-4 space-y-4">
      <div>
        <Link to="/inbox" className="text-sm text-primary hover:underline inline-flex items-center gap-1">
          <ArrowLeft className="w-4 h-4" /> Back to inbox
        </Link>
      </div>

      <Card className="p-4 space-y-4">
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <InboxIcon className="w-5 h-5" />
            <h1 className="text-lg font-semibold">{kindLabel(n.kind)}</h1>
            <Badge variant={n.read_at ? "secondary" : "default"}>
              {n.read_at ? "Read" : "Unread"}
            </Badge>
          </div>
          {n.read_at ? (
            <Button variant="outline" size="sm" onClick={markUnread} disabled={busy}>
              Mark unread
            </Button>
          ) : (
            <Button size="sm" onClick={markRead} disabled={busy}>
              <Check className="w-4 h-4 mr-1" /> Mark as read
            </Button>
          )}
        </div>

        <div className="text-sm whitespace-pre-wrap break-words">{n.message}</div>

        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm border-t pt-3">
          <div>
            <dt className="text-xs text-muted-foreground">Received</dt>
            <dd>
              {format(new Date(n.created_at), "dd/MM/yyyy HH:mm:ss")}
              <span className="text-muted-foreground text-xs ml-1">
                ({formatDistanceToNow(new Date(n.created_at), { addSuffix: true })})
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Read</dt>
            <dd>
              {n.read_at ? (
                <>
                  {format(new Date(n.read_at), "dd/MM/yyyy HH:mm:ss")}
                  <span className="text-muted-foreground text-xs ml-1">
                    ({formatDistanceToNow(new Date(n.read_at), { addSuffix: true })})
                  </span>
                </>
              ) : (
                <span className="text-muted-foreground">Not yet read</span>
              )}
            </dd>
          </div>
        </dl>

        {n.referral_id && (
          <div className="border-t pt-3 space-y-2">
            <div className="text-xs text-muted-foreground">Related referral</div>
            {ref ? (
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="text-sm">
                  <div className="font-medium">
                    {[
                      ref.age != null ? `Age ${ref.age}` : null,
                      ref.current_ward,
                    ].filter(Boolean).join(" · ") || "Referral"}{" "}
                    {ref.status && (
                      <Badge variant="outline" className="ml-1 text-[10px]">
                        {ref.status}
                      </Badge>
                    )}
                  </div>
                  {ref.referral_received_at && (
                    <div className="text-xs text-muted-foreground">
                      Received {format(new Date(ref.referral_received_at), "dd/MM/yyyy HH:mm:ss")}
                    </div>
                  )}
                </div>
                <Button asChild size="sm">
                  <Link
                    to="/referrals/$id"
                    params={{ id: n.referral_id }}
                    onClick={() => {
                      if (!n.read_at) markRead();
                    }}
                  >
                    Open referral <ExternalLink className="w-3 h-3 ml-1" />
                  </Link>
                </Button>
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">
                Referral unavailable or has been removed.
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
