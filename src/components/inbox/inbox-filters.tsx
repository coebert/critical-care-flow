import { Search, X } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import type { InboxSearch } from "@/lib/inbox-utils";

interface InboxFiltersProps {
  qInput: string;
  setQInput: (v: string) => void;
  search: InboxSearch;
  filteredCount: number;
  hasFilters: boolean;
  setSearch: (patch: Partial<InboxSearch>) => void;
  clearFilters: () => void;
}

export function InboxFilters({ qInput, setQInput, search, filteredCount, hasFilters, setSearch, clearFilters }: InboxFiltersProps) {
  return (
    <Card className="p-3 space-y-3">
      <div className="relative">
        <Search className="w-4 h-4 absolute left-2.5 top-2.5 text-muted-foreground" aria-hidden="true" />
        <Input
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
          placeholder="Search by message or referral ID…"
          className="pl-8 pr-8"
          aria-label="Search notifications"
        />
        {qInput && (
          <button
            type="button"
            onClick={() => setQInput("")}
            className="absolute right-2 top-2 text-muted-foreground hover:text-foreground"
            aria-label="Clear search"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
        <div>
          <Label className="text-xs">Type</Label>
          <Select value={search.kind} onValueChange={(v) => setSearch({ kind: v as InboxSearch["kind"] })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              <SelectItem value="new">New referral</SelectItem>
              <SelectItem value="status">Status change</SelectItem>
              <SelectItem value="note">New note</SelectItem>
              <SelectItem value="updated">Referral updated</SelectItem>
              <SelectItem value="warning">Warning</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label htmlFor="from" className="text-xs">From</Label>
          <Input id="from" type="date" value={search.from} onChange={(e) => setSearch({ from: e.target.value })} />
        </div>
        <div>
          <Label htmlFor="to" className="text-xs">To</Label>
          <Input id="to" type="date" value={search.to} onChange={(e) => setSearch({ to: e.target.value })} />
        </div>
        <div>
          <Label className="text-xs">Sort</Label>
          <Select value={search.sort} onValueChange={(v) => setSearch({ sort: v as "newest" | "oldest" })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">Newest first</SelectItem>
              <SelectItem value="oldest">Oldest first</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      {hasFilters && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{filteredCount} match{filteredCount === 1 ? "" : "es"}</span>
          <Button variant="ghost" size="sm" className="h-7" onClick={clearFilters}>
            <X className="w-3 h-3 mr-1" aria-hidden="true" /> Clear filters
          </Button>
        </div>
      )}
    </Card>
  );
}
