import { useState, useEffect } from "react";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { usePush } from "@/hooks/use-push";
import { Bell, X } from "lucide-react";

const DISMISS_KEY = "push-permission-prompt-dismissed";

type Platform =
  | "safari-ios-standalone"
  | "safari-ios-browser"
  | "safari-macos"
  | "chrome"
  | "firefox"
  | "edge"
  | "other";

function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent;
  const isIOS =
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === "MacIntel" && (navigator as Navigator & { maxTouchPoints?: number }).maxTouchPoints! > 1);
  const isSafari = /^((?!chrome|android|crios|fxios|edgios).)*safari/i.test(ua);
  const standalone =
    (typeof window !== "undefined" &&
      window.matchMedia?.("(display-mode: standalone)").matches) ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;

  if (isIOS) return standalone ? "safari-ios-standalone" : "safari-ios-browser";
  if (isSafari) return "safari-macos";
  if (/edg\//i.test(ua)) return "edge";
  if (/firefox/i.test(ua)) return "firefox";
  if (/chrome|crios/i.test(ua)) return "chrome";
  return "other";
}

function PlatformInstructions({ platform }: { platform: Platform }) {
  if (platform === "safari-ios-browser") {
    return (
      <div className="space-y-2">
        <p className="font-medium">
          iOS Safari only delivers push notifications to apps installed on your Home Screen.
        </p>
        <ol className="list-decimal pl-5 space-y-1 text-sm">
          <li>Tap the Share icon at the bottom of Safari.</li>
          <li>Scroll and tap <strong>Add to Home Screen</strong>, then tap <strong>Add</strong>.</li>
          <li>Open the new app icon from your Home Screen.</li>
          <li>Tap <strong>Enable push notifications</strong> here and choose <strong>Allow</strong>.</li>
        </ol>
      </div>
    );
  }
  if (platform === "safari-ios-standalone") {
    return (
      <ol className="list-decimal pl-5 space-y-1 text-sm">
        <li>Open the iOS <strong>Settings</strong> app.</li>
        <li>Scroll down and tap <strong>Notifications</strong>.</li>
        <li>Find this app in the list and tap it.</li>
        <li>Turn on <strong>Allow Notifications</strong>.</li>
        <li>Return here and tap <strong>Enable push notifications</strong>.</li>
      </ol>
    );
  }
  if (platform === "safari-macos") {
    return (
      <ol className="list-decimal pl-5 space-y-1 text-sm">
        <li>In the menu bar, open <strong>Safari → Settings…</strong> (or press <kbd>⌘</kbd>+<kbd>,</kbd>).</li>
        <li>Click the <strong>Websites</strong> tab.</li>
        <li>Select <strong>Notifications</strong> in the left sidebar.</li>
        <li>Find this site and set it to <strong>Allow</strong>.</li>
        <li>Return here and tap <strong>Enable push notifications</strong>.</li>
      </ol>
    );
  }
  if (platform === "chrome") {
    return (
      <ol className="list-decimal pl-5 space-y-1 text-sm">
        <li>Click the lock / tune icon to the left of the address bar.</li>
        <li>Choose <strong>Site settings</strong>.</li>
        <li>Set <strong>Notifications</strong> to <strong>Allow</strong>.</li>
        <li>Reload the page and tap <strong>Enable push notifications</strong>.</li>
      </ol>
    );
  }
  if (platform === "firefox") {
    return (
      <ol className="list-decimal pl-5 space-y-1 text-sm">
        <li>Click the lock icon next to the address bar.</li>
        <li>Next to <strong>Send Notifications</strong>, click the <strong>×</strong> to clear the block.</li>
        <li>Reload the page and tap <strong>Enable push notifications</strong>, then choose <strong>Allow</strong>.</li>
      </ol>
    );
  }
  if (platform === "edge") {
    return (
      <ol className="list-decimal pl-5 space-y-1 text-sm">
        <li>Click the lock icon next to the address bar.</li>
        <li>Choose <strong>Permissions for this site</strong>.</li>
        <li>Set <strong>Notifications</strong> to <strong>Allow</strong>.</li>
        <li>Reload the page and tap <strong>Enable push notifications</strong>.</li>
      </ol>
    );
  }
  return (
    <p className="text-sm">
      Open your browser's site settings for this page and set <strong>Notifications</strong> to{" "}
      <strong>Allow</strong>, then reload.
    </p>
  );
}

