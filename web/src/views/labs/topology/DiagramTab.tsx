// views/labs/topology/DiagramTab.tsx
//
// Plain English: a lab's diagram placed in the lab panel's Diagram tab (and,
// through Placement, the full-screen view; lab topology spec §9.1). It joins
// the data (planned, or live with ghosts while a session runs, with the
// fallback banner), the synced arrangement (useTopologyLayout), this
// device's choices (dependencies, Diagram/List) and the toolbar, and hands the
// canvas the contract's props. The toolbar is Toolbar (search's Enter fits
// the view through fitBus) and the details panel is Details, beside the
// canvas on a desktop and a sheet on the phone.

import { useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import type { LabSession } from "@shared/api";
import { Button, SplitView, cx } from "@/components";
import { Canvas } from "./Canvas";
import { Toolbar } from "./Toolbar";
import { Details } from "./Details";
import type { DiagramVariant } from "./contract";
import { useDevicePrefs, useDiagramData } from "./data";
import { useTopologyLayout } from "./useTopologyLayout";
import "./places.css";

export interface PlacementProps {
  labId: string;
  /** The lab's session while it holds Azure resources; null or absent when idle. */
  session?: LabSession | null;
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
      <SplitView className="topo-place__stage" panel={<Details graph={data.graph} status={data.status} nodeId={selected} onClose={() => setSelected(null)} deploying={data.deploying} />}>
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
      <Toolbar
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
