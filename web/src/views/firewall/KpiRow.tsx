import { Activity, BarChart3, FileText, Globe, ShieldAlert, ShieldCheck } from "lucide-react";
import { forwardRef, type ReactNode } from "react";
import type { FirewallResponse } from "@shared/api";
import type { Threshold } from "@shared/widgets";
import { Button, MetricTile, Sparkline, cx } from "@/components";
import { WidgetCorner, useWidget } from "@/widgets";
import { useDraftDefault } from "@/api/mutations";
import { NARROW, dropDelta, dropsLevel, fmtCount, shownDefault, type RuleView } from "./model";
import { useMedia } from "@/lib/useMedia";
import "./KpiRow.css";

export interface KpiRowProps {
  fw: FirewallResponse;
  rows: RuleView[];
  onManageRules: () => void;
  onManagePorts: () => void;
  /** Absent when the capture form is not on the page (its widget is hidden): the tile has no Start button. */
  onStartCapture?: () => void;
}

const Group = ({ label, children }: { label: string; children: ReactNode }) => (
  <div role="group" aria-label={label} className="fw-kpi">
    {children}
  </div>
);

/**
 * The "Firewall figures" widget: up to five tiles (policy set, default
 * action, which changing edits the draft, drops in 24 h, published ports,
 * capture). Its settings choose the tiles, the drops sparkline, the change
 * against the day before and the sub-lines, and an optional drops threshold
 * that colours the drops tile with a word.
 */
export const KpiRow = forwardRef<HTMLButtonElement, KpiRowProps>(function KpiRow({ fw, rows, onManageRules, onManagePorts, onStartCapture }, defaultBtn) {
  const setDefault = useDraftDefault();
  const narrow = useMedia(NARROW);
  const { settings } = useWidget("firewall.kpis");
  const tiles = settings.tiles as string[];
  const subLines = settings.subLines as boolean;
  const sub = (s: string) => (subLines ? s : undefined);
  const action = shownDefault(fw);
  const other = action === "deny" ? "allow" : "deny";
  const custom = rows.filter((r) => !r.starter).length;
  const delta = settings.deltas ? dropDelta(fw.drops.last24h, fw.drops.previous24h) : null;
  const level = dropsLevel(fw.drops.last24h, settings.drops as Threshold);
  const active = fw.forwards.filter((f) => f.enabled).length;
  const busy = fw.capture.busy;
  const n = rows.length;

  const all: Record<string, ReactNode> = {
    policy: (
      <Group key="policy" label="Policy set">
        <MetricTile
          iconStyle="square"
          icon={<FileText />}
          label="Policy set"
          value={`${n} ${n === 1 ? "rule" : "rules"}`}
          sub={sub(`${custom} custom · ${n - custom} default`)}
          action={
            <Button size="sm" onClick={onManageRules}>
              Manage
            </Button>
          }
        />
      </Group>
    ),
    default: (
      <Group key="default" label="Default action">
        <MetricTile
          iconStyle="square"
          icon={action === "deny" ? <ShieldAlert /> : <ShieldCheck />}
          tone={action === "deny" ? "red" : "green"}
          label={fw.draft?.diff.defaultChanged ? "Default action (draft)" : "Default action"}
          value={action === "deny" ? "Deny" : "Allow"}
          valueTone
          sub={sub(action === "deny" ? "Unmatched traffic is blocked" : "Unmatched traffic is allowed")}
          action={
            <Button ref={defaultBtn} size="sm" aria-label={`Change default action to ${other === "allow" ? "Allow" : "Deny"}`} loading={setDefault.isPending} onClick={() => setDefault.mutate({ action: other })}>
              Change
            </Button>
          }
        />
      </Group>
    ),
    drops: (
      <Group key="drops" label="Recent drops (24h)">
        <MetricTile
          iconStyle="square"
          icon={<BarChart3 />}
          tone={level?.tone ?? "red"}
          label="Recent drops (24h)"
          value={
            level ? (
              <>
                {fmtCount(fw.drops.last24h)} <span className="fw-kpi__word">{level.word}</span>
              </>
            ) : (
              fmtCount(fw.drops.last24h)
            )
          }
          valueTone={!!level}
          delta={delta ? { ...delta, good: delta.direction === "down" } : undefined}
          sub={sub(`From ${fmtCount(fw.drops.uniqueSources24h)} unique ${fw.drops.uniqueSources24h === 1 ? "source" : "sources"}`)}
          action={settings.sparkline ? <Sparkline variant="bars" tone="blue" label="Drops per hour, last 24 hours" data={fw.drops.hourly24h} width={64} height={30} /> : undefined}
        />
      </Group>
    ),
    ports: (
      <Group key="ports" label="Published ports">
        <MetricTile
          iconStyle="square"
          icon={<Globe />}
          label="Published ports"
          value={`${active} active`}
          sub={sub(fw.forwards.length > active ? `${fw.forwards.length - active} turned off` : "Changes apply at once")}
          action={
            <Button size="sm" onClick={onManagePorts}>
              Manage
            </Button>
          }
        />
      </Group>
    ),
    capture: (
      <Group key="capture" label="Packet capture">
        <MetricTile
          iconStyle="square"
          icon={<Activity />}
          tone={busy ? "amber" : fw.running ? "green" : "grey"}
          label="Packet capture"
          value={busy ? "Running" : fw.running ? "Ready" : "Unavailable"}
          valueTone
          sub={sub(fw.running ? "Capture and inspect traffic" : "Needs the VM running")}
          action={
            onStartCapture && (
              <Button size="sm" aria-label="Start capture: go to the capture form" onClick={onStartCapture}>
                {narrow ? "Start" : "Start capture"}
              </Button>
            )
          }
        />
      </Group>
    ),
  };

  return (
    <div className={cx("fw__kpis", tiles.length !== 5 && `fw__kpis--${tiles.length}`)}>
      {tiles.map((t) => all[t])}
      <WidgetCorner />
    </div>
  );
});