export function PushPermissionPrompt({ visible }: { visible: boolean }) {
  const [dismissed, setDismissed] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const { permission, enable, requestPermission, permissionContextError, openPushPermissionSetupWindow } = usePush();
  const platform = detectPlatform();

  useEffect(() => {
    try {
      const raw = localStorage.getItem(DISMISS_KEY);
      if (raw) {
        const data = JSON.parse(raw) as { until?: number };
        if (data.until && Date.now() < data.until) {
          setDismissed(true);
        }
      }
    } catch (_) {
      // ignore
    }
  }, []);

  const handleDismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(
        DISMISS_KEY,
        JSON.stringify({ until: Date.now() + 24 * 60 * 60 * 1000 }),
      );
    } catch (_) {}
  };

  // Synchronous click handler — kicks off Notification.requestPermission()
  // before any await so Safari and Firefox preserve user activation and
  // actually show their permission prompt.
  const handleEnable = () => {
    if (permissionContextError) {
      openPushPermissionSetupWindow();
      setShowHelp(true);
      return;
    }
    setEnabling(true);
    let permPromise: Promise<NotificationPermission>;
    try {
      permPromise = requestPermission();
    } catch (e) {
      setEnabling(false);
      setShowHelp(true);
      return;
    }
    permPromise
      .then(async (perm) => {
        if (perm !== "granted") {
          setShowHelp(true);
          return;
        }
        await enable();
      })
      .catch(() => {
        setShowHelp(true);
      })
      .finally(() => {
        setEnabling(false);
      });
  };

  if (!visible || dismissed) return null;

  const isDenied = permission === "denied";
  const needsInstall = platform === "safari-ios-browser";
  const showInstructions = isDenied || showHelp || needsInstall || !!permissionContextError;

  return (
    <div className="px-4 py-2">
      <Alert variant={isDenied ? "destructive" : "default"} className="relative pr-10">
        <Bell className="w-4 h-4" />
        <AlertTitle>
          {isDenied
            ? "Push notifications are blocked"
            : needsInstall
              ? "Install this app to receive push notifications"
              : "Enable push notifications"}
        </AlertTitle>
        <AlertDescription className="mt-1 space-y-3">
          {!showInstructions && (
            <p>
              Get real-time alerts for new referrals, status changes, and notes while you're on
              shift.
            </p>
          )}

          {showInstructions && (
            <div className="rounded-md border border-current/20 bg-background/40 p-3">
              {permissionContextError && (
                <p className="mb-2 text-sm font-medium">{permissionContextError}</p>
              )}
              <p className="mb-2 text-sm font-medium">
                Browsers don't allow apps to open settings for you — here's how to do it:
              </p>
              <PlatformInstructions platform={platform} />
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {!needsInstall && (
              <Button size="sm" onClick={handleEnable} disabled={enabling}>
                {permissionContextError
                  ? "Open setup tab"
                  : enabling
                    ? "Requesting…"
                    : "Enable push notifications"}
              </Button>
            )}
            {!showInstructions && (
              <Button size="sm" variant="outline" onClick={() => setShowHelp(true)}>
                Show setup steps
              </Button>
            )}
          </div>
        </AlertDescription>
        <Button
          variant="ghost"
          size="icon"
          className="absolute top-2 right-2 h-6 w-6"
          onClick={handleDismiss}
          aria-label="Dismiss notification prompt"
        >
          <X className="w-3 h-3" />
        </Button>
      </Alert>
    </div>
  );
}
