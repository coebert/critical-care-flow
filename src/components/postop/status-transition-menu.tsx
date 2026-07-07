import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useNavigate } from "@tanstack/react-router";
import {
  transitionBookingStatus,
  convertBookingToReferral,
} from "@/lib/postop-bookings.functions";
import {
  POSTOP_CANCELLATION_LABEL,
  POSTOP_CANCELLATION_REASONS,
  nextAllowedStatuses,
  isEligibleForConversion,
  type PostopBookingStatus,
  type PostopCancellationReason,
  POSTOP_STATUS_LABEL,
} from "@/lib/postop-lifecycle";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { ChevronDown, ArrowRightLeft } from "lucide-react";

export function StatusTransitionMenu({
  bookingId,
  currentStatus,
  proposedSurgeryDate,
  convertedReferralId,
  onChanged,
}: {
  bookingId: string;
  currentStatus: PostopBookingStatus;
  proposedSurgeryDate: string | null;
  convertedReferralId: string | null;
  onChanged?: () => void;
}) {
  const transition = useServerFn(transitionBookingStatus);
  const convert = useServerFn(convertBookingToReferral);
  const navigate = useNavigate();
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState<PostopCancellationReason>("no_bed");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  const allowed = nextAllowedStatuses(currentStatus);
  const canConvert = isEligibleForConversion({
    booking_status: currentStatus,
    proposed_surgery_date: proposedSurgeryDate,
    converted_referral_id: convertedReferralId,
  });

  const doTransition = async (next: PostopBookingStatus) => {
    if (next === "cancelled") {
      setCancelling(true);
      return;
    }
    try {
      setBusy(true);
      await transition({ data: { id: bookingId, next_status: next } });
      toast.success(`Moved to ${POSTOP_STATUS_LABEL[next]}`);
      onChanged?.();
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to change status");
    } finally {
      setBusy(false);
    }
  };

  const doCancel = async () => {
    try {
      setBusy(true);
      await transition({
        data: {
          id: bookingId,
          next_status: "cancelled",
          cancellation_reason: reason,
          cancellation_notes: notes || null,
        },
      });
      toast.success("Booking cancelled");
      setCancelling(false);
      setNotes("");
      onChanged?.();
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to cancel");
    } finally {
      setBusy(false);
    }
  };

  const doConvert = async () => {
    try {
      setBusy(true);
      const res = await convert({ data: { id: bookingId } });
      toast.success(res.reused ? "Booking already linked to a referral" : "Referral created");
      navigate({ to: "/referrals/$id", params: { id: res.referral_id } });
    } catch (e: any) {
      toast.error(e?.message ?? "Could not convert booking");
    } finally {
      setBusy(false);
    }
  };

  if (allowed.length === 0 && !canConvert) return null;

  return (
    <>
      <div className="flex gap-2 items-center">
        {allowed.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" disabled={busy}>
                Change status <ChevronDown className="w-3.5 h-3.5 ml-1" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {allowed.map((s) => (
                <DropdownMenuItem key={s} onClick={() => doTransition(s)}>
                  {POSTOP_STATUS_LABEL[s]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {canConvert && (
          <Button size="sm" onClick={doConvert} disabled={busy}>
            <ArrowRightLeft className="w-3.5 h-3.5 mr-1" /> Convert to referral
          </Button>
        )}
      </div>

      <Dialog open={cancelling} onOpenChange={(o) => !busy && setCancelling(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel booking</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Reason</Label>
              <Select value={reason} onValueChange={(v) => setReason(v as PostopCancellationReason)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {POSTOP_CANCELLATION_REASONS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {POSTOP_CANCELLATION_LABEL[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Notes (optional)</Label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                maxLength={1000}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelling(false)} disabled={busy}>
              Back
            </Button>
            <Button
              variant="destructive"
              onClick={doCancel}
              disabled={busy}
            >
              Confirm cancellation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
