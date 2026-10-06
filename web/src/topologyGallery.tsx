// topologyGallery.tsx
//
// Plain English: a dev-only page, /__topology/:id (lab topology spec ruling
// 26), drawing any lab's planned graph in each canvas variant (tab, full,
// mini), so the canvas can be seen and shot before it is placed in the lab
// panel. Like /__gallery it exists only under `npm run dev:web`: App.tsx
// imports it behind import.meta.env.DEV, so a build has neither. `?asset=`
// points it at another planned file (tests). T1 may edit this page.

import { useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { usePlannedTopology, PLANNED_URLS } from "@/api/topology";
import { Canvas } from "@/views/labs/topology/Canvas";
import type { DiagramVariant } from "@/views/labs/topology/contract";

const VARIANTS: { v: DiagramVariant; title: string }[] = [
  { v: "tab", title: "Tab variant" },
  { v: "full", title: "Full variant" },
  { v: "mini", title: "Mini variant" },
];

export default function TopologyGallery() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const asset = params.get("asset");
  const q = usePlannedTopology(id, asset ? { [id]: asset } : PLANNED_URLS);
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <div style={{ display: "grid", gap: 24, padding: 16 }}>
      <h1>Planned diagram: {id}</h1>
      {q.isError && <p role="alert">{q.error.message}</p>}
      {q.data &&
        VARIANTS.map(({ v, title }) => (
          <section key={v} aria-label={title}>
            <h2>{title}</h2>
            <Canvas graph={q.data} status={{}} saved={null} view="diagram" showDependencies search="" variant={v} selected={selected} onSelect={setSelected} {...(v === "mini" ? {} : { onMove: () => {} })} />
          </section>
        ))}
    </div>
  );
}
