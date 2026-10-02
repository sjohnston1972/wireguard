import { useCallback, useSyncExternalStore } from "react";

/** True while the media query matches (false without matchMedia); follows resizes. */
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

/** Below 1400 px the right column folds into one tabbed panel (spec §8.3). */
export const NARROW = "(max-width: 1399px)";
