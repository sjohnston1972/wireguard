import { Bell, Clock, FileText, Gauge, Rocket, ShieldCheck, XCircle } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import type { ActivityResponse } from "@shared/api";
import type { Threshold } from "@shared/widgets";
import { MetricTile, Ring, Skeleton, cx, type Tone } from "@/components";
import { thresholdTone, useCornerHost, useWidget, WidgetCorner } from "@/widgets";
import { kpiView } from "./model";

type ToneName = "ok" | "warn" | "bad" | null;
const COLOURS = { warn: "amber", bad: "red" } as const;
const WORDS = { warn: "Warning", bad: "Critical" } as const;

/** A value and, after a coloured threshold, the word for it, shown beside the value so colour is never the only sign. */
function withWord(value: ReactNode, t: ToneName): ReactNode {
  if (t !== "warn" && t !== "bad") return value;
  return (
    <>
      {value} <span className={`act-kpi__word act-kpi__word--${COLOURS[t]}`}>{WORDS[t]}</span>
    </>
  );
}

/** The figures across the top, each with its basis and a change against the period before. */
export function Kpis({ data }: { data: ActivityResponse | undefined }) {
  const { settings } = useWidget("activity.kpis");
  const host = useCornerHost();
  const tiles = new Set(settings.tiles as string[]);
  const deltas = settings.deltas as boolean;
  const subLines = settings.subLines as boolean;
  const cols = { "--act-kpi-cols": tiles.size } as CSSProperties;
  if (!data) {
    return (
      <section className={cx("act__kpis", host)} style={cols} aria-label="Key figures" aria-busy="true">
        {Array.from({ length: tiles.size }, (_, i) => (
          <Skeleton key={i} variant="tile" />
        ))}
        <WidgetCorner />
      </section>
    );
  }
  const k = kpiView(data.kpis, data.previous);
  const pct = k.success.pct;
  const successTone = thresholdTone(pct, settings.successRate as Threshold, "below");
  const failedTone = thresholdTone(k.failed.value, settings.failedRuns as Threshold, "above");
  const watchTone = thresholdTone(k.watchman.value, settings.watchman as Threshold, "above");
  const ringTone: Tone = successTone === "warn" || successTone === "bad" ? COLOURS[successTone] : "green";
  const d = <T,>(x: T | undefined) => (deltas ? x : undefined);
  const sub = (s: string) => (subLines ? s : undefined);
  return (
    <section className={cx("act__kpis", host)} style={cols} aria-label="Key figures">
      {tiles.has("deploys") && (
        <div role="group" aria-label="Deploys">
          <MetricTile iconStyle="circle" icon={<Rocket size={22} />} label="Deploys" value={k.deploys.value} delta={d(k.deploys.delta)} sub={sub("successful deploys")} />
        </div>
      )}
      {tiles.has("duration") && (
        <div role="group" aria-label="Median deploy duration">
          <MetricTile
            iconStyle="circle"
            icon={<Clock size={22} />}
            label="Median deploy duration"
            value={k.median.value}
            delta={d(k.median.delta)}
            sub={sub(k.median.value === null ? "no successful deploys" : `of ${k.deploys.value} ${k.deploys.value === 1 ? "deploy" : "deploys"}`)}
          />
        </div>
      )}
      {tiles.has("success") && (
        <div role="group" aria-label="Success rate">
          <MetricTile
            iconStyle="plain"
            tone="green"
            icon={pct === null ? <Gauge size={26} /> : <Ring label="Success rate" value={pct} tone={ringTone} size={40} stroke={4} />}
            label="Success rate"
            value={pct === null ? null : withWord(`${pct}%`, successTone)}
            delta={d(k.success.delta)}
            sub={sub(pct === null ? "no finished runs" : `${k.success.success} successful / ${k.success.finished} total`)}
          />
        </div>
      )}
      {tiles.has("failed") && (
        <div role="group" aria-label="Failed runs">
          <MetricTile
            iconStyle="circle"
            tone={failedTone === "warn" || failedTone === "bad" ? COLOURS[failedTone] : "grey"}
            icon={<XCircle size={22} />}
            label="Failed runs"
            value={withWord(k.failed.value, failedTone)}
            delta={d(k.failed.delta)}
            sub={sub(k.failed.rate === null ? "no finished runs" : `${k.failed.rate}% failure rate`)}
          />
        </div>
      )}
      {tiles.has("config") && (
        <div role="group" aria-label="Config changes">
          <MetricTile iconStyle="circle" icon={<FileText size={22} />} label="Config changes" value={k.changes.value} delta={d(k.changes.delta)} sub={sub("dashboard changes logged")} />
        </div>
      )}
      {tiles.has("watchman") && (
        <div role="group" aria-label="Watchman problems">
          <MetricTile
            iconStyle="circle"
            tone={watchTone === "warn" || watchTone === "bad" ? COLOURS[watchTone] : "green"}
            icon={watchTone === "warn" || watchTone === "bad" ? <Bell size={22} /> : <ShieldCheck size={22} />}
            label="Watchman problems"
            value={withWord(k.watchman.value, watchTone)}
            delta={d(k.watchman.delta)}
            sub={sub(k.watchman.value === 0 ? "none in this period" : "failure, drift, cost or unreachable")}
          />
        </div>
      )}
      <WidgetCorner />
    </section>
  );
}
