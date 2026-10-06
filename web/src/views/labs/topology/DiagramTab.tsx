// views/labs/topology/DiagramTab.tsx
//
// Plain English: a lab's diagram placed in the lab panel's Diagram tab (and,
// through Placement, the full-screen view; lab topology spec §9.1). It joins
// the data (planned, or live with ghosts while a session runs, with the
// fallback banner), the synced arrangement (useTopologyLayout), this
// device's choices (dependencies, Diagram/List) and the toolbar, and hands the
// canvas the contract's props.
//
// The toolbar and the details panel here are T2's stand-ins behind T1's
// ToolbarProps and DetailsProps (contract.ts); T1's Toolbar and Details take
// their place at integration, behind the same props.

import { useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { Maximize2 } from "lucide-react";
import type { LabSession } from "@shared/api";
import { KINDS } from "@shared/topology/kinds";
import { badgeOf } from "@shared/topology/diff";
import { usePlannedTopology } from "@/api/topology";
import { Button, KeyValue, SearchInput, SegmentedControl, SidePanel, SplitView, Switch, cx } from "@/components";
import { Canvas } from "./Canvas";
import type { DetailsProps, DiagramVariant, ToolbarProps } from "./contract";
import { useDevicePrefs, useDiagramData } from "./data";
import { useTopologyLayout } from "./useTopologyLayout";
import "./places.css";

export interface PlacementProps {
  labId: string;
  /** The lab's session while it holds Azure resources; null or absent when idle. */
  session?: LabSession | null;
}

// ── Stand-ins for T1's Toolbar and Details (same props) ──────────────────

/** The diagram's controls (T1's Toolbar replaces it behind ToolbarProps). */
export function StandInToolbar(p: ToolbarProps) {
  return (
    <div className={cx("topo-place__toolbar", `topo-place__toolbar--${p.variant}`)}>
      {p.source && p.onSource && (
        <SegmentedControl
          aria-label="Diagram source"
          items={[
            { value: "live", label: "Live", dot: "green" },
            { value: "planned", label: "Planned" },
          ]}
          value={p.source}
          onChange={(v) => p.onSource!(v as "live" | "planned")}
        />
      )}
      <SearchInput label="Search the diagram" value={p.search} onChange={p.onSearch} className="topo-place__search" />
      <span className="topo-place__switch">
        <Switch label="Show dependencies" checked={p.showDependencies} onCheckedChange={p.onDependencies} />
        <span aria-hidden>Dependencies</span>
      </span>
      <SegmentedControl
        aria-label="Diagram or list"
        items={[
          { value: "diagram", label: "Diagram" },
          { value: "list", label: "List" },
        ]}
        value={p.view}
        onChange={(v) => p.onView(v as "diagram" | "list")}
      />
      <span className="topo-place__end">
        {p.onReset && (
          <Button size="sm" variant="ghost" onClick={p.onReset}>
            Reset layout
          </Button>
        )}
        {p.fullScreenHref && (
          <Link className="topo-place__link" to={p.fullScreenHref}>
            <Maximize2 size={13} aria-hidden />
            Full screen
          </Link>
        )}
        {p.onClose && (
          <Button size="sm" variant="secondary" onClick={p.onClose}>
            Close
          </Button>
        )}
      </span>
    </div>
  );
}

const BADGE_MEANING: Record<string, string> = {
  "Added by hand": "In the lab's resource groups but not in its Terraform: made by hand during the session.",
  "Made by Azure": "Made by Azure itself for something the lab deployed (not by hand, not by Terraform).",
  "Not deployed or removed": "In the lab's Terraform but not found in Azure: not deployed, or removed by hand.",
  "Not deployed yet": "In the lab's Terraform; the deploy has not made it yet.",
  "Not listed by the live view": "A kind the live view cannot list (or outside the lab's groups), so it is shown from the plan.",
};

/** The selected node's details (T1's Details replaces it behind DetailsProps). A Sheet on the phone (SidePanel does that). */
export function StandInDetails({ graph, status, nodeId, onClose, deploying }: DetailsProps & { deploying?: boolean }) {
  const n = nodeId ? graph.nodes.find((x) => x.id === nodeId) : undefined;
  const badge = n && status[n.key] ? badgeOf(status[n.key]!, { deploying }) : null;
  return (
    <SidePanel open={!!n} onClose={onClose} title={n?.label ?? ""} subtitle={n ? KINDS[n.kind].word : undefined} className="topo-place__details">
      {n && (
        <KeyValue
          items={[
            ...(n.health ? [{ label: "Health", value: n.health.word }] : []),
            ...(n.armType ? [{ label: "Type", value: n.armType, mono: true }] : []),
            ...(badge ? [{ label: badge, value: BADGE_MEANING[badge] ?? "" }] : []),
          ]}
        />
      )}
    </SidePanel>
  );
}

// ── The placement ────────────────────────────────────────────────────────

/**
 * A lab's diagram with its controls, for the tab ("tab") and the full screen
 * ("full"). `header` goes above the toolbar (the full screen's title).
 */
export function Placement({ labId, session = null, variant, onClose, header }: PlacementProps & { variant: Exclude<DiagramVariant, "mini">; onClose?: () => void; header?: ReactNode }) {
  const { search: query } = useLocation();
  const [source, setSource] = useState<"live" | "planned">("live");
  const data = useDiagramData(labId, session, { source });
  const layout = useTopologyLayout(labId);
  const [device, setDevice] = useDevicePrefs();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  let body: ReactNode;
  if (data.error) {
    body = (
      <div className="topo-place__error" role="alert">
        <span>Could not load the diagram: {data.error}</span>
        <Button size="sm" variant="secondary" onClick={data.retry}>
          Try again
        </Button>
      </div>
    );
  } else if (!data.graph || layout.status === "loading") {
    body = (
      <p className="topo-place__loading" role="status">
        Loading the diagram…
      </p>
    );
  } else {
    body = (
      <SplitView className="topo-place__stage" panel={<StandInDetails graph={data.graph} status={data.status} nodeId={selected} onClose={() => setSelected(null)} deploying={data.deploying} />}>
        <div className="topo-place__canvas">
          <Canvas
            graph={data.graph}
            status={data.status}
            saved={layout.saved}
            onMove={layout.move}
            view={device.view}
            showDependencies={device.showDependencies}
            search={search}
            variant={variant}
            selected={selected}
            onSelect={setSelected}
            deploying={data.deploying}
          />
        </div>
      </SplitView>
    );
  }

  const notes = [data.note, layout.note, ...(data.graph?.notes ?? [])].filter((x): x is string => !!x);
  return (
    <div className={cx("topo-place", `topo-place--${variant}`)}>
      {header}
      <StandInToolbar
        variant={variant}
        source={data.live ? source : null}
        onSource={data.live ? setSource : undefined}
        search={search}
        onSearch={setSearch}
        showDependencies={device.showDependencies}
        onDependencies={(b) => setDevice({ showDependencies: b })}
        view={device.view}
        onView={(v) => setDevice({ view: v })}
        onReset={layout.reset}
        fullScreenHref={variant === "tab" ? `/labs/${encodeURIComponent(labId)}/diagram${query}` : undefined}
        onClose={onClose}
      />
      {data.banner && (
        <p className="topo-place__banner" role="status">
          {data.banner}
        </p>
      )}
      {body}
      {notes.length > 0 && (
        <ul className="topo-place__notes">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The Diagram tab beside the readme. */
export function DiagramTab(props: PlacementProps) {
  return <Placement {...props} variant="tab" />;
}

/** The planned graph of `labId` drawn in one variant, with nothing else (T0's stub; the mini until T2.6). */
export function PlannedDiagram({ labId, variant }: PlacementProps & { variant: DiagramVariant }) {
  const q = usePlannedTopology(labId);
  const [selected, setSelected] = useState<string | null>(null);
  if (q.isError) return <p role="alert">Could not load the diagram: {q.error.message}</p>;
  if (!q.data) return <p>Loading the diagram…</p>;
  return <Canvas graph={q.data} status={{}} saved={null} view="list" showDependencies search="" variant={variant} selected={selected} onSelect={setSelected} />;
}
