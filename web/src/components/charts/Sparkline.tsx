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
  /** Fill under the line. */
  area?: boolean;
  className?: string;
}

/** Inline SVG trend line. No data shows the words "no data", never a flat line. */
export function Sparkline({ data, label, unit = "", tone = "green", width = 90, height = 28, area = true, className }: SparklineProps) {
  const vals = data.filter((v): v is number => v !== null && Number.isFinite(v));
  if (vals.length === 0) {
    return <span className={cx("spark__nodata", className)}>no data</span>;
  }
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
