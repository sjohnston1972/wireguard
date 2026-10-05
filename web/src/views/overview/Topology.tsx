import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Cloud, FlaskConical, Server, Users } from "lucide-react";
import type { LabSession, OverviewResponse } from "@shared/api";
import { Panel, StatusPill, cx, type PillStatus } from "@/components";
import { useWidget } from "@/widgets";
import { useAzureSummary } from "@/api/queries";
import { AzureDrawer, SshDrawer } from "./drawers";
import { PEERING_WORD } from "./labs";
import { regionFull, topology, type NodeStatus, type NodeView } from "./model";
import "./Topology.css";

const PILL: Record<NodeStatus, PillStatus> = { healthy: "healthy", degraded: "degraded", down: "down", unknown: "unknown" };

function Node({ title, icon, view, lines, onClick, className }: { title: string; icon: ReactNode; view: NodeView; lines: ReactNode[]; onClick: () => void; className?: string }) {
  const name = `${title}: ${view.word}${view.why && view.why !== view.word ? `, ${view.why}` : ""}`;
  return (
    <button type="button" className={cx("ov-node", className)} data-status={view.status} aria-label={name} onClick={onClick}>
      <span className="ov-node__icon" aria-hidden>
        {icon}
      </span>
      <span className="ov-node__text">
        <span className="ov-node__title">{title}</span>
        {lines.map((l, i) => (
          <span key={i} className="ov-node__line">
            {l}
          </span>
        ))}
        <span className="ov-node__word">
          <span className="ov-node__dot" aria-hidden />
          {view.word}
        </span>
      </span>
    </button>
  );
}

function Edge({ status, label }: { status: NodeStatus; label?: string }) {
  return (
    <span className="ov-edge" data-status={status} aria-hidden>
      {label && <span className="ov-edge__label">{label}</span>}
      <span className="ov-edge__line" />
    </span>
  );
}

/** Running labs beside the Azure VNet: a small box each, joined by a solid line when peered, a dashed one when waiting or disconnected, none when not peered. */
function LabBoxes({ labs }: { labs: LabSession[] }) {
  return (
    <ul className="ov-labs" aria-label="Running labs">
      {labs.map((s) => {
        const word = PEERING_WORD[s.peering];
        return (
          <li key={s.id} className="ov-lab">
            {s.peering !== "off" && <span className="ov-lab__edge" data-peering={s.peering} aria-hidden />}
            <Link className="ov-lab__box" to={`/labs/${s.labId}`} aria-label={`Lab ${s.title}: ${word}`} data-peering={s.peering}>
              <FlaskConical size={14} aria-hidden />
              <span className="ov-lab__text">
                <span className="ov-lab__title">{s.title}</span>
                <span className="ov-lab__word">{word}</span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** Clients → the WireGuard endpoint (the VM) → Azure, each node and edge coloured by health, with words. */
export function Topology({ o, now, compact }: { o: OverviewResponse; now: number; compact?: boolean }) {
  const navigate = useNavigate();
  const [drawer, setDrawer] = useState<"ssh" | "azure" | null>(null);
  const { settings: st } = useWidget("overview.topology");
  // Second lines: each node's lines under its title (counts, addresses, region).
  const lines = (l: ReactNode[]) => (st.secondLines ? l : []);
  const t = topology(o, useAzureSummary().data?.health);
  const s = o.snapshot;
  const running = s.state === "running";
  const region = s.region ?? o.config.region;
  return (
    <Panel title="Live topology" status={<StatusPill status={PILL[t.overall.status]} label={t.overall.word} variant="outline" />} className={cx("ov-topo", compact && "ov-topo--compact")} bodyClassName="ov-topo__body">
      <div className="ov-topo__map">
        <Node
          title="Clients"
          icon={<Users size={26} />}
          view={t.clients}
          onClick={() => navigate("/clients")}
          lines={lines([`${o.derived.clientsEnabled} configured`, running ? `${o.derived.clientsOnline} online` : "VM not running"])}
        />
        <Edge status={t.edges[0]} />
        <Node
          title="WireGuard endpoint"
          icon={<Server size={24} />}
          view={t.endpoint}
          className="ov-node--centre"
          onClick={() => setDrawer("ssh")}
          lines={lines([<span className="mono">{o.config.dnsName || "no name set"}</span>, <span className="mono">{o.config.subnet || "no subnet"}</span>])}
        />
        <Edge status={t.edges[1]} label={st.edgeLabels && o.config.port ? `UDP ${o.config.port}` : undefined} />
        <Node title="Microsoft Azure" icon={<Cloud size={26} />} view={t.azure} onClick={() => setDrawer("azure")} lines={lines([regionFull(region) || "no region", s.azure ? `${s.azure.resources.length} resources` : "not checked yet"])} />
        {o.labs.running.length > 0 && <LabBoxes labs={o.labs.running} />}
      </div>
      <SshDrawer o={o} open={drawer === "ssh"} onClose={() => setDrawer(null)} />
      <AzureDrawer o={o} now={now} open={drawer === "azure"} onClose={() => setDrawer(null)} />
    </Panel>
  );
}
