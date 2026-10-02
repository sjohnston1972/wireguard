import { useRef, type KeyboardEvent } from "react";
import { cx } from "../cx";
import "./SegmentedControl.css";

export interface SegmentItem {
  value: string;
  label: string;
  /** Optional leading dot colour (the "Live" item has a green dot). */
  dot?: "green" | "amber" | "red";
}

export interface SegmentedControlProps {
  items: SegmentItem[];
  value: string;
  onChange: (value: string) => void;
  "aria-label": string;
  className?: string;
}

/** Live / 1h / 24h / 7d / 30d. A radio group: one tab stop, arrows move and select. */
export function SegmentedControl({ items, value, onChange, className, ...rest }: SegmentedControlProps) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const current = Math.max(0, items.findIndex((i) => i.value === value));

  const onKey = (e: KeyboardEvent) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (current + step + items.length) % items.length;
    onChange(items[next].value);
    refs.current[next]?.focus();
  };

  return (
    <div role="radiogroup" aria-label={rest["aria-label"]} className={cx("segmented", className)} onKeyDown={onKey}>
      {items.map((it, i) => (
        <button
          key={it.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={i === current}
          tabIndex={i === current ? 0 : -1}
          className="segmented__item"
          onClick={() => onChange(it.value)}
        >
          {it.dot && <span className={cx("segmented__dot", `segmented__dot--${it.dot}`)} aria-hidden />}
          {it.label}
        </button>
      ))}
    </div>
  );
}
