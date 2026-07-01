// Server-only push notification sender.
import webpush from "web-push";

let configured = false;
function ensureConfigured() {
  if (configured) return;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || "mailto:admin@example.com";
  if (!publicKey || !privateKey) {
    throw new Error("VAPID keys are not configured");
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
}

export interface PushSub {
  endpoint: string;
  p256dh: string;
  auth: string;
  user_id?: string;
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

export interface PushSendResult {
  endpoint: string;
  user_id: string;
  ok: boolean;
  gone?: boolean;
  error?: string;
}

/**
 * Send a payload to many subscriptions. Returns endpoints that are no longer
 * valid (HTTP 404/410) so the caller can clean them up, and a per-endpoint
 * results list so the caller can persist a delivery audit trail.
 */
export async function sendPushToMany(
  subs: PushSub[],
  payload: PushPayload,
): Promise<{ goneEndpoints: string[]; results: PushSendResult[] }> {
  if (!subs.length) return { goneEndpoints: [], results: [] };
  try {
    ensureConfigured();
  } catch (e) {
    console.error("[push] not configured:", e);
    return {
      goneEndpoints: [],
      results: subs.map((s) => ({
        endpoint: s.endpoint,
        user_id: s.user_id ?? "",
        ok: false,
        error: "push_not_configured",
      })),
    };
  }

  const body = JSON.stringify(payload);
  const goneEndpoints: string[] = [];
  const results: PushSendResult[] = [];

  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          body,
          { TTL: 60 },
        );
        results.push({ endpoint: s.endpoint, user_id: s.user_id ?? "", ok: true });
      } catch (err: any) {
        const status = err?.statusCode;
        if (status === 404 || status === 410) {
          goneEndpoints.push(s.endpoint);
          results.push({
            endpoint: s.endpoint,
            user_id: s.user_id ?? "",
            ok: false,
            gone: true,
            error: `gone_${status}`,
          });
        } else {
          console.error("[push] send failed", status, err?.body || err?.message);
          results.push({
            endpoint: s.endpoint,
            user_id: s.user_id ?? "",
            ok: false,
            error: String(err?.body || err?.message || status || "unknown"),
          });
        }
      }
    }),
  );

  return { goneEndpoints, results };
}
