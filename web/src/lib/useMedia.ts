import { useCallback, useSyncExternalStore } from "react";

/** True while the CSS media query matches (false without matchMedia); follows resizes. */
export function useMedia(query: string): boolean {
  const subscribe = useCallback(
    (cb: () => void) => {
      if (typeof window.matchMedia !== "function") return () => {};
      const mq = window.matchMedia(query);
      mq.addEventListener?.("change", cb);
      return () => mq.removeEventListener?.("change", cb);
    },
    [query],
  );
  const get = () => (typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false);
  return useSyncExternalStore(subscribe, get, () => false);
}
