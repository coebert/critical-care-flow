import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Trash2, Pencil, Plus } from "lucide-react";
import { listTemplates, upsertTemplate, deleteTemplate } from "@/lib/message-templates.functions";
import {
  TEMPLATE_CATEGORIES,
  TEMPLATE_CATEGORY_LABEL,
  type TemplateCategory,
} from "@/lib/message-templates";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

interface Template {
  id: string;
  title: string;
  category: TemplateCategory;
  body: string;
  active: boolean;
}

export function MessageTemplatesPanel() {
  const [items, setItems] = useState<Template[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState<Template | null>(null);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<TemplateCategory>("advice");
  const [body, setBody] = useState("");
  const [active, setActive] = useState(true);
  const [saving, setSaving] = useState(false);

  const list = useServerFn(listTemplates);
  const upsert = useServerFn(upsertTemplate);
  const remove = useServerFn(deleteTemplate);

  async function refresh() {
    try {
      const rows = await list({ data: { include_inactive: true } });
      setItems(rows as Template[]);
    } finally { setLoaded(true); }
  }
  useEffect(() => { refresh(); }, []);

  function startNew() {
    setEditing(null);
    setTitle(""); setCategory("advice"); setBody(""); setActive(true);
    setOpen(true);
  }
  function startEdit(t: Template) {
    setEditing(t);
    setTitle(t.title); setCategory(t.category); setBody(t.body); setActive(t.active);
    setOpen(true);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await upsert({ data: { id: editing?.id, title: title.trim(), category, body: body.trim(), active } });
      toast.success("Template saved");
      setOpen(false);
      await refresh();
    } catch (err) {
      toast.error((err as Error)?.message ?? "Save failed");
    } finally { setSaving(false); }
  }

  async function onDelete(t: Template) {
    if (!confirm(`Delete template "${t.title}"?`)) return;
    try {
      await remove({ data: { id: t.id } });
      await refresh();
    } catch (err) {
      toast.error((err as Error)?.message ?? "Delete failed");
    }
  }

  return (
    <Card className="p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Message templates</h2>
          <p className="text-xs text-muted-foreground">Reusable snippets for decline advice, plans and handovers.</p>
        </div>
        <Button size="sm" onClick={startNew}><Plus className="w-4 h-4 mr-1" aria-hidden="true" /> New template</Button>
      </div>

      {!loaded && <div className="text-sm text-muted-foreground">Loading…</div>}
      {loaded && items.length === 0 && <div className="text-sm text-muted-foreground">No templates yet.</div>}
      {items.length > 0 && (
        <ul className="divide-y">
          {items.map((t) => (
            <li key={t.id} className="py-3 flex items-start gap-3">
              <Badge variant="secondary">{TEMPLATE_CATEGORY_LABEL[t.category]}</Badge>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium flex gap-2 items-center">
                  {t.title}
                  {!t.active && <span className="text-xs text-muted-foreground">(inactive)</span>}
                </div>
                <div className="text-xs text-muted-foreground line-clamp-2 whitespace-pre-wrap">{t.body}</div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => startEdit(t)} aria-label="Edit"><Pencil className="w-4 h-4" /></Button>
              <Button variant="ghost" size="sm" onClick={() => onDelete(t)} aria-label="Delete"><Trash2 className="w-4 h-4" /></Button>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit template" : "New template"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={save} className="space-y-3">
            <div>
              <label className="text-xs text-muted-foreground">Title</label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={120} />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Category</label>
              <Select value={category} onValueChange={(v) => setCategory(v as TemplateCategory)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TEMPLATE_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>{TEMPLATE_CATEGORY_LABEL[c]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Body</label>
              <Textarea rows={6} value={body} onChange={(e) => setBody(e.target.value)} required maxLength={4000} />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
              Active (available for insertion)
            </label>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={saving || !title.trim() || !body.trim()}>{saving ? "Saving…" : "Save"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
