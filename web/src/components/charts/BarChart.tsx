import { cx } from "../cx";
import { fmtNum, niceMax } from "./colors";
import { useElementWidth } from "./useElementWidth";
import "./BarChart.css";

export interface Bar {
  label: string;
  /** Null is a day with no data: a gap, with the day kept on the axis (never drawn as 0). */
  value: number | null;
}

export interface BarChartProps {
  title: string;
  /** Actual daily values (solid bars). */
  bars: Bar[];
  /** Projected values continuing after the bars, drawn as a dashed amber line. */
  forecast?: Bar[];
  /** Same length as bars: the previous period, drawn as a dashed line (null is a gap). */
  previous?: Array<number | null>;
  /** Budget line (dashed grey) across the whole plot. */
  budget?: number;
  format?: (v: number) => string;
  height?: number;
  className?: string;
}

const ML = 48;
const MB = 22;
const MT = 8;

/** Daily bars with an optional budget line and a dashed forecast. Plain SVG. */
export function BarChart({ title, bars, forecast = [], previous, budget, format, height = 180, className }: BarChartProps) {
  const [ref, width] = useElementWidth<HTMLDivElement>(600);
  const fmt = format ?? ((v: number) => fmtNum(v));

  const known = (vals: Array<number | null>) => vals.filter((v): v is number => v !== null && Number.isFinite(v));
  const real = bars.filter((b): b is Bar & { value: number } => b.value !== null && Number.isFinite(b.value));

  if (real.length === 0) {
    return (
      <figure className={cx("bar", className)} aria-label={title}>
        <div className="bar__empty" style={{ height }}>
          no data
        </div>
        <figcaption className="visually-hidden">{title}. no data</figcaption>
      </figure>
    );
  }

  const slots = bars.length + forecast.length;
  const max = niceMax(Math.max(...real.map((b) => b.value), ...known(forecast.map((b) => b.value)), ...known(previous ?? []), budget ?? 0));
  const pw = width - ML - 8;
  const ph = height - MT - MB;
  const slotW = pw / slots;
  const bw = Math.max(2, Math.min(18, slotW * 0.62));
  const X = (i: number) => ML + slotW * i + slotW / 2;
  const Y = (v: number) => MT + ph - (v / max) * ph;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const every = Math.max(1, Math.ceil(slots / Math.max(2, Math.floor(pw / 70))));
  const all = [...bars, ...forecast];

  const total = real.reduce((s, b) => s + b.value, 0);
  const peak = real.reduce((a, b) => (b.value > a.value ? b : a), real[0]);
  const missing = bars.length - real.length;
  const lastForecast = forecast[forecast.length - 1];
  const summary = [
    `${bars.length} ${bars.length === 1 ? "day" : "days"}`,
    `total ${fmt(total)}`,
    `peak ${fmt(peak.value)} on ${peak.label}`,
    missing > 0 ? `${missing} ${missing === 1 ? "day" : "days"} with no data` : null,
    budget !== undefined ? `budget ${fmt(budget)}` : null,
    lastForecast && lastForecast.value !== null ? `forecast ${fmt(lastForecast.value)} by ${lastForecast.label}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  const line = (vals: Array<number | null>, offset = 0) =>
    vals
      .map((v, i) => (v === null ? "" : `${i === 0 || vals[i - 1] === null ? "M" : "L"}${X(i + offset).toFixed(1)},${Y(v).toFixed(1)}`))
      .join(" ");

  return (
    <figure className={cx("bar", className)} aria-label={title}>
      <div ref={ref} className="bar__plot">
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={ML} x2={width - 8} y1={Y(t)} y2={Y(t)} stroke="var(--border)" />
              <text x={ML - 8} y={Y(t) + 4} textAnchor="end" className="bar__tick">
                {fmt(t)}
              </text>
            </g>
          ))}
          {all.map((b, i) =>
            i % every === 0 ? (
              <text key={i} x={X(i)} y={height - 5} textAnchor="middle" className="bar__tick">
                {b.label}
              </text>
            ) : null,
          )}
          {bars.map((b, i) =>
            b.value === null || !Number.isFinite(b.value) ? null : (
              <rect key={i} x={X(i) - bw / 2} y={Y(b.value)} width={bw} height={Math.max(0, MT + ph - Y(b.value))} rx={2} fill="var(--blue)" />
            ),
          )}
          {previous && <path d={line(previous)} fill="none" stroke="var(--blue-bright)" strokeWidth={1.5} strokeDasharray="4 3" opacity={0.8} />}
          {forecast.length > 0 && (
            <path
              d={line([bars[bars.length - 1].value, ...forecast.map((f) => f.value)], bars.length - 1)}
              fill="none"
              stroke="var(--amber)"
              strokeWidth={1.5}
              strokeDasharray="5 3"
            />
          )}
          {forecast.length > 0 && (
            <line x1={ML + slotW * bars.length} x2={ML + slotW * bars.length} y1={MT} y2={MT + ph} stroke="var(--border-strong)" strokeDasharray="3 3" />
          )}
          {budget !== undefined && <line x1={ML} x2={width - 8} y1={Y(budget)} y2={Y(budget)} stroke="var(--text-muted)" strokeDasharray="6 4" />}
        </svg>
      </div>
      <figcaption className="visually-hidden">
        {title}. {summary}.
      </figcaption>
    </figure>
  );
}
