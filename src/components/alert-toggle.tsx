import { useEffect, useState } from "react";
import { Bell, BellOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isAlertsEnabled, setAlertsEnabled, primeAudio } from "@/hooks/use-new-referral-alert";
import { toast } from "sonner";

/**
 * Bell toggle for the sound + vibration alert on new incoming referrals.
 * Opt-in, persisted in localStorage. Priming AudioContext on click keeps
 * browsers' autoplay policy happy.
 */
export function AlertToggle() {
  const [on, setOn] = useState<boolean>(() => isAlertsEnabled());

  useEffect(() => {
    const handler = () => setOn(isAlertsEnabled());
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  async function toggle() {
    const next = !on;
    setOn(next);
    setAlertsEnabled(next);
    if (next) {
      await primeAudio();
      toast.success("New-referral alerts armed", {
        description: "You'll hear a beep and feel a buzz on every new referral.",
      });
    } else {
      toast.message("New-referral alerts muted");
    }
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggle}
      className="relative h-9 w-9"
      aria-label={on ? "Mute new-referral alerts" : "Arm new-referral alerts"}
      title={on ? "Alerts on — click to mute" : "Alerts off — click to arm"}
    >
      {on ? <Bell className="w-4 h-4 text-red-500" /> : <BellOff className="w-4 h-4 text-muted-foreground" />}
      {on && (
        <span aria-hidden="true" className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-red-500" />
      )}
    </Button>
  );
}
