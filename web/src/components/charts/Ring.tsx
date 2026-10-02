import type { ReactNode } from "react";
import { cx, type Tone } from "../cx";
import { toneVar } from "./colors";
import "./Ring.css";

export interface RingProps {
  /** 0-100. null renders "no data". */
  value: number | null;
  /** Accessible name; the percentage is appended. */
  label: string;
  tone?: Tone;
  size?: number;
  stroke?: number;
  /** Text in the middle (for example "100%" or a count). */
  centre?: ReactNode;
  className?: string;
}

/** Progress ring (Availability, Success rate, Online now). */
export function Ring({ value, label, tone = "green", size = 44, stroke = 4, centre, className }: RingProps) {
  if (value === null || !Number.isFinite(value)) {
    return <span className={cx("ring__nodata", className)}>no data</span>;
  }
  const v = Math.min(100, Math.max(0, value));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <span className={cx("ring", className)} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${label}: ${Math.round(v)}%`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border-strong)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={toneVar(tone)}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${(c * v) / 100} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      {centre !== undefined && <span className="ring__centre">{centre}</span>}
    </span>
  );
}
