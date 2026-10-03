import { ChevronRight, FlaskConical, Globe, Plus, Radio, ShieldBan } from "lucide-react";
import type { RefObject } from "react";
import { useNavigate } from "react-router-dom";
import type { FirewallResponse } from "@shared/api";
import type { Threshold } from "@shared/widgets";
import { Button, Sheet, cx } from "@/components";
import { LayoutMenu, useWidget } from "@/widgets";
import { DraftBar, policyView } from "./FirewallHeader";
import { DropsList } from "./Drops";
import { PortsList } from "./Ports";
import { CaptureForm, type CaptureFormHandle } from "./Capture";
import { SimulatorForm } from "./Simulator";
import { dropsLevel, fmtCount, shownDefault, type RuleView } from "./model";
import "./FirewallPhone.css";

export interface FirewallPhoneProps {
  fw: FirewallResponse;
  rows: RuleView[];
  waiting: boolean;
  updatedAt: number;
  sheet: string | null;
  onSheet: (s: string | null) => void;
  onReview: () => void;
  onAddRule: () => void;
  onAddForward: () => void;
  onEditForward: (f: FirewallResponse["forwards"][number]) => void;
  captureRef: RefObject<CaptureFormHandle | null>;
}

const SHEETS = {
  drops: "Recent drops",
  ports: "Published ports",
  capture: "Packet capture",
  test: "Test specific traffic",
} as const;
type SheetKey = keyof typeof SHEETS;

function Light({ label, value, tone }: { label: string; value: string; tone: "green" | "amber" | "red" | "grey" | "blue" }) {
  return (
    <li className="fw-ph__light">
      <span className={cx("fw-ph__dot", `fw-ph__dot--${tone}`)} aria-hidden />
      <span className="fw-ph__lbl">{label}</span>
      <span className="fw-ph__val">{value}</span>
    </li>
  );
}

/**
 * The phone's Firewall (spec §9): four lights, one line per rule opening its
 * sheet, buttons for drops, ports, capture and the simulator (each a sheet),
 * and the draft bar pinned above the tab bar. Widget settings apply here
 * too: the lights follow the Firewall figures tiles (and its drops
 * threshold), a hidden widget's button is gone, and the sheets show each
 * widget's content with its settings. The phone has no widget order.
 */
