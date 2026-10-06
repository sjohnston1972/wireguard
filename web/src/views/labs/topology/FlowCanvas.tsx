// views/labs/topology/FlowCanvas.tsx
//
// Plain English: the lab diagram on React Flow (lab topology spec §9.2). The
// graph is stacked (big runs of one kind become one card), laid out by the
// packing layout (the saved arrangement wins) and drawn as nested boxes:
// resource groups holding VNets holding subnets holding resource cards, with
// traffic and dependency edges between them.
//
// Dragging a node (or moving the selected one with the arrow keys) tidies the
// picture and reports the move through onMove with the position relative to
// its parent and the parent's key; nothing in Azure changes. The view fits
// the diagram on first render and fits the search's matches on request
// (instantly under prefers-reduced-motion). The mini variant is a still
// picture: no pan, zoom, drag, selection or edge labels.

import { useCallback, useMemo, useRef, useState } from "react";
import { applyNodeChanges, ConnectionMode, Controls, MiniMap, Panel, ReactFlow, ReactFlowProvider, useReactFlow, type NodeChange, type NodeSelectionChange, type OnNodeDrag } from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import { useTheme } from "@/shell/theme";
import { useMedia } from "@/lib/useMedia";
import { useIsPhone } from "@/components/layout/SidePanel";
import { Switch } from "@/components/forms/Switch";
import { Legend } from "./Legend";
import type { CanvasProps } from "./contract";
import { layoutTopology } from "./layout";
import { stackGraph } from "./stacks";
import { movesOf, searchSets, toFlowNodes, type TopoFlowNode } from "./flowNodes";
import { buildEdges } from "./edges/buildEdges";
import { EDGE_TYPES } from "./edges/TopoEdges";
import { NODE_TYPES } from "./nodes/FlowNodes";
import { useSprite } from "./icons/sprite";
import { useFitRequests } from "./fitBus";
import { nodeIndex } from "./words";
import "./topology.css";

export const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

export function FlowCanvas(props: CanvasProps) {
  return (
    <div className={`topo-canvas topo-canvas--${props.variant}`} role="region" aria-label="Lab diagram">
      <ReactFlowProvider>
        <Flow {...props} />
      </ReactFlowProvider>
    </div>
  );
}

function Flow({ graph, status, saved, onMove, showDependencies, search, variant, selected, onSelect }: CanvasProps) {
  useSprite();
  const theme = useTheme();
  const reduced = useMedia(REDUCED_MOTION);
  const rf = useReactFlow();
  const phone = useIsPhone();
  const mini = variant === "mini";
  const full = variant === "full";
  const [animate, setAnimate] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);

  const stacked = useMemo(() => stackGraph(graph).graph, [graph]);
  const byId = useMemo(() => nodeIndex(stacked), [stacked]);
  const laid = useMemo(() => layoutTopology(stacked, saved), [stacked, saved]);
  const base = useMemo(() => toFlowNodes(laid, byId, { status, variant, selected, search }), [laid, byId, status, variant, selected, search]);
  const sets = useMemo(() => searchSets(byId.values(), byId, search), [byId, search]);
  const edges = useMemo(
    () => buildEdges(stacked, byId, { showDependencies, labels: !mini, animate: full && animate, reducedMotion: reduced, dimmed: sets ? new Set([...byId.keys()].filter((id) => !sets.match.has(id))) : undefined }),
    [stacked, byId, showDependencies, mini, full, animate, reduced, sets],
  );

  // Local positions while dragging; a new layout (a refresh, a save, a reset) replaces them.
  const [nodes, setNodes] = useState<TopoFlowNode[]>(base);
  const [shown, setShown] = useState(base);
  if (shown !== base) {
    setShown(base);
    setNodes(base);
  }

  const dragging = useRef<Set<string>>(new Set());
  const latest = useRef({ byId, selected, onSelect, onMove });
  latest.current = { byId, selected, onSelect, onMove };

  const onNodesChange = useCallback((changes: NodeChange<TopoFlowNode>[]) => {
    const { byId, selected, onSelect, onMove } = latest.current;
    const picked = changes.find((c): c is NodeSelectionChange => c.type === "select" && c.selected);
    if (picked) onSelect(picked.id);
    else if (changes.some((c) => c.type === "select" && !c.selected && c.id === selected)) onSelect(null);
    const rest = changes.filter((c) => c.type !== "select");
    if (rest.length) setNodes((ns) => applyNodeChanges(rest, ns));
    if (onMove) {
      const moving = new Set(dragging.current);
      if (selected) moving.add(selected);
      for (const m of movesOf(rest, byId, moving)) onMove(m.key, m.at);
    }
  }, []);

  const onNodeDragStart: OnNodeDrag<TopoFlowNode> = useCallback((_e, node, all) => {
    dragging.current = new Set([node.id, ...all.map((n) => n.id)]);
  }, []);
  const onNodeDragStop: OnNodeDrag<TopoFlowNode> = useCallback(() => {
    dragging.current = new Set();
  }, []);

  const fitToSearch = useCallback(() => {
    const ids = sets ? [...sets.match] : [];
    void rf.fitView({ nodes: ids.length ? ids.map((id) => ({ id })) : undefined, duration: reduced ? 0 : 300, padding: 0.2, maxZoom: 1.25 });
  }, [rf, sets, reduced]);
  useFitRequests(fitToSearch);

  return (
    <ReactFlow<TopoFlowNode>
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      edgeTypes={EDGE_TYPES}
      onNodesChange={onNodesChange}
      onNodeDragStart={onNodeDragStart}
      onNodeDragStop={onNodeDragStop}
      onPaneClick={() => onSelect(null)}
      colorMode={theme}
      connectionMode={ConnectionMode.Loose}
      nodesConnectable={false}
      nodesDraggable={!mini && !!onMove}
      nodesFocusable={!mini}
      edgesFocusable={!mini}
      elementsSelectable={!mini}
      elevateNodesOnSelect={false}
      deleteKeyCode={null}
      selectionKeyCode={null}
      multiSelectionKeyCode={null}
      panOnDrag={!mini}
      zoomOnScroll={!mini}
      zoomOnPinch={!mini}
      zoomOnDoubleClick={!mini}
      panOnScroll={false}
      preventScrolling={!mini}
      fitView
      fitViewOptions={{ padding: mini ? 0.04 : 0.08, maxZoom: 1 }}
      minZoom={0.1}
      maxZoom={2}
      proOptions={{ hideAttribution: !full }}
    >
      {!mini && (
        <Panel position="top-right" className="topo-panel">
          <button type="button" className="topo-panel__button" aria-expanded={legendOpen} onClick={() => setLegendOpen((o) => !o)}>
            Legend
          </button>
          {legendOpen && <Legend graph={stacked} status={status} />}
        </Panel>
      )}
      {full && (
        <Panel position="top-left" className="topo-panel topo-panel--row">
          <label className="topo-panel__toggle">
            <Switch checked={animate && !reduced} onCheckedChange={setAnimate} label="Animate traffic" disabled={reduced} />
            <span aria-hidden="true">Animate traffic</span>
          </label>
        </Panel>
      )}
      {full && <Controls showInteractive={false} fitViewOptions={{ duration: reduced ? 0 : 200, padding: 0.08 }} />}
      {full && !phone && <MiniMap pannable zoomable className="topo-minimap" style={{ width: 160, height: 110 }} bgColor="var(--bg-panel)" maskColor="color-mix(in srgb, var(--bg-app) 60%, transparent)" nodeClassName={(n) => (n.type === "topoGroup" ? "topo-minimap__group" : "topo-minimap__asset")} />}
    </ReactFlow>
  );
}
