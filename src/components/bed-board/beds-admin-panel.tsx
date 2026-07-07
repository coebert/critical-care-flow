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

export function BedsAdminPanel() {
  const load = useServerFn(listAllBeds);
  const doCreate = useServerFn(createBed);
  const doUpdate = useServerFn(updateBed);

  const [rows, setRows] = useState<Bed[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

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
            <table className="w-full text-sm min-w-[640px]">
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
                {rows.map((b) => (
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
                    <td className="text-right space-x-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => patchBed(b.id, { is_side_room: !b.is_side_room })}
                      >
                        Toggle side room
                      </Button>
                      {b.active ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => patchBed(b.id, { active: false })}
                        >
                          Retire
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => patchBed(b.id, { active: true })}
                        >
                          Reactivate
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-muted-foreground mt-3">
          Retiring a bed hides it from the live board and capacity numbers. Existing
          occupancy history is preserved.
        </p>
      </Card>
    </div>
  );
}
