import type { ReactNode } from "react";
import { cx, type Tone } from "../cx";
import { toneVar } from "./colors";
import "./Donut.css";

export interface DonutSegment {
  label: string;
  value: number;
  color: Tone;
  /** Shown in the legend; defaults to the percentage only. */
  display?: string;
}

export interface DonutProps {
  segments: DonutSegment[];
  /** Accessible name. A summary of every segment's share is appended. */
  title: string;
  centre?: { value: ReactNode; label?: ReactNode };
  size?: number;
  stroke?: number;
  /** Show the legend (label, value, share) beside the ring. */
  legend?: boolean;
  /** The legend's share column (default on). Off leaves it out; the chart's name still gives each share. */
  percentages?: boolean;
  className?: string;
}

const pct = (v: number, total: number) => {
  const p = (v / total) * 100;
  return p > 0 && p < 1 ? "<1%" : `${Math.round(p)}%`;
};

export function Donut({ segments, title, centre, size = 160, stroke = 18, legend = true, percentages = true, className }: DonutProps) {
  const total = segments.reduce((s, x) => s + (Number.isFinite(x.value) ? Math.max(0, x.value) : 0), 0);
  if (total <= 0) return <span className={cx("donut__nodata", className)}>no data</span>;

  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  let offset = 0;
  const name = `${title}: ${segments.map((s) => `${s.label} ${pct(s.value, total)}`).join(", ")}`;
  return (
    <div className={cx("donut", className)}>
      <div className="donut__ring" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={name}>
          {segments.map((s) => {
            const len = (Math.max(0, s.value) / total) * c;
            const el = (
              <circle
                key={s.label}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={toneVar(s.color)}
                strokeWidth={stroke}
                strokeDasharray={`${Math.max(0, len - (segments.length > 1 ? 1.5 : 0))} ${c}`}
                strokeDashoffset={-offset}
                transform={`rotate(-90 ${size / 2} ${size / 2})`}
              />
            );
            offset += len;
            return el;
          })}
        </svg>
        {centre && (
          <div className="donut__centre">
            <strong>{centre.value}</strong>
            {centre.label && <span>{centre.label}</span>}
          </div>
        )}
      </div>
      {legend && (
        <ul className="donut__legend">
          {segments.map((s) => (
            <li key={s.label}>
              <span className="donut__swatch" style={{ background: toneVar(s.color) }} aria-hidden />
              <span className="donut__name">{s.label}</span>
              {s.display && <span className="donut__val">{s.display}</span>}
              {percentages && <span className="donut__pct">{pct(s.value, total)}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
