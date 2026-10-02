import { Bell, Clock, FileText, Gauge, Rocket, ShieldCheck, XCircle } from "lucide-react";
import type { ActivityResponse } from "@shared/api";
import { MetricTile, Ring, Skeleton } from "@/components";
import { kpiView } from "./model";

/** The six figures across the top, each with its basis and a change against the period before. */
export function Kpis({ data }: { data: ActivityResponse | undefined }) {
  if (!data) {
    return (
      <section className="act__kpis" aria-label="Key figures" aria-busy="true">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} variant="tile" />
        ))}
      </section>
    );
  }
  const k = kpiView(data.kpis, data.previous);
  const pct = k.success.pct;
  const failedTone = k.failed.value > 0 ? "red" : "grey";
  const watchTone = k.watchman.value > 0 ? "amber" : "green";
  return (
    <section className="act__kpis" aria-label="Key figures">
      <div role="group" aria-label="Deploys">
        <MetricTile iconStyle="circle" icon={<Rocket size={22} />} label="Deploys" value={k.deploys.value} delta={k.deploys.delta} sub="successful deploys" />
      </div>
      <div role="group" aria-label="Median deploy duration">
        <MetricTile
          iconStyle="circle"
          icon={<Clock size={22} />}
          label="Median deploy duration"
          value={k.median.value}
          delta={k.median.delta}
          sub={k.median.value === null ? "no successful deploys" : `of ${k.deploys.value} ${k.deploys.value === 1 ? "deploy" : "deploys"}`}
        />
      </div>
      <div role="group" aria-label="Success rate">
        <MetricTile
          iconStyle="plain"
          tone="green"
          icon={pct === null ? <Gauge size={26} /> : <Ring label="Success rate" value={pct} tone={pct >= 90 ? "green" : pct >= 70 ? "amber" : "red"} size={40} stroke={4} />}
          label="Success rate"
          value={pct === null ? null : `${pct}%`}
          delta={k.success.delta}
          sub={pct === null ? "no finished runs" : `${k.success.success} successful / ${k.success.finished} total`}
        />
      </div>
      <div role="group" aria-label="Failed runs">
        <MetricTile
          iconStyle="circle"
          tone={failedTone}
          icon={<XCircle size={22} />}
          label="Failed runs"
          value={k.failed.value}
          delta={k.failed.delta}
          sub={k.failed.rate === null ? "no finished runs" : `${k.failed.rate}% failure rate`}
        />
      </div>
      <div role="group" aria-label="Config changes">
        <MetricTile iconStyle="circle" icon={<FileText size={22} />} label="Config changes" value={k.changes.value} delta={k.changes.delta} sub="dashboard changes logged" />
      </div>
      <div role="group" aria-label="Watchman problems">
        <MetricTile
          iconStyle="circle"
          tone={watchTone}
          icon={k.watchman.value > 0 ? <Bell size={22} /> : <ShieldCheck size={22} />}
          label="Watchman problems"
          value={k.watchman.value}
          delta={k.watchman.delta}
          sub={k.watchman.value === 0 ? "none in this period" : "failure, drift, cost or unreachable"}
        />
      </div>
    </section>
  );
}
