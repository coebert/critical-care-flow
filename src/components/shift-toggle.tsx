import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { setShiftStatus } from "@/lib/shift.functions";
import { useShiftStatus } from "@/hooks/use-shift-status";
import { usePush } from "@/hooks/use-push";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Briefcase, BellOff } from "lucide-react";
import { toast } from "sonner";

export function ShiftToggle() {
  const { atWork: serverAtWork, loading } = useShiftStatus();
  const [atWork, setAtWork] = useState(false);
  const [busy, setBusy] = useState(false);
  const setFn = useServerFn(setShiftStatus);
  const { supported, permission, subscribed, enable, disable } = usePush();

  useEffect(() => {
    if (serverAtWork !== null) {
      setAtWork(serverAtWork);
    }
  }, [serverAtWork]);

  const handleToggle = async (next: boolean) => {
    if (busy) return;
    setBusy(true);
    const previous = atWork;
    setAtWork(next);
    try {
      await setFn({ data: { is_at_work: next } });
      if (next) {
        if (supported) {
          try {
            await enable();
            toast.success("You're on shift — push notifications enabled.");
          } catch (e: any) {
            toast.warning(
              e?.message ||
                "On shift, but push notifications could not be enabled. You'll still see in-app alerts.",
            );
          }
        } else {
          toast.success("You're on shift. In-app alerts will appear here.");
        }
      } else {
        if (subscribed) {
          try {
            await disable();
          } catch (_) {}
        }
        toast.success("You're off shift — notifications paused.");
      }
    } catch (e: any) {
      setAtWork(previous);
      toast.error(e?.message || "Failed to update shift status.");
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground px-2">
        <Briefcase className="w-4 h-4" />
        <span>Loading…</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 px-2 py-1 rounded-md border bg-card">
      {atWork ? (
        <Briefcase className="w-4 h-4 text-primary" />
      ) : (
        <BellOff className="w-4 h-4 text-muted-foreground" />
      )}
      <Label
        htmlFor="shift-toggle"
        className="text-xs font-medium cursor-pointer select-none"
      >
        {atWork ? "At work" : "Off shift"}
      </Label>
      <Switch
        id="shift-toggle"
        checked={atWork}
        disabled={busy}
        onCheckedChange={handleToggle}
      />
      {atWork && supported && permission === "denied" && (
        <span
          className="text-[10px] text-destructive ml-1"
          title="Browser notifications are blocked. Enable them in your browser settings to receive push alerts."
        >
          push blocked
        </span>
      )}
    </div>
  );
}
