import { Lock, LockOpen } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { NoteFilter, NoteFilterCounts } from "@/lib/note-filter";

interface NoteboardHeaderProps {
  isUnlocked: boolean;
  needsBootstrap: boolean;
  filter: NoteFilter;
  onFilterChange: (next: NoteFilter) => void;
  counts: NoteFilterCounts;
  onUnlockRequest: () => void;
}

/**
 * Noteboard card header: title with E2E lock badge, filter select, and the
 * unlock/enable-encryption CTA when the tab is still locked.
 */
export function NoteboardHeader({
  isUnlocked,
  needsBootstrap,
  filter,
  onFilterChange,
  counts,
  onUnlockRequest,
}: NoteboardHeaderProps) {
  return (
    <>
      <div className="flex items-center justify-between gap-2 mb-1 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="font-semibold flex items-center gap-2">
            Noteboard
            {isUnlocked ? (
              <Badge variant="outline" className="text-[10px] gap-1">
                <LockOpen className="w-3 h-3" aria-hidden="true" /> E2E unlocked
              </Badge>
            ) : (
              <Badge variant="outline" className="text-[10px] gap-1">
                <Lock className="w-3 h-3" aria-hidden="true" /> E2E locked
              </Badge>
            )}
          </h2>
          <Select value={filter} onValueChange={(v) => onFilterChange(v as NoteFilter)}>
            <SelectTrigger className="h-7 text-xs w-auto min-w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All notes ({counts.all})</SelectItem>
              <SelectItem value="e2e">E2E encrypted ({counts.e2e})</SelectItem>
              <SelectItem value="legacy">Legacy plaintext ({counts.legacy})</SelectItem>
              <SelectItem value="failed">Failed to decrypt ({counts.failed})</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {!isUnlocked && (
          <Button size="sm" variant="outline" onClick={onUnlockRequest}>
            {needsBootstrap ? "Enable encryption" : "Unlock notes"}
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        Messages are end-to-end encrypted in your browser — the server only stores ciphertext.
      </p>
    </>
  );
}
