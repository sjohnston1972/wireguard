// views/labs/topology/FlowCanvas.tsx
//
// Plain English: the lab diagram on React Flow (lab topology spec §9.2). The
// graph is stacked (big runs of one kind become one card), laid out by the
// packing layout for the canvas's measured shape (the saved arrangement wins)
// and drawn as nested boxes: resource groups holding VNets holding subnets
// holding resource cards, with traffic and dependency edges between them.
//
// Dragging a node (or moving the selected one with the arrow keys) tidies the
// picture and reports the move through onMove with the position relative to
// its parent and the parent's key; nothing in Azure changes. The first view
// fits the diagram, or, too big to read whole, starts at its top-left at a
// readable zoom (viewport.ts); it fits the search's matches on request
// (instantly under prefers-reduced-motion). The mini variant is a still
// picture: no pan, zoom, drag, selection or edge labels.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { EDGE_TYPES, PlacedLabels } from "./edges/TopoEdges";
import type { Box } from "./edges/labelSpot";
import { NODE_TYPES } from "./nodes/FlowNodes";
import { useSprite } from "./icons/sprite";
import { useFitRequests } from "./fitBus";
import { nodeIndex } from "./words";
import { boundsOf, FIT_PADDING, MIN_FIT_ZOOM, PANEL_RESERVE, PHONE_MIN_FIT_ZOOM, startViewport } from "./viewport";
import "./topology.css";

export const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
export { PHONE_MIN_FIT_ZOOM };

/** A canvas size in steps of 10%, so a small resize does not re-pack the picture. */
export const quantiseLength = (n: number): number => Math.round(1.1 ** Math.round(Math.log(n) / Math.log(1.1)));

interface Size {
  w: number;
  h: number;
}

export function FlowCanvas(props: CanvasProps) {
  const ref = useRef<HTMLDivElement>(null);
  // The space the diagram is shown in: the layout packs for its shape and the first view fits it. 0 × 0 where
  // nothing is laid out (tests): the fixed packing and React Flow's own fit.
  const [size, setSize] = useState<Size | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setSize((s) => (s && s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight }));
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} className={`topo-canvas topo-canvas--${props.variant}`} role="region" aria-label="Lab diagram">
      {size && (
        <ReactFlowProvider>
          <Flow {...props} size={size} />
        </ReactFlowProvider>
      )}
    </div>
  );
}

function Flow({ graph, status, saved, onMove, showDependencies, search, variant, selected, onSelect, deploying = false, size }: CanvasProps & { size: Size }) {
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
  const measured = size.w > 0 && size.h > 0;
  const qw = measured ? quantiseLength(size.w) : 0;
  const qh = measured ? quantiseLength(size.h) : 0;
  const aspect = measured ? `${qw}x${qh}` : undefined;
  const reserve = PANEL_RESERVE[variant];
  const laid = useMemo(() => layoutTopology(stacked, saved, measured ? { space: { w: qw, h: Math.max(1, qh - reserve) } } : {}), [stacked, saved, measured, qw, qh, reserve]);
  // Where each edge label went (labels keep off each other); a new picture places them afresh.
  const placedLabels = useMemo(() => new Map<string, Box>(), [laid]);
  const minZoom = mini ? MIN_FIT_ZOOM.mini : phone ? PHONE_MIN_FIT_ZOOM : MIN_FIT_ZOOM[variant];
  const fitOpts = useMemo(() => ({ padding: FIT_PADDING[variant], minZoom, maxZoom: 1, reserveTop: PANEL_RESERVE[variant] }), [variant, minZoom]);
  const startAt = useCallback(() => {
    const b = boundsOf(laid.nodes.filter((n) => !n.parent));
    return b ? startViewport(b, size.w, size.h, fitOpts) : { x: 0, y: 0, zoom: 1 };
  }, [laid, size.w, size.h, fitOpts]);
  // The first view: fitted, or (too big to fit readably) at the top-left. A new shape of space starts it again.
  const [firstView] = useState(() => (measured ? startAt() : undefined));
  const lastAspect = useRef(aspect);
  useEffect(() => {
    if (lastAspect.current === aspect || !measured) return;
    lastAspect.current = aspect;
    void rf.setViewport(startAt());
  }, [aspect, measured, rf, startAt]);
  const base = useMemo(() => toFlowNodes(laid, byId, { status, variant, selected, search, deploying }), [laid, byId, status, variant, selected, search, deploying]);
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
    <PlacedLabels.Provider value={placedLabels}>
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
        {...(firstView ? { defaultViewport: firstView } : { fitView: true, fitViewOptions: fitOpts })}
        minZoom={0.1}
        maxZoom={2}
        proOptions={{ hideAttribution: !full }}
      >
        {!mini && (
          <Panel position="top-right" className="topo-panel">
            <button type="button" className="topo-panel__button" aria-expanded={legendOpen} onClick={() => setLegendOpen((o) => !o)}>
              Legend
            </button>
            {legendOpen && <Legend graph={stacked} status={status} deploying={deploying} />}
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
    </PlacedLabels.Provider>
  );
}
