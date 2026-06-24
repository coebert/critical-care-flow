import { useState, useEffect } from "react";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { usePush } from "@/hooks/use-push";
import { Bell, X } from "lucide-react";

const DISMISS_KEY = "push-permission-prompt-dismissed";

function getBrowserInstructions(): string {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("chrome") && !ua.includes("edg")) {
    return "Click the lock icon (or the three dots → Settings) next to the address bar, then set Notifications to Allow.";
  }
  if (ua.includes("firefox")) {
    return "Click the lock icon next to the address bar, then clear the blocked permission for Notifications and choose Allow.";
  }
  if (ua.includes("safari")) {
    return "Open Safari Preferences → Websites → Notifications, find this site, and set it to Allow.";
  }
  if (ua.includes("edg")) {
    return "Click the lock icon next to the address bar, then set Notifications to Allow.";
  }
  return "Open your browser settings, find the Notifications section for this site, and set it to Allow.";
}

export function PushPermissionPrompt({ visible }: { visible: boolean }) {
  const [dismissed, setDismissed] = useState(false);

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
      // Snooze for 24 hours so the prompt can re-appear if the user changes their mind
      localStorage.setItem(DISMISS_KEY, JSON.stringify({ until: Date.now() + 24 * 60 * 60 * 1000 }));
    } catch (_) {}
  };

  if (!visible || dismissed) return null;

  return (
    <div className="px-4 py-2">
      <Alert variant="destructive" className="relative pr-10">
        <Bell className="w-4 h-4" />
        <AlertTitle>Push notifications are blocked</AlertTitle>
        <AlertDescription className="mt-1">
          <p className="mb-2">{getBrowserInstructions()}</p>
          <p className="text-xs opacity-80">
            Once enabled, you’ll receive real-time alerts for new referrals, status changes, and notes while you’re on shift.
          </p>
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
