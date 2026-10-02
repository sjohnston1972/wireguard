import { useCallback, useEffect, useState } from "react";
import { usePushSubscribe, usePushUnsubscribe } from "@/api/mutations";
import { usePushStatus } from "@/api/queries";

// This phone's alerts, as the old page did them (worker/public/app.js): ask
// permission, subscribe with the dashboard's public key, hand the subscription
// to the dashboard, which encrypts every alert to it. sw.js shows the alerts.

export type DeviceState =
  | { kind: "checking" }
  | { kind: "unsupported" }
  | { kind: "denied" }
  | { kind: "off" }
  | { kind: "on" }
  /** The browser has a subscription the dashboard no longer sends to. */
  | { kind: "stale" }
  | { kind: "error"; message: string };

const supported = () => typeof navigator !== "undefined" && "serviceWorker" in navigator && typeof window !== "undefined" && "PushManager" in window && "Notification" in window;

function keyBytes(b64: string): Uint8Array<ArrayBuffer> {
  let s = b64.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

function isInstalled(): boolean {
  try {
    return window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}

export function deviceLabel(): string {
  const ua = navigator.userAgent;
  const what = /Android/i.test(ua) ? "Android phone" : /iPhone|iPad/i.test(ua) ? "iPhone" : /Windows/i.test(ua) ? "Windows PC" : /Mac/i.test(ua) ? "Mac" : "Device";
  return what + (isInstalled() ? " (app)" : " (browser)");
}

/** The app's service worker, or an error after 8 s (it never becomes ready if it did not register). */
function swReady(): Promise<ServiceWorkerRegistration> {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, no) => setTimeout(() => no(new Error("The app's background worker is not running; reload and try again.")), 8000)),
  ]);
}

export function usePushDevice(vapid: string | null) {
  const [base, setBase] = useState<DeviceState>({ kind: "checking" });
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const subscribe = usePushSubscribe();
  const unsubscribe = usePushUnsubscribe();
  const status = usePushStatus(endpoint ?? "", { enabled: !!endpoint });

  const look = useCallback(async () => {
    if (!supported()) return setBase({ kind: "unsupported" });
    if (Notification.permission === "denied") return setBase({ kind: "denied" });
    try {
      const sub = await (await swReady()).pushManager.getSubscription();
      setEndpoint(sub ? sub.endpoint : null);
      setBase(sub ? { kind: "on" } : { kind: "off" });
    } catch (e) {
      setBase({ kind: "error", message: (e as Error).message });
    }
  }, []);
  useEffect(() => {
    void look();
  }, [look]);

  // Having a subscription is only half of it: the dashboard must still list it too.
  const state: DeviceState = base.kind === "on" && status.data && !status.data.registered ? { kind: "stale" } : base;

  const enable = async () => {
    setBusy(true);
    try {
      if (!vapid) throw new Error("The dashboard has no push key set up yet.");
      if ((await Notification.requestPermission()) !== "granted") throw new Error("Notifications were not allowed.");
      const reg = await swReady();
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(vapid) });
      const j = sub.toJSON();
      await subscribe.mutateAsync({ endpoint: j.endpoint, keys: j.keys, label: deviceLabel() });
      setEndpoint(sub.endpoint);
      setBase({ kind: "on" });
    } catch (e) {
      setBase({ kind: "error", message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const disable = async () => {
    setBusy(true);
    try {
      const sub = await (await swReady()).pushManager.getSubscription();
      if (sub) {
        await unsubscribe.mutateAsync({ endpoint: sub.endpoint });
        await sub.unsubscribe();
      }
      setEndpoint(null);
      setBase({ kind: "off" });
    } catch (e) {
      setBase({ kind: "error", message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return { state, enable, disable, busy: busy || subscribe.isPending || unsubscribe.isPending };
}
