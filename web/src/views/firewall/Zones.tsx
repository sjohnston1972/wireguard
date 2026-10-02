import type { FirewallResponse } from "@shared/api";
import { Panel, cx } from "@/components";
import { ZONE_ICON } from "./EndCell";
import { ZONE_ORDER, shownDefault, zoneFlow, type RuleView, type Zone } from "./model";
import "./Zones.css";

/**
 * Network zones: five cards in a row with an arrow between neighbours,
 * green when the rules (or the default) let the left zone reach the right
 * one, red when they block it. Clicking a zone filters the rules table.
 */
type ZonesProps = { fw: FirewallResponse; rows: RuleView[]; selected: Zone | "all"; onSelect: (z: Zone | "all") => void };

const Legend = () => (
  <span className="fw-zones__legend" aria-hidden>
    <span className="fw-zones__key fw-zones__key--allow" /> Allowed
    <span className="fw-zones__key fw-zones__key--deny" /> Blocked
  </span>
);

export function ZonesPanel(props: ZonesProps) {
  return (
    <Panel title="Network zones" className="fw-zones-panel" actions={<Legend />}>
      <p className="fw-panel-sub">How traffic flows between your networks. Click a zone to filter the rules.</p>
      <ZonesMap {...props} />
    </Panel>
  );
}

/** The zones on their own, for the right column's tabs on a short window. */
export function ZonesTab(props: ZonesProps) {
  return (
    <div className="fw-zones-tab">
      <Legend />
      <ZonesMap {...props} />
    </div>
  );
}

function ZonesMap({ fw, rows, selected, onSelect }: ZonesProps) {
  const def = shownDefault(fw);
  const zones = ZONE_ORDER.map((z) => fw.zones.find((x) => x.zone === z)).filter((z): z is FirewallResponse["zones"][number] => !!z);
  const ruleCount = (z: Zone) => rows.filter((r) => (r.from.kind === "zone" && r.from.value === z) || (r.to.kind === "zone" && r.to.value === z)).length;
  return (
    <div className="fw-zones">
      {zones.map((z, i) => {
        const Icon = ZONE_ICON[z.zone];
        const next = zones[i + 1];
        const flow = next ? zoneFlow(rows, def, z.zone, next.zone) : null;
        const n = ruleCount(z.zone);
        const on = selected === z.zone;
        return (
          <div key={z.zone} className="fw-zones__cell">
            <button type="button" className={cx("fw-zones__card", `fw-zones__card--${z.zone}`, on && "fw-zones__card--on")} aria-pressed={on} onClick={() => onSelect(on ? "all" : z.zone)}>
              <Icon className="fw-zones__icon" size={26} aria-hidden />
              <span className="fw-zones__label">{z.label}</span>
              <span className="fw-zones__addr">{z.negate ? "0.0.0.0/0" : (z.v4[0] ?? "")}</span>
              <span className="fw-zones__sub">
                {n} {n === 1 ? "rule" : "rules"}
              </span>
            </button>
            {next && flow && (
              <span className={cx("fw-zones__arrow", `fw-zones__arrow--${flow}`)}>
                <span className="visually-hidden">
                  {z.label} to {next.label}: {flow === "allow" ? "allowed" : "blocked"}
                </span>
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
