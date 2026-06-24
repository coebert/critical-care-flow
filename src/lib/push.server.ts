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
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

/**
 * Send a payload to many subscriptions. Returns endpoints that are no longer
 * valid (HTTP 404/410) so the caller can clean them up.
 */
export async function sendPushToMany(
  subs: PushSub[],
  payload: PushPayload,
): Promise<{ goneEndpoints: string[] }> {
  if (!subs.length) return { goneEndpoints: [] };
  try {
    ensureConfigured();
  } catch (e) {
    console.error("[push] not configured:", e);
    return { goneEndpoints: [] };
  }

  const body = JSON.stringify(payload);
  const goneEndpoints: string[] = [];

  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          body,
          { TTL: 60 },
        );
      } catch (err: any) {
        const status = err?.statusCode;
        if (status === 404 || status === 410) {
          goneEndpoints.push(s.endpoint);
        } else {
          console.error("[push] send failed", status, err?.body || err?.message);
        }
      }
    }),
  );

  return { goneEndpoints };
}
