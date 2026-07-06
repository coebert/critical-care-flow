import { Link } from "@tanstack/react-router";
import { format } from "date-fns";
import { AlertCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type PriorReferral = {
  id: string;
  hospital_number: string | null;
  referral_received_at: string;
  status: string;
  referring_specialty: string | null;
  current_ward: string | null;
  current_bed: string | null;
  reason_for_referral: string | null;
  past_medical_history: string | null;
  baseline_function: string | null;
  age: number | null;
  sex: string | null;
  consultant_to_consultant_only: boolean | null;
};

interface PriorReferralsAlertProps {
  hospitalNumber: string;
  priors: PriorReferral[];
  priorC2C: boolean;
  showAlert: boolean;
  priorWithHistory: PriorReferral | undefined;
  onOpenDialog: () => void;
  onAutofillPMH: () => void;
  onDismiss: () => void;
}

export function PriorReferralsAlert({
  hospitalNumber,
  priors,
  priorC2C,
  showAlert,
  priorWithHistory,
  onOpenDialog,
  onAutofillPMH,
  onDismiss,
}: PriorReferralsAlertProps) {
  return (
    <>
      {showAlert && (
        <Alert variant="destructive" className="mt-2">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          <AlertTitle>
            Previous referral{priors.length > 1 ? "s" : ""} on record
          </AlertTitle>
          <AlertDescription className="flex flex-col gap-2">
            <span>
              This patient (hospital number <strong>{hospitalNumber}</strong>) has been
              referred to critical care {priors.length} time{priors.length > 1 ? "s" : ""} before.
            </span>
            <div className="flex gap-2 flex-wrap">
              <Button type="button" size="sm" variant="outline" onClick={onOpenDialog}>
                View previous referrals for this patient
              </Button>
              {priorWithHistory && (
                <Button type="button" size="sm" variant="outline" onClick={onAutofillPMH}>
                  Auto-fill past medical history
                </Button>
              )}
              <Button type="button" size="sm" variant="ghost" onClick={onDismiss}>
                Dismiss
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}
      {priorC2C && (
        <Alert variant="destructive" className="mt-2">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          <AlertTitle>Consultant-to-consultant referral only</AlertTitle>
          <AlertDescription>
            A previous referral for this patient (hospital number{" "}
            <strong>{hospitalNumber}</strong>) was flagged as{" "}
            <strong>consultant-to-consultant only</strong>. This referral must be made
            consultant-to-consultant. The flag has been applied automatically below.
          </AlertDescription>
        </Alert>
      )}
    </>
  );
}

interface PriorReferralsDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  hospitalNumber: string;
  priors: PriorReferral[];
}

export function PriorReferralsDialog({ open, onOpenChange, hospitalNumber, priors }: PriorReferralsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            Previous referrals for {hospitalNumber || "this patient"}
          </DialogTitle>
          <DialogDescription>
            Click any referral to open the full form in a new tab.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto space-y-2">
          {priors.length === 0 && (
            <p className="text-sm text-muted-foreground py-6 text-center">
              No previous referrals.
            </p>
          )}
          {priors.map((p) => (
            <Link
              key={p.id}
              to="/referrals/$id"
              params={{ id: p.id }}
              target="_blank"
              rel="noopener noreferrer"
              className="block border rounded-md p-3 hover:bg-accent/40 transition-colors"
            >
              <div className="flex items-center justify-between gap-2 mb-1">
                <div className="text-sm font-medium">
                  {format(new Date(p.referral_received_at), "dd/MM/yyyy HH:mm")}
                </div>
                <Badge variant="outline" className="capitalize">{p.status}</Badge>
              </div>
              <div className="text-xs text-muted-foreground">
                {p.referring_specialty ?? "Specialty unknown"}
                {p.current_ward ? ` · ${p.current_ward}` : ""}
                {p.current_bed ? ` ${p.current_bed}` : ""}
              </div>
              {p.reason_for_referral && (
                <div className="text-sm mt-1 line-clamp-2">{p.reason_for_referral}</div>
              )}
            </Link>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
