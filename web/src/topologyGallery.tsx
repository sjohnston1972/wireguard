// topologyGallery.tsx
//
// Plain English: a dev-only page, /__topology/:id (lab topology spec ruling
// 26), drawing any lab's planned graph in each canvas variant (full, tab,
// mini) with the toolbar, legend and details panel, so the canvas can be
// seen and shot before it is placed in the lab panel. It fits one screen (the
// one-screen rule: the canvases pan, the page never scrolls on a desktop).
// Like /__gallery it exists only under `npm run dev:web`: App.tsx imports it
// behind import.meta.env.DEV, so a build has neither. `?asset=` points it at
// another planned file (tests); `?select=<node id>` opens a node's details.

import { useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { usePlannedTopology, PLANNED_URLS } from "@/api/topology";
import { Canvas } from "@/views/labs/topology/Canvas";
import { Toolbar } from "@/views/labs/topology/Toolbar";
import { Details } from "@/views/labs/topology/Details";
import type { DiagramVariant } from "@/views/labs/topology/contract";
import type { TopologyGraph } from "@shared/topology/model";
import "./topologyGallery.css";

interface Shared {
  graph: TopologyGraph;
  search: string;
  deps: boolean;
  view: "diagram" | "list";
  selected: string | null;
  onSelect: (id: string | null) => void;
}

function Variant({ v, title, s }: { v: DiagramVariant; title: string; s: Shared }) {
  return (
    <section aria-label={title} className={`topo-gallery__variant topo-gallery__variant--${v}`}>
      <h2 className="topo-gallery__h">{title}</h2>
      <div className="topo-gallery__canvas">
        <Canvas
          graph={s.graph}
          status={{}}
          saved={null}
          view={v === "mini" ? "diagram" : s.view}
          showDependencies={s.deps}
          search={v === "mini" ? "" : s.search}
          variant={v}
          selected={v === "mini" ? null : s.selected}
          onSelect={v === "mini" ? () => {} : s.onSelect}
          {...(v === "mini" ? {} : { onMove: () => {} })}
        />
      </div>
    </section>
  );
}

export default function TopologyGallery() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const asset = params.get("asset");
  const q = usePlannedTopology(id, asset ? { [id]: asset } : PLANNED_URLS);
  const [selected, setSelected] = useState<string | null>(params.get("select"));
  const [search, setSearch] = useState("");
  const [deps, setDeps] = useState(true);
  const [view, setView] = useState<"diagram" | "list">("diagram");
  return (
    <div className="topo-gallery">
      <header className="topo-gallery__head">
        <h1 className="topo-gallery__title">Planned diagram: {id}</h1>
        <Toolbar source={null} search={search} onSearch={setSearch} showDependencies={deps} onDependencies={setDeps} view={view} onView={setView} variant="full" />
      </header>
      {q.isError && <p role="alert">{q.error.message}</p>}
      {q.data && (
        <div className="topo-gallery__body">
          <div className="topo-gallery__main">
            <Variant v="full" title="Full variant" s={{ graph: q.data, search, deps, view, selected, onSelect: setSelected }} />
            <Details graph={q.data} status={{}} nodeId={selected} onClose={() => setSelected(null)} />
          </div>
          <div className="topo-gallery__side">
            <Variant v="tab" title="Tab variant" s={{ graph: q.data, search, deps, view, selected, onSelect: setSelected }} />
            <Variant v="mini" title="Mini variant" s={{ graph: q.data, search, deps, view, selected, onSelect: setSelected }} />
          </div>
        </div>
      )}
    </div>
  );
}
