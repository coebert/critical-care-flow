import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { listAllBeds, createBed, updateBed } from "@/lib/beds.functions";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import type { Database } from "@/integrations/supabase/types";

type Bed = Database["public"]["Tables"]["beds"]["Row"];
type Unit = Database["public"]["Enums"]["bed_unit"];

interface EditDraft {
  code: string;
  unit: Unit;
  is_side_room: boolean;
  sort_order: string;
  active: boolean;
}

export function BedsAdminPanel() {
  const load = useServerFn(listAllBeds);
  const doCreate = useServerFn(createBed);
  const doUpdate = useServerFn(updateBed);

  const [rows, setRows] = useState<Bed[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // Inline edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const [saving, setSaving] = useState(false);

  // New bed form
  const [code, setCode] = useState("");
  const [unit, setUnit] = useState<Unit>("icu");
  const [isSideRoom, setIsSideRoom] = useState(false);
  const [sortOrder, setSortOrder] = useState<string>("100");

  const refresh = async () => {
    setLoading(true);
    try {
      const data = await load();
      setRows(data as Bed[]);
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to load beds");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submitNew = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    setBusy(true);
    try {
      await doCreate({
        data: {
          code: code.trim(),
          unit,
          is_side_room: isSideRoom,
          sort_order: Number(sortOrder) || 100,
        },
      });
      toast.success("Bed added");
      setCode("");
      setIsSideRoom(false);
      await refresh();
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to add bed");
    } finally {
      setBusy(false);
    }
  };

  const patchBed = async (id: string, patch: Partial<Bed>) => {
    try {
      await doUpdate({ data: { id, ...patch } });
      await refresh();
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to update bed");
    }
  };

  const startEdit = (b: Bed) => {
    setEditingId(b.id);
    setDraft({
      code: b.code,
      unit: b.unit as Unit,
      is_side_room: b.is_side_room,
      sort_order: String(b.sort_order),
      active: b.active,
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraft(null);
  };

  const saveEdit = async () => {
    if (!editingId || !draft) return;
    const code = draft.code.trim();
    if (!code) {
      toast.error("Code is required");
      return;
    }
    const sort = Number(draft.sort_order);
    if (!Number.isFinite(sort) || sort < 0 || sort > 9999) {
      toast.error("Sort order must be between 0 and 9999");
      return;
    }
    setSaving(true);
    try {
      await doUpdate({
        data: {
          id: editingId,
          code,
          unit: draft.unit,
          is_side_room: draft.is_side_room,
          sort_order: sort,
          active: draft.active,
        },
      });
      toast.success("Bed updated");
      cancelEdit();
      await refresh();
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to update bed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card className="p-5">
        <h2 className="font-semibold mb-1">Add a bed</h2>
        <p className="text-sm text-muted-foreground mb-4">
          New beds appear on the live bed board immediately.
        </p>
        <form onSubmit={submitNew} className="grid md:grid-cols-5 gap-3 items-end">
          <div className="space-y-1.5">
            <Label>Code</Label>
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="e.g. ICU 5"
              maxLength={20}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label>Unit</Label>
            <Select value={unit} onValueChange={(v) => setUnit(v as Unit)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="icu">ICU</SelectItem>
                <SelectItem value="hdu">HDU</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2 h-9">
            <Switch checked={isSideRoom} onCheckedChange={setIsSideRoom} id="side-room" />
            <Label htmlFor="side-room" className="cursor-pointer">Side room</Label>
          </div>
          <div className="space-y-1.5">
            <Label>Sort order</Label>
            <Input
              type="number"
              min={0}
              max={9999}
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value)}
            />
          </div>
          <div className="flex justify-end">
            <Button type="submit" disabled={busy}>{busy ? "Adding…" : "Add bed"}</Button>
          </div>
        </form>
      </Card>

      <Card className="p-5">
        <h2 className="font-semibold mb-3">Bed register</h2>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No beds yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[720px]">
              <thead className="text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="text-left py-2">Code</th>
                  <th className="text-left">Unit</th>
                  <th className="text-left">Side room</th>
                  <th className="text-left">Sort order</th>
                  <th className="text-left">Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((b) => {
                  const isEditing = editingId === b.id;
                  if (isEditing && draft) {
                    return (
                      <tr key={b.id} className="border-t bg-muted/30">
                        <td className="py-2 pr-2">
                          <Input
                            value={draft.code}
                            onChange={(e) => setDraft({ ...draft, code: e.target.value })}
                            maxLength={20}
                            className="h-8"
                          />
                        </td>
                        <td className="pr-2">
                          <Select
                            value={draft.unit}
                            onValueChange={(v) => setDraft({ ...draft, unit: v as Unit })}
                          >
                            <SelectTrigger className="h-8 w-[90px]"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="icu">ICU</SelectItem>
                              <SelectItem value="hdu">HDU</SelectItem>
                            </SelectContent>
                          </Select>
                        </td>
                        <td className="pr-2">
                          <Switch
                            checked={draft.is_side_room}
                            onCheckedChange={(v) => setDraft({ ...draft, is_side_room: v })}
                          />
                        </td>
                        <td className="pr-2">
                          <Input
                            type="number"
                            min={0}
                            max={9999}
                            value={draft.sort_order}
                            onChange={(e) => setDraft({ ...draft, sort_order: e.target.value })}
                            className="h-8 w-24"
                          />
                        </td>
                        <td className="pr-2">
                          <div className="flex items-center gap-2">
                            <Switch
                              checked={draft.active}
                              onCheckedChange={(v) => setDraft({ ...draft, active: v })}
                              id={`active-${b.id}`}
                            />
                            <Label htmlFor={`active-${b.id}`} className="cursor-pointer text-xs">
                              {draft.active ? "Active" : "Retired"}
                            </Label>
                          </div>
                        </td>
                        <td className="text-right space-x-2 whitespace-nowrap">
                          <Button size="sm" onClick={saveEdit} disabled={saving}>
                            {saving ? "Saving…" : "Save"}
                          </Button>
                          <Button size="sm" variant="outline" onClick={cancelEdit} disabled={saving}>
                            Cancel
                          </Button>
                        </td>
                      </tr>
                    );
                  }
                  return (
                    <tr key={b.id} className="border-t">
                      <td className="py-2 font-medium">{b.code}</td>
                      <td className="uppercase text-xs">{b.unit}</td>
                      <td>{b.is_side_room ? "Yes" : "No"}</td>
                      <td className="tabular-nums">{b.sort_order}</td>
                      <td>
                        {b.active ? (
                          <Badge variant="outline">Active</Badge>
                        ) : (
                          <Badge variant="outline" className="text-muted-foreground">Retired</Badge>
                        )}
                      </td>
                      <td className="text-right space-x-2 whitespace-nowrap">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => startEdit(b)}
                          disabled={editingId !== null}
                        >
                          Edit
                        </Button>
                        {b.active ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => patchBed(b.id, { active: false })}
                            disabled={editingId !== null}
                          >
                            Retire
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => patchBed(b.id, { active: true })}
                            disabled={editingId !== null}
                          >
                            Reactivate
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-muted-foreground mt-3">
          Edit a bed to change its code, unit, side-room flag, sort order, or status without
          retiring it. Retiring a bed hides it from the live board and capacity numbers;
          occupancy history is preserved.
        </p>
      </Card>
    </div>
  );
}
