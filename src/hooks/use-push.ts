import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { subscribePush, unsubscribePush } from "@/lib/shift.functions";
import { VAPID_PUBLIC_KEY } from "@/lib/push-config";

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; ++i) out[i] = raw.charCodeAt(i);
  return out;
}

function arrayBufferToBase64(buffer: ArrayBuffer | null): string {
  if (!buffer) return "";
  const bytes = new Uint8Array(buffer);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function isPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export function usePush() {
  const [permission, setPermission] = useState<NotificationPermission>("default");
  const [subscribed, setSubscribed] = useState(false);
  const subscribeFn = useServerFn(subscribePush);
  const unsubscribeFn = useServerFn(unsubscribePush);

  useEffect(() => {
    if (!isPushSupported()) return;
    setPermission(Notification.permission);
    navigator.serviceWorker.getRegistration("/sw-push.js").then(async (reg) => {
      if (!reg) return;
      const sub = await reg.pushManager.getSubscription();
      setSubscribed(!!sub);
    });
  }, []);

  // IMPORTANT: must be called SYNCHRONOUSLY from a user gesture (click/tap).
  // Safari and Firefox drop user activation across any prior `await`, so
  // calling Notification.requestPermission() after a network round-trip
  // silently no-ops without ever showing the browser prompt.
  const requestPermission = useCallback((): Promise<NotificationPermission> => {
    if (!isPushSupported()) {
      return Promise.reject(
        new Error("Push notifications are not supported on this device."),
      );
    }
    const current = Notification.permission;
    if (current !== "default") return Promise.resolve(current);
    // Call synchronously — do NOT await anything before this line in callers.
    let p: Promise<NotificationPermission>;
    try {
      // Safari historically only supported the callback form; modern Safari
      // returns a Promise. Cover both by wrapping.
      const maybe = Notification.requestPermission((result) => {
        setPermission(result);
      });
      p = maybe instanceof Promise ? maybe : new Promise((resolve) => {
        // Fallback: poll once on next tick (legacy callback path).
        setTimeout(() => resolve(Notification.permission), 0);
      });
    } catch (e) {
      return Promise.reject(e);
    }
    return p.then((perm) => {
      setPermission(perm);
      return perm;
    });
  }, []);

  const enable = useCallback(async () => {
    if (!isPushSupported()) {
      throw new Error("Push notifications are not supported on this device.");
    }
    // If permission isn't yet granted, request it. Callers that need to
    // preserve user-activation for Safari/Firefox should call
    // requestPermission() synchronously themselves first.
    let perm = Notification.permission;
    if (perm === "default") {
      perm = await requestPermission();
    }
    setPermission(perm);
    if (perm !== "granted") {
      throw new Error("Notification permission was not granted.");
    }
    const reg =
      (await navigator.serviceWorker.getRegistration("/sw-push.js")) ||
      (await navigator.serviceWorker.register("/sw-push.js"));
    await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as BufferSource,
      });
    }
    const json = sub.toJSON();
    await subscribeFn({
      data: {
        endpoint: sub.endpoint,
        p256dh: json.keys?.p256dh ?? arrayBufferToBase64(sub.getKey("p256dh")),
        auth: json.keys?.auth ?? arrayBufferToBase64(sub.getKey("auth")),
        user_agent: navigator.userAgent.slice(0, 500),
      },
    });
    setSubscribed(true);
  }, [subscribeFn, requestPermission]);

  const disable = useCallback(async () => {
    if (!isPushSupported()) return;
    const reg = await navigator.serviceWorker.getRegistration("/sw-push.js");
    if (!reg) return;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      const endpoint = sub.endpoint;
      await sub.unsubscribe();
      try {
        await unsubscribeFn({ data: { endpoint } });
      } catch (_) {
        // ignore
      }
    }
    setSubscribed(false);
  }, [unsubscribeFn]);

  return { permission, subscribed, enable, disable, requestPermission, supported: isPushSupported() };
}
