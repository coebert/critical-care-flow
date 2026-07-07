import { REFERRAL_OUTCOMES, type ReferralOutcome } from "@/lib/referral-outcome";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const NONE = "__none";

export function OutcomeSelector({
  value,
  onChange,
  disabled,
}: {
  value: ReferralOutcome | null;
  onChange: (v: ReferralOutcome | null) => void;
  disabled?: boolean;
}) {
  const desc = REFERRAL_OUTCOMES.find((o) => o.value === value)?.description;
  return (
    <div className="space-y-1.5">
      <Label>Decision / outcome</Label>
      <Select
        value={value ?? NONE}
        onValueChange={(v) => onChange(v === NONE ? null : (v as ReferralOutcome))}
        disabled={disabled}
      >
        <SelectTrigger><SelectValue placeholder="Not yet decided" /></SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>Not yet decided</SelectItem>
          {REFERRAL_OUTCOMES.map((o) => (
            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {desc && <p className="text-xs text-muted-foreground">{desc}</p>}
    </div>
  );
}
