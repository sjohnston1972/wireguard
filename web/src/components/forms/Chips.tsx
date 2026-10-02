import { cx } from "../cx";
import "./Chips.css";

export interface ChipItem {
  value: string;
  label: string;
}

export interface ChipsProps {
  items: ChipItem[];
  value: string[];
  onChange: (value: string[]) => void;
  /** multi: day pills; single: duration chips (one selected). */
  mode?: "multi" | "single";
  shape?: "pill" | "rect";
  "aria-label": string;
  className?: string;
}

/** Day pills (Mon..Sun) and duration chips: toggle buttons with aria-pressed. */
export function Chips({ items, value, onChange, mode = "multi", shape = "pill", className, ...rest }: ChipsProps) {
  const toggle = (v: string) => {
    if (mode === "single") return onChange([v]);
    onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  };
  return (
    <div role="group" aria-label={rest["aria-label"]} className={cx("chips", className)}>
      {items.map((it) => {
        const on = value.includes(it.value);
        return (
          <button
            key={it.value}
            type="button"
            aria-pressed={on}
            className={cx("chip", `chip--${shape}`, on && "chip--on")}
            onClick={() => toggle(it.value)}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}
