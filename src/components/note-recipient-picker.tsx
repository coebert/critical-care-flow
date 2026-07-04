import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Users, ShieldAlert, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";

export type RecipientEntry = {
  user_id: string;
  full_name: string;
  public_key: string | null;
};

/**
 * Recipient picker for encrypted notes. Only clinicians with a published
 * public key can be selected — everyone else is shown greyed out so the
 * author can see who's missing and chase them.
 */
export function NoteRecipientPicker({
  directory,
  selected,
  onChange,
  currentUserId,
  compact,
}: {
  directory: RecipientEntry[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  currentUserId?: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? directory.filter((r) => r.full_name.toLowerCase().includes(q))
      : directory;
    // Sort: enrolled + selectable first, then missing keys.
    return [...list].sort((a, b) => {
      const ka = a.public_key ? 0 : 1;
      const kb = b.public_key ? 0 : 1;
      if (ka !== kb) return ka - kb;
      return a.full_name.localeCompare(b.full_name);
    });
  }, [directory, query]);

  const selectableIds = directory.filter((r) => !!r.public_key).map((r) => r.user_id);
  const selectedCount = selectableIds.filter((id) => selected.has(id)).length;
  const allSelected = selectableIds.length > 0 && selectedCount === selectableIds.length;

  const toggle = (id: string, canSelect: boolean) => {
    if (!canSelect) return;
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };

  const setAll = (on: boolean) => {
    onChange(on ? new Set(selectableIds) : new Set());
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size={compact ? "sm" : "default"} className="gap-2">
          <Users className="w-4 h-4" />
          {compact ? (
            <span className="text-xs">Recipients ({selectedCount})</span>
          ) : (
            <>
              Recipients
              <Badge variant="secondary" className="ml-1">
                {selectedCount}/{selectableIds.length}
              </Badge>
            </>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="end">
        <div className="p-3 border-b space-y-2">
          <div className="text-sm font-medium">Note recipients</div>
          <div className="text-xs text-muted-foreground">
            Only these clinicians will be able to decrypt this note.
          </div>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search teammates…"
            className="h-8 text-sm"
          />
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => setAll(!allSelected)}
              className="text-xs text-primary hover:underline"
            >
              {allSelected ? "Deselect all" : "Select all enrolled"}
            </button>
            <span className="text-[11px] text-muted-foreground">
              {selectedCount} of {selectableIds.length} enrolled selected
            </span>
          </div>
        </div>
        <div className="max-h-72 overflow-auto py-1">
          {filtered.length === 0 && (
            <div className="px-3 py-4 text-xs text-muted-foreground">No teammates match.</div>
          )}
          {filtered.map((r) => {
            const canSelect = !!r.public_key;
            const checked = selected.has(r.user_id);
            const isMe = r.user_id === currentUserId;
            return (
              <label
                key={r.user_id}
                className={cn(
                  "flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-accent",
                  !canSelect && "cursor-not-allowed opacity-60",
                )}
              >
                <Checkbox
                  checked={checked}
                  disabled={!canSelect}
                  onCheckedChange={() => toggle(r.user_id, canSelect)}
                />
                <span className="flex-1 truncate">
                  {r.full_name}
                  {isMe && <span className="ml-1 text-xs text-muted-foreground">(you)</span>}
                </span>
                {canSelect ? (
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" aria-label="Enrolled" />
                ) : (
                  <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                    <ShieldAlert className="w-3 h-3" /> no key
                  </span>
                )}
              </label>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
