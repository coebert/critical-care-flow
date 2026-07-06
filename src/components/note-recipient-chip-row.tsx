import { ShieldAlert, ShieldCheck, ShieldOff } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DirectoryEntry } from "@/hooks/use-recipient-directory";

interface NoteRecipientChipRowProps {
  directory: DirectoryEntry[];
  selected: Set<string>;
  newlyEligibleIds: Set<string>;
  currentUserId: string | undefined;
  onToggle: (userId: string) => void;
}

/**
 * The compose-row chip strip: one pill per teammate showing whether they can
 * (and will) decrypt this note. Blocked → no published key; selected → will
 * receive; deselected → has a key but excluded. Newly enrolled teammates get
 * a highlight ring for a few seconds after enabling encryption.
 */
export function NoteRecipientChipRow({
  directory,
  selected,
  newlyEligibleIds,
  currentUserId,
  onToggle,
}: NoteRecipientChipRowProps) {
  const sorted = [...directory].sort((a, b) => {
    const na = newlyEligibleIds.has(a.user_id) ? 0 : 1;
    const nb = newlyEligibleIds.has(b.user_id) ? 0 : 1;
    if (na !== nb) return na - nb;
    const ka = a.public_key ? 0 : 1;
    const kb = b.public_key ? 0 : 1;
    if (ka !== kb) return ka - kb;
    return a.full_name.localeCompare(b.full_name);
  });

  return (
    <div className="flex flex-wrap gap-1.5 rounded-md border bg-muted/30 p-2">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground self-center mr-1">
        Recipient keys
      </span>
      {sorted.map((r) => {
        const isMe = r.user_id === currentUserId;
        const hasKey = !!r.public_key;
        const isSelected = selected.has(r.user_id);
        const isNew = newlyEligibleIds.has(r.user_id);
        const status: "selected" | "deselected" | "blocked" = !hasKey
          ? "blocked"
          : isSelected
            ? "selected"
            : "deselected";
        const styles = {
          selected:
            "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20",
          deselected:
            "border-border bg-background text-muted-foreground hover:bg-accent",
          blocked:
            "border-destructive/40 bg-destructive/10 text-destructive cursor-not-allowed",
        }[status];
        const Icon =
          status === "blocked" ? ShieldAlert : status === "selected" ? ShieldCheck : ShieldOff;
        const title =
          status === "blocked"
            ? `${r.full_name} — no published encryption key. Ask them to enable encryption on the noteboard.`
            : status === "selected"
              ? `${r.full_name} — will be able to decrypt this note.${isNew ? " Just enabled encryption." : ""}`
              : `${r.full_name} — has a key but is not a recipient of this note. Click to include.`;
        return (
          <button
            key={r.user_id}
            type="button"
            disabled={!hasKey}
            onClick={() => { if (hasKey) onToggle(r.user_id); }}
            title={title}
            className={cn(
              "relative inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors",
              styles,
              isNew && "ring-2 ring-sky-400 ring-offset-1 ring-offset-background",
            )}
          >
            <Icon className="w-3 h-3" />
            <span className="max-w-[9rem] truncate">
              {r.full_name}
              {isMe && <span className="ml-1 opacity-70">(you)</span>}
            </span>
            {isNew && (
              <span className="ml-1 rounded bg-sky-500/20 px-1 text-[9px] font-semibold uppercase tracking-wide text-sky-700 dark:text-sky-300">
                New
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
