import { useEffect, useState } from "react";
import { cx } from "../cx";
import "./DataAge.css";

/** 8000 -> "8 s ago". Rounds down; never shows 0 as "no data". */
export function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

export interface DataAgeProps {
  /** When the data was fetched or measured (epoch ms). null = never. */
  at: number | null;
  /** Older than this is "stale" (default 2 minutes, the heartbeat rule in spec 10). */
  staleAfterMs?: number;
  /** Fixed clock (tests). Without it the label ticks every second. */
  now?: number;
  className?: string;
}

function useNow(fixed?: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (fixed !== undefined) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [fixed]);
  return fixed ?? now;
}

/** "updated 8 s ago". Every panel with live data shows this; stale data is flagged in words. */
export function DataAge({ at, staleAfterMs = 120_000, now, className }: DataAgeProps) {
  const clock = useNow(now);
  if (at === null) return <span className={cx("data-age", className)}>no data</span>;
  const age = clock - at;
  const stale = age > staleAfterMs;
  return (
    <span className={cx("data-age", stale && "data-age--stale", className)} data-stale={stale}>
      <span>updated {formatAge(age)}</span>
      {stale && <span className="data-age__flag">stale</span>}
    </span>
  );
}
