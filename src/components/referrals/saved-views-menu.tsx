import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bookmark, Loader2, Star, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  listReferralSavedViews,
  upsertReferralSavedView,
  deleteReferralSavedView,
  type ReferralSavedView,
  type SavedViewParams,
} from "@/lib/referral-saved-views.functions";

const QK = ["referral-saved-views"] as const;

interface Props {
  /** Current filter values that would be persisted when saving a new view. */
  currentParams: SavedViewParams;
  /** Called when a saved view is chosen — parent restores filters from params. */
  onApply: (params: SavedViewParams) => void;
}

/**
 * Compact "Views" control for the referrals toolbar. Lists the signed-in
 * user's saved filter presets; lets them save the current filter combo under
 * a name, apply a preset with one click, or delete one. All mutations
 * invalidate the shared query so multiple mounted instances stay in sync.
 */
export function SavedViewsMenu({ currentParams, onApply }: Props) {
  const list = useServerFn(listReferralSavedViews);
  const upsert = useServerFn(upsertReferralSavedView);
  const remove = useServerFn(deleteReferralSavedView);
  const qc = useQueryClient();
  const [newName, setNewName] = useState("");
  const [open, setOpen] = useState(false);

  const { data: views = [], isLoading } = useQuery({
    queryKey: QK,
    queryFn: () => list(),
    staleTime: 30_000,
  });

  const saveMut = useMutation({
    mutationFn: (name: string) => upsert({ data: { name, params: currentParams } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QK });
      setNewName("");
      toast.success("View saved");
    },
    onError: (err: unknown) =>
      toast.error(err instanceof Error ? err.message : "Could not save view"),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => remove({ data: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: QK }),
    onError: (err: unknown) =>
      toast.error(err instanceof Error ? err.message : "Could not delete view"),
  });

  const trimmed = newName.trim();
  const canSave = trimmed.length > 0 && !saveMut.isPending;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="gap-1.5 shrink-0" aria-label="Saved views">
          <Bookmark className="w-4 h-4" aria-hidden="true" />
          <span>Views</span>
          {views.length > 0 && (
            <span className="text-[10px] tabular-nums text-muted-foreground">
              {views.length}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-3 space-y-3">
        <div>
          <div className="text-xs font-semibold text-muted-foreground mb-1.5">
            Save current filters
          </div>
          <form
            className="flex gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (canSave) saveMut.mutate(trimmed);
            }}
          >
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="View name…"
              maxLength={60}
              aria-label="Name for the saved view"
              className="h-8"
            />
            <Button type="submit" size="sm" disabled={!canSave} className="h-8">
              {saveMut.isPending ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
              ) : (
                "Save"
              )}
            </Button>
          </form>
          <p className="text-[11px] text-muted-foreground mt-1">
            Reusing an existing name overwrites it.
          </p>
        </div>

        <div>
          <div className="text-xs font-semibold text-muted-foreground mb-1.5">
            Your views
          </div>
          {isLoading ? (
            <div className="text-xs text-muted-foreground">Loading…</div>
          ) : views.length === 0 ? (
            <div className="text-xs text-muted-foreground">
              No saved views yet.
            </div>
          ) : (
            <ul className="space-y-1 max-h-56 overflow-y-auto">
              {views.map((v: ReferralSavedView) => (
                <li
                  key={v.id}
                  className="flex items-center gap-1 rounded hover:bg-accent/50"
                >
                  <button
                    type="button"
                    className="flex-1 min-w-0 flex items-center gap-2 px-2 py-1.5 text-left text-sm truncate focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                    onClick={() => {
                      onApply(v.params);
                      setOpen(false);
                    }}
                  >
                    <Star className="w-3.5 h-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="truncate">{v.name}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteMut.mutate(v.id)}
                    disabled={deleteMut.isPending}
                    aria-label={`Delete view ${v.name}`}
                    className="inline-flex items-center justify-center h-8 w-8 rounded text-muted-foreground hover:text-destructive hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
