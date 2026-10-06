// views/labs/topology/Canvas.tsx
//
// Plain English: the lab diagram behind CanvasProps (contract.ts). It draws
// the List view when asked, or when the graph is too big to draw well (over
// LIST_VIEW_AT nodes, with a note and the diagram one click away), and the
// React Flow diagram otherwise.

import { useState } from "react";
import { LIST_VIEW_AT } from "@shared/topology/kinds";
import type { CanvasProps } from "./contract";
import { ListView } from "./ListView";
import { FlowCanvas } from "./FlowCanvas";
import "./topology.css";

export function Canvas(props: CanvasProps) {
  const { graph, status, selected, onSelect, view } = props;
  const [forceDiagram, setForceDiagram] = useState(false);
  const tooBig = graph.nodes.length > LIST_VIEW_AT;
  if (view === "list" || (tooBig && !forceDiagram)) {
    return (
      <div className="topo-canvas topo-canvas--list">
        {view === "diagram" && (
          <p role="note" className="topo-canvas__note">
            This lab has {graph.nodes.length} resources, too many to draw clearly, so it opens as a list.{" "}
            <button type="button" className="topo-canvas__link" onClick={() => setForceDiagram(true)}>
              Show the diagram
            </button>
          </p>
        )}
        <ListView graph={graph} status={status} selected={selected} onSelect={onSelect} search={props.search} />
      </div>
    );
  }
  return <FlowCanvas {...props} />;
}
