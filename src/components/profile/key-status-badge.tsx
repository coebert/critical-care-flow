import { Loader2, Lock, ShieldAlert, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { KeyStatus } from "@/hooks/use-e2e-session";

export function KeyStatusBadge({ status }: { status: KeyStatus }) {
  if (status === "ready") {
    return (
      <Badge className="bg-success text-success-foreground gap-1">
        <ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" /> Ready
      </Badge>
    );
  }
  if (status === "locked") {
    return (
      <Badge variant="secondary" className="gap-1">
        <Lock className="w-3.5 h-3.5" aria-hidden="true" /> Locked
      </Badge>
    );
  }
  if (status === "not_issued") {
    return (
      <Badge variant="destructive" className="gap-1">
        <ShieldAlert className="w-3.5 h-3.5" aria-hidden="true" /> Not issued
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1">
      <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> Checking
    </Badge>
  );
}

export function shortFingerprint(publicKeyB64: string): string {
  // Purely presentational: a stable short hash-ish view of the key so users
  // can eyeball match with a teammate's device without exposing the full key.
  const s = publicKeyB64.replace(/[^A-Za-z0-9]/g, "");
  if (s.length <= 16) return s;
  return `${s.slice(0, 8)}…${s.slice(-8)}`;
}
