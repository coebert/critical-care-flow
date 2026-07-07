import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { listTemplates } from "@/lib/message-templates.functions";
import { TEMPLATE_CATEGORY_LABEL, type TemplateCategory } from "@/lib/message-templates";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FileText } from "lucide-react";

interface Template {
  id: string;
  title: string;
  category: TemplateCategory;
  body: string;
}

interface Props {
  onInsert: (body: string, template: Template) => void;
  category?: TemplateCategory;
  label?: string;
}

export function TemplatePicker({ onInsert, category, label = "Insert template" }: Props) {
  const [items, setItems] = useState<Template[]>([]);
  const [loaded, setLoaded] = useState(false);
  const load = useServerFn(listTemplates);

  useEffect(() => {
    let cancelled = false;
    load({ data: category ? { category } : {} }).then((rows) => {
      if (!cancelled) {
        setItems((rows ?? []) as Template[]);
        setLoaded(true);
      }
    }).catch(() => setLoaded(true));
    return () => { cancelled = true; };
  }, [load, category]);

  const grouped = items.reduce<Record<TemplateCategory, Template[]>>((acc, t) => {
    (acc[t.category] ||= []).push(t);
    return acc;
  }, { decline: [], advice: [], plan: [], handover: [] });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <FileText className="w-4 h-4 mr-1" aria-hidden="true" />{label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72 max-h-80 overflow-y-auto">
        {!loaded && <DropdownMenuItem disabled>Loading…</DropdownMenuItem>}
        {loaded && items.length === 0 && <DropdownMenuItem disabled>No templates yet</DropdownMenuItem>}
        {(Object.keys(grouped) as TemplateCategory[]).map((cat) =>
          grouped[cat].length ? (
            <div key={cat}>
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                {TEMPLATE_CATEGORY_LABEL[cat]}
              </DropdownMenuLabel>
              {grouped[cat].map((t) => (
                <DropdownMenuItem
                  key={t.id}
                  onSelect={(e) => { e.preventDefault(); onInsert(t.body, t); }}
                >
                  <span className="truncate">{t.title}</span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
            </div>
          ) : null,
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
