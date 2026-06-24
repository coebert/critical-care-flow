import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { sendTestPushNotification } from "@/lib/push.functions";
import { BellRing } from "lucide-react";
import { toast } from "sonner";

export function TestPushButton() {
  const [sending, setSending] = useState(false);
  const sendTest = useServerFn(sendTestPushNotification);

  const handleClick = async () => {
    setSending(true);
    try {
      const result = await sendTest();
      if (result.ok) {
        toast.success(`Test push sent (${result.sent} device${result.sent === 1 ? "" : "s"}).`);
      } else {
        toast.warning(result.error ?? "Could not send test push.");
      }
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to send test push notification.");
    } finally {
      setSending(false);
    }
  };

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleClick}
      disabled={sending}
      aria-label="Send test push notification"
    >
      <BellRing className="w-4 h-4 mr-1" />
      {sending ? "Sending…" : "Test push"}
    </Button>
  );
}
