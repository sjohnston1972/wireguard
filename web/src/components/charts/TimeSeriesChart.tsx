import { useEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { cx, type Tone } from "../cx";
import { fmtNum, resolveTone, resolveVar, toneVar, useThemeVersion, withAlpha } from "./colors";
import "./TimeSeriesChart.css";

export type ChartRange = "live" | "1h" | "24h" | "7d" | "30d";

const RANGE_WORDS: Record<ChartRange, string> = {
  live: "few minutes",
  "1h": "1 hour",
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
};

export interface TimeSeries {
  label: string;
  color: Tone;
  /** One value per x entry; null is a gap. */
  data: Array<number | null>;
  /** Fill under the line (default true). */
  area?: boolean;
}

export interface TimeSeriesChartProps {
  title: string;
  /** Unix seconds, ascending. */
  x: number[];
  series: TimeSeries[];
  /** Controls the axis format and the summary wording. */
  range: ChartRange;
  /** Appended to values in the axis, the readout and the summary, for example " KB/s". */
  unit?: string;
  /** Custom value formatter (overrides unit) for axis and readout. */
  format?: (v: number) => string;
  height?: number;
  className?: string;
}

function xFormatter(range: ChartRange) {
  const long = range === "7d" || range === "30d";
  const f = new Intl.DateTimeFormat("en-GB", long ? { day: "numeric", month: "short" } : { hour: "2-digit", minute: "2-digit", hour12: false });
  return (sec: number) => f.format(new Date(sec * 1000));
}

/** uPlot line/area chart: in/out series, hover readout, accessible text summary. */
export function TimeSeriesChart({ title, x, series, range, unit = "", format, height = 160, className }: TimeSeriesChartProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const themeVersion = useThemeVersion();
  const [hover, setHover] = useState<number | null>(null);
  const fmt = useMemo(() => format ?? ((v: number) => `${fmtNum(v)}${unit}`), [format, unit]);
  const fmtX = useMemo(() => xFormatter(range), [range]);

  const hasData = x.length > 0 && series.some((s) => s.data.some((v) => v !== null && Number.isFinite(v)));

  const summary = useMemo(() => {
    if (!hasData) return "no data";
    const parts = series.map((s) => {
      const vals = s.data.filter((v): v is number => v !== null && Number.isFinite(v));
      if (!vals.length) return `${s.label}: no data`;
      return `${s.label}: latest ${fmtNum(vals[vals.length - 1])}${unit}, peak ${fmtNum(Math.max(...vals))}${unit}`;
    });
    return `${parts.join(". ")}. Covers the last ${RANGE_WORDS[range]}.`;
  }, [hasData, series, unit, range]);

  // The plot is built once per structural change (series count, labels,
  // colours, fill; height; theme; range) and destroyed on cleanup. New data
  // of the same shape goes to setData below, so polling does not rebuild the
  // canvas or lose the hover. Formatters and data are read through refs so
  // their identity (fresh arrays, inline functions) never forces a rebuild.
  const plotRef = useRef<uPlot | null>(null);
  const fmtRef = useRef(fmt);
  fmtRef.current = fmt;
  const fmtXRef = useRef(fmtX);
  fmtXRef.current = fmtX;
  const data = useMemo(() => [x, ...series.map((s) => s.data)] as uPlot.AlignedData, [x, series]);
  const dataRef = useRef(data);
  dataRef.current = data;
  /** The data the live plot was last given. */
  const appliedRef = useRef<uPlot.AlignedData | null>(null);
  const shape = series.map((s) => `${s.label}\u0000${s.color}\u0000${s.area === false ? 0 : 1}`).join("\u0001");

  useEffect(() => {
    const el = host.current;
    if (!el || !hasData) return;
    const shapeSeries = series;
    const grid = resolveVar(el, "--border", "#222");
    const axis = resolveVar(el, "--text-muted", "#888");
    const opts: uPlot.Options = {
      width: Math.max(200, Math.floor(el.getBoundingClientRect().width) || 600),
      height,
      padding: [8, 8, 0, 0],
      legend: { show: false },
      cursor: { drag: { x: false, y: false }, points: { size: 6 } },
      scales: { x: { time: true }, y: { range: (_u, _min, max) => [0, max > 0 ? max * 1.15 : 1] } },
      axes: [
        {
          stroke: axis,
          grid: { stroke: grid, width: 1 },
          ticks: { show: false },
          // uPlot's default 50 px under the plot leaves a short chart almost no plot.
          size: 26,
          font: '11px "Inter Variable", system-ui, sans-serif',
          values: (_u, vals) => vals.map((v) => fmtXRef.current(v)),
        },
        {
          stroke: axis,
          grid: { stroke: grid, width: 1 },
          ticks: { show: false },
          size: 56,
          // A short chart still gets a label at the top as well as 0 (uPlot's default wants 30 px between labels).
          space: height < 160 ? 16 : 30,
          font: '11px "Inter Variable", system-ui, sans-serif',
          values: (_u, vals) => vals.map((v) => fmtRef.current(v)),
        },
      ],
      series: [
        {},
        ...shapeSeries.map((s): uPlot.Series => {
          const stroke = resolveTone(el, s.color);
          return {
            label: s.label,
            stroke,
            width: 1.5,
            spanGaps: false,
            fill: s.area === false ? undefined : withAlpha(stroke, 0.18),
            points: { show: false },
          };
        }),
      ],
      hooks: {
        setCursor: [(u) => setHover(u.cursor.idx ?? null)],
      },
    };
    const plot = new uPlot(opts, dataRef.current, el);
    plotRef.current = plot;
    appliedRef.current = dataRef.current;

    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => {
        const w = Math.floor(el.getBoundingClientRect().width);
        if (w > 0) plot.setSize({ width: w, height });
      });
      ro.observe(el);
    }
    return () => {
      ro?.disconnect();
      plot.destroy();
      if (plotRef.current === plot) plotRef.current = null;
    };
    // `series` is read only for its shape, which `shape` stands for; `range`
    // changes the x labels' format, so it rebuilds the axes.
  }, [hasData, shape, height, themeVersion, range]);

  // New data of the same shape: hand it to the existing plot.
  useEffect(() => {
    const plot = plotRef.current;
    if (!plot || appliedRef.current === data) return;
    plot.setData(data);
    appliedRef.current = data;
  }, [data]);

  const readout = hover !== null && hover < x.length ? { time: fmtX(x[hover]), vals: series.map((s) => ({ label: s.label, color: s.color, v: s.data[hover] })) } : null;

  return (
    <figure className={cx("tsc", className)} aria-label={title}>
      {hasData ? (
        <>
          <div className="tsc__legend" aria-hidden="true">
            {readout && <span className="tsc__time">{readout.time}</span>}
            {series.map((s, i) => (
              <span key={s.label} className="tsc__key">
                <span className="tsc__dot" style={{ background: toneVar(s.color) }} />
                {s.label}
                {readout && <b>{readout.vals[i].v === null ? "no data" : fmt(readout.vals[i].v as number)}</b>}
              </span>
            ))}
          </div>
          <div ref={host} className="tsc__plot" style={{ height }} />
        </>
      ) : (
        <div className="tsc__empty" style={{ height }}>
          no data
        </div>
      )}
      <figcaption className="visually-hidden" data-testid="chart-summary">
        {title}. {summary}
      </figcaption>
    </figure>
  );
}
