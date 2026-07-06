import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, XCircle, Circle, Loader2, BellRing } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { usePush } from "@/hooks/use-push";
import { sendTestPushNotification } from "@/lib/push.functions";
import { verifyPushSubscription } from "@/lib/push-verify.functions";
import { recordTestPushSuccess } from "@/lib/last-test-push";
import { toast } from "sonner";
import { format } from "date-fns";

export const Route = createFileRoute("/_authenticated/push-test")({
  head: () => ({
    meta: [
      { title: "Push notification test — SDH Critical Care" },
      { name: "description", content: "Run permission, subscription, verification and test push end-to-end." },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: PushTestPage,
});

type StepState = "idle" | "running" | "ok" | "fail";

type StepKey = "permission" | "subscribe" | "verify" | "send";

type StepInfo = {
  key: StepKey;
  title: string;
  description: string;
};

const STEPS: StepInfo[] = [
  { key: "permission", title: "1. Browser permission", description: "Prompt the browser for Notification permission." },
  { key: "subscribe", title: "2. Push subscription", description: "Register a Web Push subscription with the service worker." },
  { key: "verify", title: "3. Verify backend row", description: "Confirm the subscription is stored in push_subscriptions for your account." },
  { key: "send", title: "4. Send test push", description: "Deliver a test notification to every device subscribed to your account." },
];

function StepRow({
  step,
  state,
  detail,
}: {
  step: StepInfo;
  state: StepState;
  detail?: string | null;
}) {
  const Icon =
    state === "ok"
      ? CheckCircle2
      : state === "fail"
        ? XCircle
        : state === "running"
          ? Loader2
          : Circle;
  const color =
    state === "ok"
      ? "text-green-600"
      : state === "fail"
        ? "text-red-600"
        : state === "running"
          ? "text-blue-600"
          : "text-muted-foreground";
  return (
    <div className="flex items-start gap-3 py-3 border-b last:border-b-0">
      <Icon className={`w-5 h-5 mt-0.5 shrink-0 ${color} ${state === "running" ? "animate-spin" : ""}`} />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{step.title}</div>
        <div className="text-xs text-muted-foreground mt-0.5">{step.description}</div>
        {detail && (
          <div className={`text-xs mt-1 break-words ${state === "fail" ? "text-red-600" : "text-foreground"}`}>
            {detail}
          </div>
        )}
      </div>
    </div>
  );
}

function PushTestPage() {
  const { supported, permission, subscribed, enable, requestPermission, permissionContextError, openPushPermissionSetupWindow } = usePush();
  const verifyFn = useServerFn(verifyPushSubscription);
  const sendFn = useServerFn(sendTestPushNotification);

  const [states, setStates] = useState<Record<StepKey, StepState>>({
    permission: "idle",
    subscribe: "idle",
    verify: "idle",
    send: "idle",
  });
  const [details, setDetails] = useState<Record<StepKey, string | null>>({
    permission: null,
    subscribe: null,
    verify: null,
    send: null,
  });
  const [running, setRunning] = useState(false);

  const setStep = useCallback((key: StepKey, state: StepState, detail?: string | null) => {
    setStates((s) => ({ ...s, [key]: state }));
    if (detail !== undefined) setDetails((d) => ({ ...d, [key]: detail }));
  }, []);

  const reset = () => {
    setStates({ permission: "idle", subscribe: "idle", verify: "idle", send: "idle" });
    setDetails({ permission: null, subscribe: null, verify: null, send: null });
  };

  // IMPORTANT: requestPermission() must be invoked synchronously from the click
  // handler so Safari/Firefox keep user activation.
  const handleRun = () => {
    if (!supported) {
      toast.error("Push notifications are not supported in this browser.");
      return;
    }
    if (permissionContextError) {
      openPushPermissionSetupWindow();
      toast.message("Opened a separate setup tab. Allow notifications there, then return and run again.");
      return;
    }

    reset();
    setRunning(true);
    setStep("permission", "running", "Waiting for browser prompt…");

    let permPromise: Promise<NotificationPermission>;
    try {
      permPromise = requestPermission();
    } catch (e: any) {
      setStep("permission", "fail", e?.message ?? "Failed to request permission.");
      setRunning(false);
      return;
    }

    permPromise
      .then(async (perm) => {
        if (perm !== "granted") {
          setStep("permission", "fail", `Permission was "${perm}". Allow notifications and try again.`);
          return;
        }
        setStep("permission", "ok", "Permission granted.");

        setStep("subscribe", "running", "Registering service worker and Push subscription…");
        await enable();
        const reg = await navigator.serviceWorker.getRegistration("/sw-push.js");
        const sub = reg ? await reg.pushManager.getSubscription() : null;
        if (!sub) {
          setStep("subscribe", "fail", "Subscription was not created.");
          return;
        }
        setStep("subscribe", "ok", `Endpoint: ${sub.endpoint.slice(0, 60)}…`);

        setStep("verify", "running", "Checking push_subscriptions row…");
        const result = await verifyFn({ data: { endpoint: sub.endpoint } });
        if (!result.found) {
          setStep("verify", "fail", "No matching row found in push_subscriptions.");
          return;
        }
        if (!result.ownedByCurrentUser) {
          setStep("verify", "fail", "Row exists but is not owned by the current user.");
          return;
        }
        setStep(
          "verify",
          "ok",
          `Row found · last used ${format(new Date(result.lastUsedAt ?? result.createdAt ?? Date.now()), "dd/MM/yyyy HH:mm:ss")}`,
        );

        setStep("send", "running", "Dispatching test push…");
        const sendResult = await sendFn();
        if (!sendResult.ok) {
          setStep("send", "fail", sendResult.error ?? "Failed to send test push.");
          return;
        }
        recordTestPushSuccess();
        setStep("send", "ok", `Sent to ${sendResult.sent} device${sendResult.sent === 1 ? "" : "s"}. Check your system notifications.`);
        toast.success("Push notification test completed successfully.");
      })
      .catch((e: any) => {
        const msg = e?.message ?? "Unexpected error during push test.";
        toast.error(msg);
        setStates((s) => {
          const next = { ...s };
          (Object.keys(next) as StepKey[]).forEach((k) => {
            if (next[k] === "running") next[k] = "fail";
          });
          return next;
        });
        setDetails((d) => {
          const next = { ...d };
          (Object.keys(states) as StepKey[]).forEach((k) => {
            if (states[k] === "running" && !next[k]) next[k] = msg;
          });
          return next;
        });
      })
      .finally(() => setRunning(false));
  };

  return (
    <div className="max-w-2xl mx-auto p-4 md:p-6 space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Push notification test</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Runs the full flow end-to-end on this device: request permission, create a Web Push subscription,
          verify the backend row, then deliver a real test notification.
        </p>
      </div>

      <Card className="p-5">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant="secondary">Supported: {supported ? "yes" : "no"}</Badge>
            <Badge variant="secondary">Permission: {permission}</Badge>
            <Badge variant="secondary">Subscribed: {subscribed ? "yes" : "no"}</Badge>
          </div>
          <Button onClick={handleRun} disabled={running || !supported}>
            <BellRing className="w-4 h-4 mr-1" />
            {running ? "Running…" : "Run full test"}
          </Button>
        </div>

        {permissionContextError && (
          <div className="text-xs text-amber-700 dark:text-amber-300 mb-3">
            {permissionContextError}
          </div>
        )}

        <div>
          {STEPS.map((step) => (
            <StepRow key={step.key} step={step} state={states[step.key]} detail={details[step.key]} />
          ))}
        </div>
      </Card>

      <div className="text-xs text-muted-foreground">
        Detailed status and per-device controls are on the{" "}
        <Link to="/notifications" className="underline">Notifications</Link> page.
      </div>
    </div>
  );
}
