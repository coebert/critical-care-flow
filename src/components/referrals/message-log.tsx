import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { format, formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { Phone, Radio, Mail, MessageSquare, Users, Trash2, Plus, ArrowUpRight, ArrowDownLeft } from "lucide-react";
import { listMessages, logMessage, deleteMessage } from "@/lib/referral-messages.functions";
import { MESSAGE_CHANNELS, MESSAGE_CHANNEL_LABEL, type MessageChannel, type MessageDirection } from "@/lib/message-templates";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { TemplatePicker } from "./template-picker";
import { useRole } from "@/hooks/use-auth";

interface Message {
  id: string;
  referral_id: string;
  channel: MessageChannel;
  direction: MessageDirection;
  recipient: string | null;
  body: string;
  sent_at: string;
  template_id: string | null;
}

const CHANNEL_ICON: Record<MessageChannel, typeof Phone> = {
  phone: Phone,
  bleep: Radio,
  email: Mail,
  secure_msg: MessageSquare,
  in_person: Users,
};

export function MessageLog({ referralId }: { referralId: string }) {
  const [items, setItems] = useState<Message[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [channel, setChannel] = useState<MessageChannel>("phone");
  const [direction, setDirection] = useState<MessageDirection>("outbound");
  const [recipient, setRecipient] = useState("");
  const [body, setBody] = useState("");
  const { hasRole: isAdmin } = useRole("admin");

  const load = useServerFn(listMessages);
  const send = useServerFn(logMessage);
  const remove = useServerFn(deleteMessage);

  async function refresh() {
    try {
      const rows = await load({ data: { referral_id: referralId } });
      setItems(rows as Message[]);
    } finally {
      setLoaded(true);
    }
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [referralId]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setSaving(true);
    try {
      await send({
        data: {
          referral_id: referralId,
          channel,
          direction,
          recipient: recipient.trim() || null,
          body: body.trim(),
        },
      });
      setOpen(false);
      setBody(""); setRecipient(""); setChannel("phone"); setDirection("outbound");
      await refresh();
    } catch (err) {
      toast.error((err as Error)?.message ?? "Failed to log message");
    } finally {
      setSaving(false);
    }
  }

  async function onDelete(m: Message) {
    try {
      await remove({ data: { id: m.id } });
      await refresh();
    } catch (err) {
      toast.error((err as Error)?.message ?? "Delete failed");
    }
  }

  return (
    <Card className="p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Communication log</h2>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm" variant="outline">
              <Plus className="w-4 h-4 mr-1" aria-hidden="true" /> Log message
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Log a message</DialogTitle></DialogHeader>
            <form onSubmit={submit} className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-muted-foreground">Channel</label>
                  <Select value={channel} onValueChange={(v) => setChannel(v as MessageChannel)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {MESSAGE_CHANNELS.map((c) => (
                        <SelectItem key={c} value={c}>{MESSAGE_CHANNEL_LABEL[c]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">Direction</label>
                  <Select value={direction} onValueChange={(v) => setDirection(v as MessageDirection)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="outbound">Outbound (we sent)</SelectItem>
                      <SelectItem value="inbound">Inbound (we received)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Recipient / sender</label>
                <Input
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  placeholder="e.g. Dr Smith, bleep 1234"
                  maxLength={200}
                />
              </div>
              <div>
                <div className="flex justify-between items-center mb-1">
                  <label className="text-xs text-muted-foreground">Message body</label>
                  <TemplatePicker onInsert={(b) => setBody((prev) => prev ? `${prev}\n${b}` : b)} />
                </div>
                <Textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={5}
                  maxLength={4000}
                  placeholder="Summary of what was communicated"
                  required
                />
              </div>
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={saving || !body.trim()}>{saving ? "Saving…" : "Log message"}</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {!loaded && <div className="text-sm text-muted-foreground">Loading…</div>}
      {loaded && items.length === 0 && (
        <div className="text-sm text-muted-foreground">
          No communications logged yet. Use this to record calls, bleeps and messages to/from the referring team.
        </div>
      )}

      {items.length > 0 && (
        <ul className="space-y-3">
          {items.map((m) => {
            const Icon = CHANNEL_ICON[m.channel];
            const DirIcon = m.direction === "outbound" ? ArrowUpRight : ArrowDownLeft;
            return (
              <li key={m.id} className="border rounded-md p-3">
                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground mb-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="secondary" className="gap-1">
                      <Icon className="w-3 h-3" aria-hidden="true" /> {MESSAGE_CHANNEL_LABEL[m.channel]}
                    </Badge>
                    <Badge variant="outline" className="gap-1">
                      <DirIcon className="w-3 h-3" aria-hidden="true" /> {m.direction}
                    </Badge>
                    {m.recipient && <span>{m.direction === "outbound" ? "to " : "from "}{m.recipient}</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    <span title={format(new Date(m.sent_at), "d MMM yyyy HH:mm")}>
                      {formatDistanceToNow(new Date(m.sent_at), { addSuffix: true })}
                    </span>
                    {isAdmin && (
                      <Button variant="ghost" size="sm" onClick={() => onDelete(m)} aria-label="Delete message">
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
                <div className="text-sm whitespace-pre-wrap">{m.body}</div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
