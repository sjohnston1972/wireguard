// views/labs/topology/LabMini.tsx
//
// Plain English: the mini diagram in the Overview's hover over a running lab
// (lab topology spec §9.1): the canvas's mini variant (icons and names only,
// no pan, zoom or drag), the saved arrangement, the live graph (the cached
// query the lab panel uses; the planned graph when the live view fails) and
// a caption: "Live · 14 resources · Open the lab".

import { useTopologyLayoutQuery } from "@/api/topology";
import { isAssetKind } from "@shared/topology/kinds";
import { Canvas } from "./Canvas";
import type { PlacementProps } from "./DiagramTab";
import { useDiagramData } from "./data";
import "./places.css";

const ABSENT = new Set(["missing", "unlisted"]);
const noSelect = () => {};

export function LabMini({ labId, session = null }: PlacementProps) {
  const data = useDiagramData(labId, session);
  const layout = useTopologyLayoutQuery(labId);
  if (data.error) return <p className="topo-mini__caption">The diagram did not load: {data.error}</p>;
  if (!data.graph)
    return (
      <p className="topo-mini__caption" role="status">
        Loading the diagram…
      </p>
    );
  const count = data.graph.nodes.filter((n) => isAssetKind(n.kind) && !ABSENT.has(data.status[n.key] ?? "")).length;
  const words = [data.source === "live" ? "Live" : "Planned", `${count} ${count === 1 ? "resource" : "resources"}`, ...(data.live && data.source !== "live" && data.banner ? ["live view unavailable"] : []), "Open the lab"];
  return (
    <div className="topo-mini">
      <div className="topo-mini__canvas">
        <Canvas
          graph={data.graph}
          status={data.status}
          saved={layout.data?.layout ?? null}
          view="diagram"
          showDependencies={false}
          search=""
          variant="mini"
          selected={null}
          onSelect={noSelect}
          deploying={data.deploying}
        />
      </div>
      <p className="topo-mini__caption">{words.join(" · ")}</p>
    </div>
  );
}