export function FirewallPhone({ fw, rows, waiting, sheet, onSheet, onReview, onAddRule, onAddForward, onEditForward, captureRef }: FirewallPhoneProps) {
  const navigate = useNavigate();
  const pv = policyView(fw.policy.state, fw.policy.text, waiting);
  const enabled = rows.filter((r) => r.enabled).length;
  const def = shownDefault(fw);
  const kpis = useWidget("firewall.kpis");
  const tiles = kpis.settings.tiles as string[];
  const level = dropsLevel(fw.drops.last24h, kpis.settings.drops as Threshold);
  const shown: Record<SheetKey, boolean> = {
    drops: !useWidget("firewall.drops").hidden,
    ports: !useWidget("firewall.ports").hidden,
    capture: !useWidget("firewall.capture").hidden,
    test: !useWidget("firewall.simulator").hidden,
  };
  const open = (sheet && sheet in SHEETS && shown[sheet as SheetKey] ? sheet : null) as SheetKey | null;

  return (
    <div className={cx("fw-ph", fw.draft && "fw-ph--draft")}>
      <header className="fw-ph__head">
        <h1 className="fw-ph__title">Firewall</h1>
        <span className={cx("fw-ph__state", `fw-ph__state--${pv.tone}`)}>{pv.word}</span>
        <LayoutMenu page="firewall" />
      </header>
      {(pv.tone === "red" || pv.tone === "amber") && <p className="fw-ph__detail">{pv.detail}</p>}
      <ul className="fw-ph__lights" aria-label="Firewall at a glance">
        <Light label="Applied" value={pv.word} tone={pv.tone} />
        {!kpis.hidden && tiles.includes("policy") && <Light label="Rules" value={`${enabled} of ${rows.length} on`} tone="blue" />}
        {!kpis.hidden && tiles.includes("drops") && (
          <Light
            label="Recent drops"
            value={`${fmtCount(fw.drops.last24h)} in 24 h${level ? ` · ${level.word}` : ""}`}
            tone={level ? level.tone : fw.drops.last24h > 0 ? "amber" : "green"}
          />
        )}
        {!kpis.hidden && tiles.includes("default") && <Light label="Default" value={def === "deny" ? "Deny" : "Allow"} tone={def === "deny" ? "red" : "green"} />}
      </ul>

      <section className="fw-ph__rules" aria-labelledby="fw-ph-rules">
        <div className="fw-ph__rules-head">
          <h2 id="fw-ph-rules" className="fw-ph__h2">
            Rules
          </h2>
          <Button size="sm" variant="primary" icon={<Plus size={14} aria-hidden />} onClick={onAddRule}>
            Add rule
          </Button>
        </div>
        <ul className="fw-ph__list">
          {rows.map((r) => (
            <li key={r.id}>
              <button type="button" className={cx("fw-ph__rule", !r.enabled && "fw-ph__rule--off")} onClick={() => navigate(`/firewall/rules/${r.id}`)}>
                <span className="fw-ph__place">{r.place}</span>
                <span className="fw-ph__rule-main">
                  <span className="fw-ph__rule-name">{r.name}</span>
                  <span className="fw-ph__rule-sub">
                    {r.fromLabel} → {r.toLabel} · {r.service}
                    {!r.enabled && " · off"}
                    {r.mark && ` · ${r.mark}`}
                  </span>
                </span>
                <span className={cx("fw-ph__act", `fw-ph__act--${r.action}`)}>{r.action === "allow" ? "Allow" : "Deny"}</span>
                <ChevronRight size={16} aria-hidden className="fw-ph__chev" />
              </button>
            </li>
          ))}
          <li className="fw-ph__rule fw-ph__rule--default">
            <span className="fw-ph__place">{rows.length + 1}</span>
            <span className="fw-ph__rule-main">
              <span className="fw-ph__rule-name">Default (catch all)</span>
              <span className="fw-ph__rule-sub">Anywhere → Anywhere · always last</span>
            </span>
            <span className={cx("fw-ph__act", `fw-ph__act--${def}`)}>{def === "allow" ? "Allow" : "Deny"}</span>
          </li>
        </ul>
      </section>

      <div className="fw-ph__more">
        {shown.drops && (
          <Button icon={<ShieldBan size={16} aria-hidden />} onClick={() => onSheet("drops")}>
            Drops
          </Button>
        )}
        {shown.ports && (
          <Button icon={<Globe size={16} aria-hidden />} onClick={() => onSheet("ports")}>
            Published ports
          </Button>
        )}
        {shown.capture && (
          <Button icon={<Radio size={16} aria-hidden />} onClick={() => onSheet("capture")}>
            Capture
          </Button>
        )}
        {shown.test && (
          <Button icon={<FlaskConical size={16} aria-hidden />} onClick={() => onSheet("test")}>
            Test traffic
          </Button>
        )}
      </div>

      {fw.draft && (
        <div className="fw-ph__dock">
          <DraftBar fw={fw} onReview={onReview} className="fw-ph__draftbar" pinned />
        </div>
      )}

      <Sheet open={open !== null} onOpenChange={(o) => !o && onSheet(null)} title={open ? SHEETS[open] : ""}>
        {open === "drops" && <DropsList fw={fw} />}
        {open === "ports" && (
          <div className="fw-ph__sheet-ports">
            <Button size="sm" variant="primary" icon={<Plus size={14} aria-hidden />} onClick={onAddForward}>
              Add published port
            </Button>
            <PortsList fw={fw} onAdd={onAddForward} onEdit={onEditForward} />
          </div>
        )}
        {open === "capture" && <CaptureForm ref={captureRef} fw={fw} />}
        {open === "test" && <SimulatorForm fw={fw} />}
      </Sheet>
    </div>
  );
}
