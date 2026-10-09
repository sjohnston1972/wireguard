# Readme concept diagrams

The hand-drawn ` ```text ` sketches in `labs/<id>/readme.md` are shown in the app (and the PDF) as diagrams instead:

- **Architecture** (every lab, automatic): `shared/guides/<id>/architecture.svg`, drawn from the lab's planned
  topology (`shared/topology/planned/<id>.json`) with the interactive diagram's own layout and line routing.
- **Concept** (where a sketch explains a path, a sequence, a hierarchy or a rule set): a Mermaid source here,
  `labs/_diagrams/<id>/<n>.mmd`, drawn to `shared/guides/<id>/<n>.svg`.

The readmes are never edited for this: `npm run labs-build` swaps each sketch for its diagrams by position
(`shared/guides/index.json`). These sources live outside the lab folders, so changing one never needs a lab
version bump. A fenced block that should stay as text (command output) uses another fence, such as ` ```console `.

## A source

```
%% title: Spoke to spoke goes through vm-router
%% alt: One or two plain sentences for a screen reader: what flows where, and why.
%% sketch: 0
flowchart TB
  ...
```

`title` and `alt` are required; `sketch` (which ` ```text ` block of the readme it replaces, 0 = the first) defaults
to 0. Labels are SVG text: `<br/>` for a new line, no other HTML; write a `<prefix>` name as `…kv`. Keep it small
(about 10 nodes, at most about 900 px wide) and use only facts from the readme and the lab's Terraform. Never show
a break-fix lab's fault.

## Drawing

`npm run labs-diagrams` writes the architecture SVGs and the index, and draws every concept SVG whose source
changed with the pinned Mermaid (`scripts/lib/mermaid.mjs`: downloaded once from the npm CDN and checked against
its SHA-256) in a hidden Edge or Chrome (`SHOTS_BROWSER=path` to choose one). `-- --render` draws them all again.
Commit `shared/guides` with the source: production builds and CI never need a browser.
`npm run labs-diagrams -- --check` (CI) fails on anything missing, stale or extra, a sketch with no diagram, an
SVG over 150 kB, or anything that looks like real data.
