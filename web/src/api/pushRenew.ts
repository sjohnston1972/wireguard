// api/pushRenew.ts
//
// Plain English: finishing a phone-alert renewal that demo mode refused. When
// the browser renews a phone's alert subscription, sw.js hands the new one to
// the dashboard (POST /push/subscribe). Demo mode refuses every write, that one
// too, so sw.js keeps the renewal in a "push-renew" notification on the phone.
// Whenever this app's data is real (demo mode off), it looks for such a
// notification and hands the renewal over: subscribe the new, drop the old,
// close the notification. A refused or failed hand-over keeps it for next time.

import { useEffect, useSyncExternalStore } from "react";
import { apiSend, currentSource, subscribeSource } from "./client";

/** The tag sw.js gives a renewal demo mode refused. */
export const PUSH_RENEW_TAG = "push-renew";

type Renewal = { subscribe: { endpoint: string; keys?: unknown; label?: string }; old: string | null };

function renewalOf(data: unknown): Renewal | null {
  const r = (data as { renew?: Renewal } | null)?.renew;
  return r && typeof r.subscribe?.endpoint === "string" ? r : null;
}

/** Hand over any kept renewal. True when one was handed over. Never throws. */
export async function retryPushRenewal(nav: Navigator = navigator): Promise<boolean> {
  if (!nav || !("serviceWorker" in nav)) return false;
  let done = false;
  try {
    const reg = await nav.serviceWorker.getRegistration("/");
    if (!reg || typeof reg.getNotifications !== "function") return false;
    for (const note of await reg.getNotifications({ tag: PUSH_RENEW_TAG })) {
      const r = renewalOf(note.data);
      if (r) {
        await apiSend("POST", "/push/subscribe", r.subscribe);
        if (r.old && r.old !== r.subscribe.endpoint) await apiSend("POST", "/push/unsubscribe", { endpoint: r.old }).catch(() => undefined);
        done = true;
      }
      note.close();
    }
  } catch {
    // Still demo mode, signed out or offline: the notification stays, and the next real answer tries again.
  }
  return done;
}

/** The shell's half: whenever the data becomes real, hand over any renewal demo mode refused. */
export function usePushRenewalRetry(): void {
  const source = useSyncExternalStore(subscribeSource, currentSource, currentSource);
  useEffect(() => {
    if (source === "real") void retryPushRenewal();
  }, [source]);
}
