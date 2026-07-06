import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Bell, BellOff, CheckCircle2, AlertTriangle, XCircle, HelpCircle } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { usePush } from "@/hooks/use-push";
import { TestPushButton } from "@/components/test-push-button";
import { readLastTestPushAt } from "@/lib/last-test-push";
import { useServerFn } from "@tanstack/react-start";
import { getNotificationPrefs, setNotificationPrefs } from "@/lib/notification-prefs.functions";
import { toast } from "sonner";


export const Route = createFileRoute("/_authenticated/notifications")({
  head: () => ({
    meta: [
      { title: "Notification settings — SDH Critical Care" },
      { name: "description", content: "Manage push notification status for this device." },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: NotificationSettingsPage,
});

type Tone = "ok" | "warn" | "error" | "muted";

function StatusRow({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone: Tone;
  hint?: string;
}) {
  const toneClasses: Record<Tone, string> = {
    ok: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200",
    warn: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
    error: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
    muted: "bg-muted text-muted-foreground",
  };
  return (
    <div className="flex items-start justify-between gap-4 py-3 border-b last:border-b-0">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="text-xs text-muted-foreground mt-0.5">{hint}</div>}
      </div>
      <Badge variant="secondary" className={toneClasses[tone]}>
        {value}
      </Badge>
    </div>
  );
}

function formatWhen(d: Date | null): string {
  if (!d) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);
}

function NotificationSettingsPage() {
  const { supported, permission, subscribed, enable, disable, requestPermission, permissionContextError, openPushPermissionSetupWindow } = usePush();
  const [lastTestAt, setLastTestAt] = useState<Date | null>(null);
  const [busy, setBusy] = useState<"enable" | "disable" | null>(null);
  const [notifyNotes, setNotifyNotes] = useState(true);
  const [notifyStatus, setNotifyStatus] = useState(true);
  const [notifyNew, setNotifyNew] = useState(true);
  const [notifyUpdated, setNotifyUpdated] = useState(true);
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  type PrefKey = "notes" | "status" | "new" | "updated";
  const [savingPref, setSavingPref] = useState<PrefKey | null>(null);
  const getPrefs = useServerFn(getNotificationPrefs);
  const savePrefs = useServerFn(setNotificationPrefs);

  useEffect(() => {
    setLastTestAt(readLastTestPushAt());
    getPrefs({})
      .then((p) => {
        setNotifyNotes(p.notify_notes);
        setNotifyStatus(p.notify_status);
        setNotifyNew(p.notify_new_referral);
        setNotifyUpdated(p.notify_updated_referral);
      })
      .catch(() => {})
      .finally(() => setPrefsLoaded(true));
  }, [getPrefs]);

  const refreshLastTest = () => setLastTestAt(readLastTestPushAt());

  const prefState: Record<PrefKey, [boolean, (v: boolean) => void, string]> = {
    notes: [notifyNotes, setNotifyNotes, "notify_notes"],
    status: [notifyStatus, setNotifyStatus, "notify_status"],
    new: [notifyNew, setNotifyNew, "notify_new_referral"],
    updated: [notifyUpdated, setNotifyUpdated, "notify_updated_referral"],
  };

  const togglePref = async (key: PrefKey, next: boolean) => {
    const [prev, setter, field] = prefState[key];
    setter(next);
    setSavingPref(key);
    try {
      await savePrefs({ data: { [field]: next } as any });
    } catch (e: any) {
      setter(prev);
      toast.error(e?.message ?? "Could not save preference.");
    } finally {
      setSavingPref(null);
    }
  };



  // Synchronous handler — fire Notification.requestPermission() before any
  // await so Safari/Firefox keep user-activation and show their prompt.
  const handleEnable = () => {
    if (permissionContextError) {
      openPushPermissionSetupWindow();
      toast.message("Opened a separate setup tab for browser notification permission.");
      return;
    }
    setBusy("enable");
    let permPromise: Promise<NotificationPermission>;
    try {
      permPromise = requestPermission();
    } catch (e: any) {
      toast.error(e?.message ?? "Could not enable push notifications.");
      setBusy(null);
      return;
    }
    permPromise
      .then(async (perm) => {
        if (perm !== "granted") {
          toast.error("Notification permission was not granted.");
          return;
        }
        await enable();
        toast.success("Push notifications enabled on this device.");
      })
      .catch((e: any) => {
        toast.error(e?.message ?? "Could not enable push notifications.");
      })
      .finally(() => setBusy(null));
  };

  const handleDisable = async () => {
    setBusy("disable");
    try {
      await disable();
      toast.success("Push notifications disabled on this device.");
    } catch (e: any) {
      toast.error(e?.message ?? "Could not disable push notifications.");
    } finally {
      setBusy(null);
    }
  };

  // Derive a top-line summary.
  const summary: { icon: React.ReactNode; label: string; tone: Tone; description: string } = !supported
    ? {
        icon: <HelpCircle className="w-5 h-5" />,
        label: "Not supported",
        tone: "muted",
        description:
          "This browser or device does not support web push notifications. Try a recent version of Chrome, Edge, Firefox, or Safari.",
      }
    : permission === "denied"
      ? {
          icon: <XCircle className="w-5 h-5" />,
          label: "Blocked by browser",
          tone: "error",
          description:
            "Notifications are blocked. Click the lock icon next to the address bar, clear the blocked Notifications permission, then return here and enable them.",
        }
      : permission === "granted" && subscribed
        ? {
            icon: <CheckCircle2 className="w-5 h-5" />,
            label: "Enabled",
            tone: "ok",
            description:
              "You'll receive push notifications on this device for new referrals and status changes while you're on shift.",
          }
        : permission === "granted" && !subscribed
          ? {
              icon: <AlertTriangle className="w-5 h-5" />,
              label: "Permission granted, not subscribed",
              tone: "warn",
              description:
                "Your browser allows notifications but no subscription is registered for this device. Enable to register one.",
            }
          : {
              icon: <BellOff className="w-5 h-5" />,
              label: "Not enabled",
              tone: "warn",
              description:
                "Notifications are not yet enabled on this device. Enable to start receiving alerts.",
            };

  const canEnable = supported && permission !== "denied" && !(permission === "granted" && subscribed);
  const canDisable = supported && subscribed;
  const canTest = supported && permission === "granted" && subscribed;

  return (
    <div className="max-w-2xl mx-auto p-4 md:p-6 space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Notifications</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Push notification status for this device. Subscriptions are per-device, so enable on every browser or phone where you want alerts.
        </p>
      </div>

      <Card className="p-5">
        <div className="flex items-start gap-3">
          <div className="mt-0.5">{summary.icon}</div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="font-medium">{summary.label}</h2>
            </div>
            <p className="text-sm text-muted-foreground mt-1">{summary.description}</p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 mt-4">
          {canEnable && (
            <Button onClick={handleEnable} disabled={busy !== null}>
              <Bell className="w-4 h-4 mr-1" />
              {busy === "enable" ? "Enabling…" : "Enable on this device"}
            </Button>
          )}
          {canDisable && (
            <Button variant="outline" onClick={handleDisable} disabled={busy !== null}>
              <BellOff className="w-4 h-4 mr-1" />
              {busy === "disable" ? "Disabling…" : "Disable on this device"}
            </Button>
          )}
          {canTest && <TestPushButton onSuccess={refreshLastTest} />}
        </div>
      </Card>

      <Card className="p-5">
        <h2 className="font-medium mb-2">Details</h2>
        <StatusRow
          label="Browser support"
          value={supported ? "Supported" : "Not supported"}
          tone={supported ? "ok" : "muted"}
          hint="Service Worker, Push, and Notification APIs available."
        />
        <StatusRow
          label="Browser permission"
          value={
            permission === "granted"
              ? "Granted"
              : permission === "denied"
                ? "Blocked"
                : "Not asked"
          }
          tone={permission === "granted" ? "ok" : permission === "denied" ? "error" : "warn"}
          hint="Controlled by the browser, per site."
        />
        <StatusRow
          label="Push subscription"
          value={subscribed ? "Active" : "None"}
          tone={subscribed ? "ok" : "warn"}
          hint="A subscription is registered with this server for this device."
        />
        <StatusRow
          label="Last successful test push"
          value={formatWhen(lastTestAt)}
          tone={lastTestAt ? "ok" : "muted"}
          hint="Recorded on this device when you use the Test push button."
        />
      </Card>

      <Card className="p-5">
        <h2 className="font-medium mb-1">Alert types</h2>
        <p className="text-sm text-muted-foreground mb-4">
          New and updated referrals always alert you while on shift. Choose whether to also
          receive alerts for note additions and status changes.
        </p>
        <div className="flex items-start justify-between gap-4 py-3 border-b">
          <div className="min-w-0">
            <Label htmlFor="pref-notes" className="text-sm font-medium">
              New notes on referrals
            </Label>
            <div className="text-xs text-muted-foreground mt-0.5">
              Push and in-app alert when someone adds a note to a referral.
            </div>
          </div>
          <Switch
            id="pref-notes"
            checked={notifyNotes}
            disabled={!prefsLoaded || savingPref !== null}
            onCheckedChange={(v) => togglePref("notes", v)}
          />
        </div>
        <div className="flex items-start justify-between gap-4 py-3">
          <div className="min-w-0">
            <Label htmlFor="pref-status" className="text-sm font-medium">
              Referral status changes
            </Label>
            <div className="text-xs text-muted-foreground mt-0.5">
              Alerts for accepted, declined, admitted and other status transitions.
            </div>
          </div>
          <Switch
            id="pref-status"
            checked={notifyStatus}
            disabled={!prefsLoaded || savingPref !== null}
            onCheckedChange={(v) => togglePref("status", v)}
          />
        </div>
      </Card>
    </div>

  );
}
