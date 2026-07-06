import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Settings2 } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
  DialogFooter, DialogTrigger, DialogClose,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { updateIcnarcTargets } from "@/lib/admin.functions";

export function IcnarcTargetsDialog({
  timeToSeen,
  decisionToArrival,
  onSaved,
}: {
  timeToSeen: number;
  decisionToArrival: number;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(String(timeToSeen));
  const [arrival, setArrival] = useState(String(decisionToArrival));
  const [saving, setSaving] = useState(false);
  const updateTargets = useServerFn(updateIcnarcTargets);

  const openDialog = (next: boolean) => {
    if (next) {
      setSeen(String(timeToSeen));
      setArrival(String(decisionToArrival));
    }
    setOpen(next);
  };

  const handleSave = async () => {
    const seenMin = Number(seen);
    const arrivalMin = Number(arrival);
    if (!Number.isFinite(seenMin) || seenMin <= 0 || seenMin > 100000) {
      toast.error("Referral → first seen must be between 1 and 100000 minutes.");
      return;
    }
    if (!Number.isFinite(arrivalMin) || arrivalMin <= 0 || arrivalMin > 100000) {
      toast.error("Decision → on unit must be between 1 and 100000 minutes.");
      return;
    }
    setSaving(true);
    try {
      await updateTargets({
        data: {
          time_to_seen_target_min: Math.round(seenMin),
          decision_to_arrival_target_min: Math.round(arrivalMin),
        },
      });
      toast.success("ICNARC thresholds updated.");
      onSaved();
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save thresholds.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={openDialog}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Settings2 className="mr-2 h-4 w-4" />
          Edit targets
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>ICNARC timing targets</DialogTitle>
          <DialogDescription>
            Thresholds are shared across all clinicians and used to compute % within target
            on this page.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="icnarc-seen">Referral → first seen (minutes)</Label>
            <Input
              id="icnarc-seen"
              type="number"
              min={1}
              max={100000}
              step={1}
              value={seen}
              onChange={(e) => setSeen(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Default 30 min. Currently {timeToSeen} min.
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="icnarc-arrival">Decision → on unit (minutes)</Label>
            <Input
              id="icnarc-arrival"
              type="number"
              min={1}
              max={100000}
              step={1}
              value={arrival}
              onChange={(e) => setArrival(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Default 240 min (4 h). Currently {decisionToArrival} min
              {" "}(≈ {(decisionToArrival / 60).toFixed(1)} h).
            </p>
          </div>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" disabled={saving}>Cancel</Button>
          </DialogClose>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save thresholds"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
