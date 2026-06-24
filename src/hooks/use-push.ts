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

export function getPushPermissionContextError(): string | null {
  if (typeof window === "undefined") return null;
  if (!window.isSecureContext) {
    return "Push notification permission can only be requested from a secure HTTPS page.";
  }
  try {
    if (window.self !== window.top) {
      return "Firefox and Safari block notification permission prompts inside embedded previews. Open the app in its own browser tab, then enable notifications there.";
    }
  } catch (_) {
    return "Firefox and Safari block notification permission prompts inside embedded previews. Open the app in its own browser tab, then enable notifications there.";
  }
  return null;
}

export function openPushPermissionSetupWindow(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.set("pushSetup", "1");
  window.open(url.toString(), "_blank", "noopener,noreferrer");
}

export function usePush() {
  const [permission, setPermission] = useState<NotificationPermission>("default");
  const [subscribed, setSubscribed] = useState(false);
  const [autoRetrying, setAutoRetrying] = useState(false);
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
    const contextError = getPushPermissionContextError();
    if (contextError) return Promise.reject(new Error(contextError));
    const current = Notification.permission;
    if (current !== "default") return Promise.resolve(current);
    // Call synchronously — do NOT await anything before this line in callers.
    let p: Promise<NotificationPermission>;
    try {
      // Firefox is stricter than Chromium about this API: pass no deprecated
      // callback argument, and invoke it directly inside the click handler.
      const maybe = Notification.requestPermission();
      p = maybe instanceof Promise ? maybe : new Promise((resolve) => {
        const started = Date.now();
        const timer = window.setInterval(() => {
          if (Notification.permission !== "default" || Date.now() - started > 60_000) {
            window.clearInterval(timer);
            resolve(Notification.permission);
          }
        }, 250);
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
    const contextError = getPushPermissionContextError();
    if (contextError) throw new Error(contextError);
    const perm = Notification.permission;
    setPermission(perm);
    if (perm !== "granted") {
      throw new Error("Notification permission was not granted. Tap Enable again and choose Allow in your browser prompt.");
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
  }, [subscribeFn]);

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

  // Auto-retry: when permission flips to "granted" but we don't yet have a
  // subscription, finish the subscribe flow without requiring another click.
  // Covers Safari/Firefox where the prompt may resolve after the original
  // click handler's user-activation has lapsed, and cross-tab grants.
  useEffect(() => {
    if (!isPushSupported()) return;

    let cancelled = false;
    let permStatus: PermissionStatus | null = null;

    const syncPermission = () => {
      if (cancelled) return;
      const current = Notification.permission;
      setPermission((prev) => (prev === current ? prev : current));
    };

    const tryAutoSubscribe = async () => {
      if (cancelled) return;
      if (Notification.permission !== "granted") return;
      if (subscribed) return;
      if (autoRetrying) return;
      setAutoRetrying(true);
      try {
        await enable();
      } catch {
        // swallow — surfaced by manual enable button on next click
      } finally {
        if (!cancelled) setAutoRetrying(false);
      }
    };

    const onPermissionChange = () => {
      syncPermission();
      void tryAutoSubscribe();
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") onPermissionChange();
    };

    // navigator.permissions is the reliable signal in Chrome/Firefox. Safari
    // doesn't support querying "notifications", so we also fall back to
    // focus/visibility events to re-check Notification.permission.
    if (navigator.permissions?.query) {
      navigator.permissions
        .query({ name: "notifications" as PermissionName })
        .then((status) => {
          if (cancelled) return;
          permStatus = status;
          status.addEventListener("change", onPermissionChange);
        })
        .catch(() => {
          /* unsupported — focus/visibility fallback covers it */
        });
    }
    window.addEventListener("focus", onPermissionChange);
    document.addEventListener("visibilitychange", onVisibility);

    // Also trigger once on mount in case permission was granted previously
    // (e.g. another tab) but this tab never finished subscribing.
    void tryAutoSubscribe();

    return () => {
      cancelled = true;
      if (permStatus) permStatus.removeEventListener("change", onPermissionChange);
      window.removeEventListener("focus", onPermissionChange);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enable, subscribed, autoRetrying]);

  return {
    permission,
    subscribed,
    enable,
    disable,
    requestPermission,
    permissionContextError: getPushPermissionContextError(),
    openPushPermissionSetupWindow,
    supported: isPushSupported(),
    autoRetrying,
  };
}
