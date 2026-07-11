// Service worker for web push notifications only.
// Kept minimal — no offline caching.
//
// Batch B / P2 #12 hardening:
//   - Validate the push payload shape before showing a notification (drop
//     non-string title/body/url/tag; never render attacker-controlled objects).
//   - Restrict deep-link URLs to same-origin paths from an allow-list of
//     path prefixes; anything else falls back to "/". This blocks a
//     compromised sender from steering users to an external phishing page
//     via the notification click.
//   - Never postMessage the decrypted payload to page clients.

const ALLOWED_PATH_PREFIXES = [
  "/",
  "/inbox",
  "/referrals",
  "/notifications",
  "/bed-board",
  "/board",
  "/analytics",
  "/profile",
  "/postop-bookings",
  "/bridge-status",
  "/admin",
  "/permissions",
];

function sanitizeString(v, max = 200) {
  return typeof v === "string" ? v.slice(0, max) : "";
}

function safeSameOriginPath(rawUrl) {
  try {
    const u = new URL(rawUrl, self.location.origin);
    if (u.origin !== self.location.origin) return "/";
    const path = u.pathname || "/";
    const ok = ALLOWED_PATH_PREFIXES.some(
      (p) => path === p || path.startsWith(p === "/" ? "/" : p + "/") || path.startsWith(p),
    );
    return ok ? u.pathname + u.search : "/";
  } catch (_) {
    return "/";
  }
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  const defaults = { title: "Radnor Critical Care", body: "New activity", url: "/", tag: undefined };
  let payload = { ...defaults };
  try {
    if (event.data) {
      const raw = event.data.json();
      if (raw && typeof raw === "object") {
        payload.title = sanitizeString(raw.title) || defaults.title;
        payload.body = sanitizeString(raw.body, 500) || defaults.body;
        payload.url = safeSameOriginPath(sanitizeString(raw.url) || "/");
        payload.tag = sanitizeString(raw.tag, 100) || undefined;
      }
    }
  } catch (_) {
    if (event.data) {
      const text = event.data.text();
      payload.body = sanitizeString(text, 500) || defaults.body;
    }
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/favicon.ico",
      badge: "/favicon.ico",
      tag: payload.tag,
      data: { url: payload.url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const rawUrl = (event.notification.data && event.notification.data.url) || "/";
  const safePath = safeSameOriginPath(rawUrl);
  const targetUrl = new URL(safePath, self.location.origin).href;
  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      // Prefer a tab already on the target URL.
      for (const client of allClients) {
        if (client.url === targetUrl && "focus" in client) {
          await client.focus();
          return;
        }
      }
      // Otherwise, focus any existing same-origin tab and navigate it.
      for (const client of allClients) {
        try {
          const clientOrigin = new URL(client.url).origin;
          if (clientOrigin === self.location.origin && "focus" in client) {
            await client.focus();
            if ("navigate" in client) {
              try {
                await client.navigate(targetUrl);
              } catch (_) {
                // Fallback: some browsers reject navigate on cross-document
                // clients. Open a new window with the deep link instead.
                await self.clients.openWindow(targetUrl);
              }
            }
            return;
          }
        } catch (_) {
          // Ignore clients with opaque URLs.
        }
      }
      await self.clients.openWindow(targetUrl);
    })(),
  );
});
