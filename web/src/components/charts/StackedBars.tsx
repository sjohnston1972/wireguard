import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { cx, type Tone } from "../cx";
import { niceMax, toneVar } from "./colors";
import { useElementWidth } from "./useElementWidth";
import "./StackedBars.css";

export interface StackSeries {
  key: string;
  label: string;
  color: Tone;
}

export interface StackBucket {
  label: string;
  /** Value per series key; missing keys count as 0. */
  values: Record<string, number>;
}

export interface BrushRange {
  /** Bucket indexes, inclusive, from <= to. */
  from: number;
  to: number;
}

export interface StackedBarsProps {
  title: string;
  series: StackSeries[];
  buckets: StackBucket[];
  /** Called when the user drags (or Shift+arrows then Enter) over a range of buckets. */
  onBrush?: (range: BrushRange) => void;
  height?: number;
  className?: string;
}

const ML = 30;
const MB = 20;
const MT = 6;

/** Activity timeline: stacked bars per bucket, hover/keyboard tooltip, brush selection. */
export function StackedBars({ title, series, buckets, onBrush, height = 120, className }: StackedBarsProps) {
  const [ref, width] = useElementWidth<HTMLDivElement>(700);
  const plotRef = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const [sel, setSel] = useState<BrushRange | null>(null);
  const anchor = useRef<number | null>(null);
  const drag = useRef<{ start: number; x0: number; moved: boolean } | null>(null);

  if (buckets.length === 0) {
    return (
      <figure className={cx("stack", className)} aria-label={title}>
        <div className="stack__empty" style={{ height }}>
          no data
        </div>
        <figcaption className="visually-hidden">{title}. no data</figcaption>
      </figure>
    );
  }

  const totals = buckets.map((b) => series.reduce((s, k) => s + (b.values[k.key] ?? 0), 0));
  const max = niceMax(Math.max(1, ...totals));
  const pw = width - ML - 4;
  const ph = height - MT - MB;
  const slot = pw / buckets.length;
  const bw = Math.max(1.5, Math.min(14, slot * 0.7));
  const Y = (v: number) => MT + ph - (v / max) * ph;
  const every = Math.max(1, Math.ceil(buckets.length / Math.max(2, Math.floor(pw / 80))));

  const sums = series.map((s) => ({ ...s, total: buckets.reduce((a, b) => a + (b.values[s.key] ?? 0), 0) }));
  const busiest = buckets[totals.indexOf(Math.max(...totals))];
  const summary = `${buckets.length} buckets, ${sums.map((s) => `${s.label} ${s.total}`).join(", ")}, busiest ${busiest.label}`;

  const indexAt = (clientX: number) => {
    const rect = plotRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    // Convert to SVG user units, then skip the axis margin.
    const px = (clientX - rect.left) * (width / rect.width);
    const i = Math.floor((px - ML) / slot);
    return Math.min(buckets.length - 1, Math.max(0, i));
  };

  const onPointerDown = (e: PointerEvent) => {
    const i = indexAt(e.clientX);
    drag.current = { start: i, x0: e.clientX, moved: false };
    setActive(i);
    setSel(null);
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    const i = indexAt(e.clientX);
    setActive(i);
    const d = drag.current;
    if (!d) return;
    if (Math.abs(e.clientX - d.x0) > 3) d.moved = true;
    if (d.moved) setSel({ from: Math.min(d.start, i), to: Math.max(d.start, i) });
  };
  const onPointerUp = (e: PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || !d.moved) return;
    const i = indexAt(e.clientX);
    const range = { from: Math.min(d.start, i), to: Math.max(d.start, i) };
    if (range.from !== range.to) {
      setSel(range);
      onBrush?.(range);
    } else setSel(null);
  };

  const onKey = (e: KeyboardEvent) => {
    const cur = active ?? 0;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const next = Math.min(buckets.length - 1, Math.max(0, cur + (e.key === "ArrowRight" ? 1 : -1)));
      if (e.shiftKey) {
        if (anchor.current === null) anchor.current = cur;
        setSel({ from: Math.min(anchor.current, next), to: Math.max(anchor.current, next) });
      } else {
        anchor.current = null;
        setSel(null);
      }
      setActive(next);
    } else if (e.key === "Enter" && sel && sel.from !== sel.to) {
      e.preventDefault();
      onBrush?.(sel);
    } else if (e.key === "Escape" && sel) {
      setSel(null);
      anchor.current = null;
    }
  };

  const tip = active !== null ? buckets[active] : null;
  const tipLeft = active !== null ? Math.min(Math.max(ML + slot * (active + 0.5) - 70, 0), Math.max(0, width - 170)) : 0;

  return (
    <figure className={cx("stack", className)} aria-label={title}>
      <div ref={ref} className="stack__wrap">
        <div
          ref={plotRef}
          className="stack__plot"
          role="application"
          aria-label={`${title}. Arrow keys move between buckets, Shift plus arrows select a range, Enter zooms.`}
          tabIndex={0}
          onFocus={() => setActive((a) => a ?? 0)}
          onBlur={() => {
            setActive(null);
          }}
          onKeyDown={onKey}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => {
            if (!drag.current) setActive(null);
          }}
          style={{ height, touchAction: "pan-y" }}
        >
          <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
            {[0, 0.5, 1].map((f) => (
              <g key={f}>
                <line x1={ML} x2={width - 4} y1={Y(f * max)} y2={Y(f * max)} stroke="var(--border)" />
                <text x={ML - 6} y={Y(f * max) + 4} textAnchor="end" className="stack__tick">
                  {Math.round(f * max)}
                </text>
              </g>
            ))}
            {sel && <rect x={ML + slot * sel.from} y={MT} width={slot * (sel.to - sel.from + 1)} height={ph} className="stack__sel" />}
            {active !== null && !sel && <rect x={ML + slot * active} y={MT} width={slot} height={ph} className="stack__hover" />}
            {buckets.map((b, i) => {
              let acc = 0;
              return (
                <g key={i}>
                  {series.map((s) => {
                    const v = b.values[s.key] ?? 0;
                    if (v <= 0) return null;
                    const y = Y(acc + v);
                    const h = Y(acc) - y;
                    acc += v;
                    return <rect key={s.key} x={ML + slot * i + (slot - bw) / 2} y={y} width={bw} height={Math.max(0, h)} fill={toneVar(s.color)} />;
                  })}
                </g>
              );
            })}
            {buckets.map((b, i) =>
              i % every === 0 ? (
                <text key={i} x={ML + slot * (i + 0.5)} y={height - 5} textAnchor="middle" className="stack__tick">
                  {b.label}
                </text>
              ) : null,
            )}
          </svg>
          {tip && (
            <div role="tooltip" className="stack__tip" style={{ left: tipLeft }}>
              <div className="stack__tip-title">{tip.label}</div>
              {series
                .filter((s) => (tip.values[s.key] ?? 0) > 0)
                .map((s) => (
                  <div key={s.key} className="stack__tip-row">
                    <span className="stack__swatch" style={{ background: toneVar(s.color) }} aria-hidden />
                    {tip.values[s.key]} {s.label}
                  </div>
                ))}
              {totals[active as number] === 0 && <div className="stack__tip-row">no events</div>}
            </div>
          )}
        </div>
      </div>
      <figcaption className="visually-hidden">
        {title}. {summary}.
      </figcaption>
    </figure>
  );
}
