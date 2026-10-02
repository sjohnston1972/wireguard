import { Activity, BarChart3, FileText, Globe, ShieldAlert, ShieldCheck } from "lucide-react";
import { forwardRef, type ReactNode } from "react";
import type { FirewallResponse } from "@shared/api";
import { Button, MetricTile, Sparkline } from "@/components";
import { useDraftDefault } from "@/api/mutations";
import { dropDelta, fmtCount, shownDefault, type RuleView } from "./model";
import { NARROW, useMedia } from "./useMedia";
import "./KpiRow.css";

export interface KpiRowProps {
  fw: FirewallResponse;
  rows: RuleView[];
  onManageRules: () => void;
  onManagePorts: () => void;
  onStartCapture: () => void;
}

const Group = ({ label, children }: { label: string; children: ReactNode }) => (
  <div role="group" aria-label={label} className="fw-kpi">
    {children}
  </div>
);

/** Five tiles: policy set, default action (changing it edits the draft), drops in 24 h, published ports, capture. */
export const KpiRow = forwardRef<HTMLButtonElement, KpiRowProps>(function KpiRow({ fw, rows, onManageRules, onManagePorts, onStartCapture }, defaultBtn) {
  const setDefault = useDraftDefault();
  const narrow = useMedia(NARROW);
  const action = shownDefault(fw);
  const other = action === "deny" ? "allow" : "deny";
  const custom = rows.filter((r) => !r.starter).length;
  const delta = dropDelta(fw.drops.last24h, fw.drops.previous24h);
  const active = fw.forwards.filter((f) => f.enabled).length;
  const busy = fw.capture.busy;
  const n = rows.length;

  return (
    <div className="fw__kpis">
      <Group label="Policy set">
        <MetricTile
          iconStyle="square"
          icon={<FileText />}
          label="Policy set"
          value={`${n} ${n === 1 ? "rule" : "rules"}`}
          sub={`${custom} custom · ${n - custom} default`}
          action={
            <Button size="sm" onClick={onManageRules}>
              Manage
            </Button>
          }
        />
      </Group>
      <Group label="Default action">
        <MetricTile
          iconStyle="square"
          icon={action === "deny" ? <ShieldAlert /> : <ShieldCheck />}
          tone={action === "deny" ? "red" : "green"}
          label={fw.draft?.diff.defaultChanged ? "Default action (draft)" : "Default action"}
          value={action === "deny" ? "Deny" : "Allow"}
          valueTone
          sub={action === "deny" ? "Unmatched traffic is blocked" : "Unmatched traffic is allowed"}
          action={
            <Button ref={defaultBtn} size="sm" aria-label={`Change default action to ${other === "allow" ? "Allow" : "Deny"}`} loading={setDefault.isPending} onClick={() => setDefault.mutate({ action: other })}>
              Change
            </Button>
          }
        />
      </Group>
      <Group label="Recent drops (24h)">
        <MetricTile
          iconStyle="square"
          icon={<BarChart3 />}
          tone="red"
          label="Recent drops (24h)"
          value={fmtCount(fw.drops.last24h)}
          delta={delta ? { ...delta, good: delta.direction === "down" } : undefined}
          sub={`From ${fmtCount(fw.drops.uniqueSources24h)} unique ${fw.drops.uniqueSources24h === 1 ? "source" : "sources"}`}
          action={<Sparkline variant="bars" tone="blue" label="Drops per hour, last 24 hours" data={fw.drops.hourly24h} width={64} height={30} />}
        />
      </Group>
      <Group label="Published ports">
        <MetricTile
          iconStyle="square"
          icon={<Globe />}
          label="Published ports"
          value={`${active} active`}
          sub={fw.forwards.length > active ? `${fw.forwards.length - active} turned off` : "Changes apply at once"}
          action={
            <Button size="sm" onClick={onManagePorts}>
              Manage
            </Button>
          }
        />
      </Group>
      <Group label="Packet capture">
        <MetricTile
          iconStyle="square"
          icon={<Activity />}
          tone={busy ? "amber" : fw.running ? "green" : "grey"}
          label="Packet capture"
          value={busy ? "Running" : fw.running ? "Ready" : "Unavailable"}
          valueTone
          sub={fw.running ? "Capture and inspect traffic" : "Needs the VM running"}
          action={
            <Button size="sm" aria-label="Start capture: go to the capture form" onClick={onStartCapture}>
              {narrow ? "Start" : "Start capture"}
            </Button>
          }
        />
      </Group>
    </div>
  );
});
