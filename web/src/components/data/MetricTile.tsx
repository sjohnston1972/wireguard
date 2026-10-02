import type { ReactNode } from "react";
import { cx, type Tone } from "../cx";
import { ProgressBar } from "../charts/ProgressBar";
import { Ring } from "../charts/Ring";
import { Sparkline } from "../charts/Sparkline";
import { toneVar } from "../charts/colors";
import "./MetricTile.css";

export interface Delta {
  /** Text next to the arrow, for example "34%" or "22% vs yesterday". */
  text: string;
  direction: "up" | "down";
  /** true = green, false = red, null/undefined = neutral. Direction alone does not say good or bad. */
  good?: boolean | null;
}

export interface MetricTileProps {
  icon?: ReactNode;
  /** Icon and (optionally) value colour: status only. */
  tone?: Tone;
  label: string;
  /** null or undefined renders "no data", never 0. */
  value: ReactNode | null;
  /** Colour the value with the tone (status words like "Healthy"). */
  valueTone?: boolean;
  sub?: ReactNode;
  delta?: Delta;
  /** Inline sparkline at the right. */
  spark?: Array<number | null>;
  sparkTone?: Tone;
  /** 0-100 progress bar under the value. */
  progress?: { value: number | null; tone?: Tone; showValue?: boolean };
  /** 0-100 ring at the right. */
  ring?: { value: number | null; centre?: ReactNode };
  /** Right-hand slot, for example a "Manage" button. */
  action?: ReactNode;
  /** card: own bordered surface; inset: darker tile inside a panel. */
  variant?: "card" | "inset";
  className?: string;
}

export function MetricTile({
  icon,
  tone = "blue",
  label,
  value,
  valueTone,
  sub,
  delta,
  spark,
  sparkTone,
  progress,
  ring,
  action,
  variant = "card",
  className,
}: MetricTileProps) {
  const missing = value === null || value === undefined;
  return (
    <div className={cx("tile", `tile--${variant}`, className)}>
      {icon && (
        <span className={cx("tile__icon", `tile__icon--${tone}`)} aria-hidden>
          {icon}
        </span>
      )}
      <div className="tile__main">
        <div className="tile__label">{label}</div>
        <div className="tile__row">
          <span className={cx("tile__value", missing && "tile__value--none")} style={valueTone && !missing ? { color: toneVar(tone) } : undefined}>
            {missing ? "no data" : value}
          </span>
          {delta && (
            <span className={cx("tile__delta", delta.good === true && "tile__delta--good", delta.good === false && "tile__delta--bad")}>
              <span aria-hidden>{delta.direction === "up" ? "▲" : "▼"}</span>
              <span className="visually-hidden">{delta.direction}</span>
              <span>{delta.text}</span>
            </span>
          )}
        </div>
        {progress && (
          <ProgressBar
            className="tile__progress"
            label={label}
            value={progress.value}
            tone={progress.tone}
            showValue={progress.showValue ?? true}
          />
        )}
        {sub && <div className="tile__sub">{sub}</div>}
      </div>
      {spark && <Sparkline className="tile__spark" label={label} data={spark} tone={sparkTone ?? tone} width={96} height={32} />}
      {ring && <Ring label={label} value={ring.value} centre={ring.centre} tone={tone} size={48} />}
      {action}
    </div>
  );
}
