import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { signOffBooking } from "@/lib/postop-bookings.functions";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";
import { format, parseISO } from "date-fns";
import { CheckCircle2 } from "lucide-react";

export function PreopSignoffPanel({
  bookingId,
  preopAt,
  intensivistAt,
  onChanged,
}: {
  bookingId: string;
  preopAt: string | null;
  intensivistAt: string | null;
  onChanged?: () => void;
}) {
  const signOff = useServerFn(signOffBooking);
  const [busy, setBusy] = useState<"preop" | "intensivist" | null>(null);

  const toggle = async (kind: "preop" | "intensivist", clear: boolean) => {
    try {
      setBusy(kind);
      await signOff({ data: { id: bookingId, kind, clear } });
      toast.success(clear ? "Sign-off cleared" : "Sign-off recorded");
      onChanged?.();
    } catch (e: any) {
      toast.error(e?.message ?? "Failed");
    } finally {
      setBusy(null);
    }
  };

  const Row = ({
    label,
    at,
    kind,
  }: {
    label: string;
    at: string | null;
    kind: "preop" | "intensivist";
  }) => (
    <div className="flex items-center justify-between gap-3 py-2">
      <div>
        <div className="font-medium text-sm">{label}</div>
        <div className="text-xs text-muted-foreground">
          {at ? (
            <span className="inline-flex items-center gap-1">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
              Signed {format(parseISO(at), "dd/MM/yyyy HH:mm")}
            </span>
          ) : (
            "Not yet signed"
          )}
        </div>
      </div>
      <Button
        size="sm"
        variant={at ? "outline" : "default"}
        disabled={busy === kind}
        onClick={() => toggle(kind, !!at)}
      >
        {at ? "Clear" : "Sign off"}
      </Button>
    </div>
  );

  return (
    <Card className="p-4">
      <div className="font-medium mb-1">Pre-op sign-off</div>
      <p className="text-xs text-muted-foreground mb-2">
        Both required before a booking can be confirmed.
      </p>
      <Row label="Anaesthetic pre-op sign-off" at={preopAt} kind="preop" />
      <div className="border-t" />
      <Row label="Consultant intensivist review" at={intensivistAt} kind="intensivist" />
    </Card>
  );
}
