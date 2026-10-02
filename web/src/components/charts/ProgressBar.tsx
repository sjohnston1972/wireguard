import { cx, type Tone } from "../cx";
import { toneVar } from "./colors";
import "./ProgressBar.css";

export interface ProgressBarProps {
  /** 0-100. null renders "no data" (never an empty bar that reads as 0 %). */
  value: number | null;
  /** Accessible name. */
  label: string;
  tone?: Tone;
  /** Show the percentage at the right (the Overview tile does: "67%"). */
  showValue?: boolean;
  height?: number;
  className?: string;
}

export function ProgressBar({ value, label, tone = "blue", showValue, height = 6, className }: ProgressBarProps) {
  if (value === null || !Number.isFinite(value)) {
    return <span className={cx("progress__nodata", className)}>no data</span>;
  }
  const v = Math.min(100, Math.max(0, value));
  return (
    <div className={cx("progress", className)}>
      <div
        className="progress__track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(v)}
        style={{ height }}
      >
        <div className="progress__fill" style={{ width: `${v}%`, background: toneVar(tone) }} />
      </div>
      {showValue && <span className="progress__value">{Math.round(v)}%</span>}
    </div>
  );
}
