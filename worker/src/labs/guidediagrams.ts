// labs/guidediagrams.ts
//
// Plain English: the lab guides' diagrams this Worker knows (contract in
// shared/guides.ts). `npm run labs-build` reads shared/guides/ into
// shared/guides.generated.json and the Worker bundles it, like the lab
// catalogue: so the PDF's content hash is fixed at build time, the PDF route
// needs no other binding, and a new diagram reaches the guide with the next
// Worker deploy. Tests swap in their own with setGuideDiagramsForTest.

import generated from "../../../shared/guides.generated.json";
import type { GuideDiagram, GuideDiagrams } from "../../../shared/guides";

let override: GuideDiagrams | null = null;

/** One lab's diagrams in reading order ([] when it has none yet). */
export function guideDiagrams(id: string): GuideDiagram[] {
  const all = override ?? (generated as unknown as GuideDiagrams);
  return all.labs[id] ?? [];
}

/** Tests only: use these diagrams until called again with null. */
export function setGuideDiagramsForTest(d: GuideDiagrams | null): void {
  override = d;
}
