import { cx, type Tone } from "../cx";
import { fmtNum, toneVar } from "./colors";
import "./Sparkline.css";

export interface SparklineProps {
  /** Values oldest to newest; null marks a gap. */
  data: Array<number | null>;
  /** Accessible name, for example "Latency". A text summary is appended. */
  label: string;
  unit?: string;
  tone?: Tone;
  width?: number;
  height?: number;
  /** Fill under the line (line variant only). */
  area?: boolean;
  /**
   * "line" (default) is a trend line; "bars" is a row of small bars, one per
   * value (the Firewall mockup's "Hits (24h)" column and "Recent drops" tile).
   * In both, null is a gap: no data, never drawn as 0.
   */
  variant?: "line" | "bars";
  className?: string;
}

/** Inline SVG trend line or mini bar chart. No data shows the words "no data", never a flat line. */
export function Sparkline({ data, label, unit = "", tone = "green", width = 90, height = 28, area = true, variant = "line", className }: SparklineProps) {
  const vals = data.filter((v): v is number => v !== null && Number.isFinite(v));
  if (vals.length === 0) {
    return <span className={cx("spark__nodata", className)}>no data</span>;
  }
  if (variant === "bars") return <SparkBars data={data} vals={vals} label={label} unit={unit} tone={tone} width={width} height={height} className={className} />;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const latest = vals[vals.length - 1];
  const pad = 2;
  const span = max - min || 1;
  const stepX = data.length > 1 ? (width - pad * 2) / (data.length - 1) : 0;
  const xy = (v: number, i: number) => `${(pad + i * stepX).toFixed(1)},${(height - pad - ((v - min) / span) * (height - pad * 2)).toFixed(1)}`;

  // Split at gaps so a missing sample is not drawn as a line.
  const segments: Array<Array<[number, number]>> = [];
  let cur: Array<[number, number]> = [];
  data.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      if (cur.length) segments.push(cur);
      cur = [];
    } else cur.push([v, i]);
  });
  if (cur.length) segments.push(cur);

  const name = `${label}: ${vals.length} points, min ${fmtNum(min)}${unit}, max ${fmtNum(max)}${unit}, latest ${fmtNum(latest)}${unit}`;
  const color = toneVar(tone);
  return (
    <svg className={cx("spark", className)} role="img" aria-label={name} width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      {segments.map((seg, k) => {
        const pts = seg.map(([v, i]) => xy(v, i));
        const line = pts.length === 1 ? `M${pts[0]} L${pts[0]}` : `M${pts.join(" L")}`;
        const [fx] = pts[0].split(",");
        const [lx] = pts[pts.length - 1].split(",");
        return (
          <g key={k}>
            {area && pts.length > 1 && (
              <path d={`${line} L${lx},${height} L${fx},${height} Z`} fill={color} opacity={0.14} />
            )}
            <path d={line} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
          </g>
        );
      })}
    </svg>
  );
}

interface BarsProps {
  data: Array<number | null>;
  vals: number[];
  label: string;
  unit: string;
  tone: Tone;
  width: number;
  height: number;
  className?: string;
}

function SparkBars({ data, vals, label, unit, tone, width, height, className }: BarsProps) {
  // Bars grow from zero, so the scale starts at 0 (a count of hits or drops).
  const top = Math.max(...vals);
  const max = top > 0 ? top : 1;
  const pad = 1;
  const slot = (width - pad * 2) / data.length;
  const bw = Math.max(1, slot * 0.6);
  const gaps = data.length - vals.length;
  const latest = vals[vals.length - 1];
  const parts = [`${label}: ${vals.length} points, max ${fmtNum(top)}${unit}, latest ${fmtNum(latest)}${unit}`];
  if (gaps > 0) parts.push(`${gaps} ${gaps === 1 ? "hour" : "hours"} with no data`);
  const color = toneVar(tone);
  return (
    <svg className={cx("spark", "spark--bars", className)} role="img" aria-label={parts.join(", ")} width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      {data.map((v, i) => {
        if (v === null || !Number.isFinite(v)) return null;
        // A zero still shows as a 1 px stub, so "nothing matched" differs from "no data".
        const h = Math.max(1, (v / max) * (height - pad * 2));
        const x = pad + i * slot + (slot - bw) / 2;
        return <rect key={i} data-bar={i} x={x.toFixed(1)} y={(height - pad - h).toFixed(1)} width={bw.toFixed(1)} height={h.toFixed(1)} rx={0.5} fill={color} />;
      })}
    </svg>
  );
}
