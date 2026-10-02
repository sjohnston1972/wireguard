import { useEffect, useState } from "react";

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
export function useServerNow(serverNow: string, receivedAt: number): number {
  const tick = useTick();
  const base = Date.parse(serverNow);
  if (!Number.isFinite(base)) return tick;
  return base + Math.max(0, tick - (receivedAt || tick));
}
