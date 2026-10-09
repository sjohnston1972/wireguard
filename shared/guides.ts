// shared/guides.ts
//
// Plain English: the contract for a lab guide's diagrams (the "Download PDF"
// lab guide). The readme diagrams are committed SVG files:
//
//   shared/guides/<lab id>/architecture.svg     the lab's architecture
//   shared/guides/<lab id>/<n>.svg              concept diagrams, 1.svg, 2.svg, ...
//   shared/guides/index.json                    lab id -> its diagrams, in order
//
// index.json is { "<lab id>": [{ "file": "architecture.svg", "title": "...", "kind": "architecture" }, ...] }.
// `npm run labs-build` reads them (scripts/lib/guides.mjs) into
// shared/guides.generated.json (gitignored), which the Worker bundles
// (worker/src/labs/guidediagrams.ts) to put them in the PDF. A listed file
// that is missing builds as "diagram unavailable" rather than stopping the build.
//
// Nothing here talks to anything: plain types and values.

export type GuideDiagramKind = "architecture" | "concept";
export const GUIDE_DIAGRAM_KINDS: readonly GuideDiagramKind[] = ["architecture", "concept"];

/** One entry of shared/guides/index.json. */
export interface GuideDiagramEntry {
  /** A file in shared/guides/<lab id>/: "architecture.svg" or "<n>.svg". */
  file: string;
  title: string;
  kind: GuideDiagramKind;
}

/** shared/guides/index.json: lab id -> its diagrams in reading order. */
export type GuideIndex = Record<string, GuideDiagramEntry[]>;

/** One diagram as the Worker bundles it: the entry plus the SVG text, or null when the file was missing or refused. */
export interface GuideDiagram extends GuideDiagramEntry {
  svg: string | null;
}

/** shared/guides.generated.json, written by labs-build. */
export interface GuideDiagrams {
  schema: 1;
  /** Lab id -> its diagrams; a lab with none has no entry. */
  labs: Record<string, GuideDiagram[]>;
}

/** The file names index.json may use. */
export const GUIDE_FILE_RE = /^(architecture|[1-9]\d?)\.svg$/;
/** The largest one SVG may be (bytes): the Worker bundles every one. */
export const GUIDE_SVG_MAX = 512 * 1024;
