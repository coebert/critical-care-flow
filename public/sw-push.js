// Service worker for web push notifications only.
// Kept minimal — no offline caching.

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = { title: "SDH Critical Care", body: "New activity", url: "/" };
  try {
    if (event.data) {
      const data = event.data.json();
      payload = { ...payload, ...data };
    }
  } catch (_) {
    if (event.data) payload.body = event.data.text();
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
  // Resolve to an absolute, same-origin URL — clients.navigate() requires it.
  const targetUrl = new URL(rawUrl, self.location.origin).href;
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
