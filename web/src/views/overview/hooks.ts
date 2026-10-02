import { useEffect, useRef, useState } from "react";

/** An element's height in px, kept up to date (a chart that fills its panel). `fallback` until measured. */
export function useElementHeight<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T | null>(null);
  const [h, setH] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const v = Math.floor(el.getBoundingClientRect().height);
      if (v > 0) setH(v);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, height: h };
}

/** The clock, ticking every `ms` (default 1 s). */
export function useTick(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/**
 * The server's clock now: its `now` when the answer arrived, plus the time
 * since on this browser's clock. A browser whose clock is wrong still shows
 * the right elapsed time and ages.
 */
export function useServerNow(serverNow: string, receivedAt: number, everyMs = 1000): number {
  const tick = useTick(everyMs);
  const base = Date.parse(serverNow);
  if (!Number.isFinite(base)) return tick;
  return base + Math.max(0, tick - (receivedAt || tick));
}
