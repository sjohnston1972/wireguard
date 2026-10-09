// labs/guide.ts
//
// Plain English: a lab's printable guide, as one self-contained HTML page
// that Browser Rendering turns into the "Download PDF" file (labs/guidepdf.ts).
// It holds only the lab catalogue's own words, bundled with the Worker: the
// title, id, exams, level and type, the cost per hour, learning, deploy and
// session times, the objective and what you will learn, the diagrams
// (labs/guidediagrams.ts), the readme's sections with clickable Learn links,
// and the lab version and the date it was made. Never anything from a
// session, a setting or a secret: the builder is given no environment at all.
//
// Break-fix answers: the readme's collapsed "What was broken" is kept out of
// the guide's body. In its place a note points to a final page, "Answers",
// which starts on a page of its own and says it gives the fault away, so the
// printed guide stays a whole reference while the reader can still try first.
//
// Everything is escaped. Links are https only (labs-build refuses others;
// checked again here). Diagrams are embedded as <img> data: URIs, so an SVG
// can never run script or fetch anything while the PDF is drawn. Fonts are
// the browser's own: the page fetches nothing.

import type { LabDef, LabLearningDef, ReadmeBlock, ReadmeInline } from "../../../shared/labs";
import type { GuideDiagram } from "../../../shared/guides";

/** Bumped when the guide's layout or content changes, so every cached PDF is made again. */
export const GUIDE_FORMAT = 1;

/** The summary of a break-fix readme's answer (labs-build requires exactly this). */
export const ANSWER_SUMMARY = "What was broken";

export interface GuideInput {
  def: LabDef;
  readme: ReadmeBlock[];
  learning: LabLearningDef | null;
  diagrams: GuideDiagram[];
  /** Skill area key -> its official name (catalogue skillAreas). */
  skillAreaNames: Record<string, string>;
  /** The estimated £ per hour (live list prices where the lab has them); null when there is no estimate. */
  gbpH: number | null;
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
/** HTML-escape text (also safe inside a quoted attribute). */
export const esc = (s: string): string => String(s).replace(/[&<>"']/g, (c) => ESC[c]!);

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "9 October 2026" (UTC). */
export function guideDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

const safeHref = (href: string): string | null => {
  try {
    return new URL(href).protocol === "https:" ? href : null;
  } catch {
    return null;
  }
};

/** "£0.0082", "£0.042", "£0.42" (the app's precision: a small cost is never rounded to £0.00). */
function gbp(v: number): string {
  const a = Math.abs(v);
  const places = a === 0 || a >= 0.1 ? 2 : a >= 0.01 ? 3 : 4;
  return `£${a.toFixed(places)}`;
}

/** The cost: { main: "£0.022 per hour", sub: "about £0.05 for a 2 h session" }, or why there is no figure (sub null). */
export function costWords(gbpH: number | null, sessionH: number): { main: string; sub: string | null } {
  if (gbpH === null || !Number.isFinite(gbpH) || gbpH < 0) return { main: "Estimate unavailable", sub: null };
  if (gbpH === 0) return { main: "No hourly charge at list price", sub: null };
  const main = gbpH < 0.00005 ? "under £0.0001 per hour" : `${gbp(gbpH)} per hour`;
  const total = gbpH * sessionH;
  return { main, sub: total < 0.01 ? `under £0.01 for a ${sessionH} h session` : `about £${total.toFixed(2)} for a ${sessionH} h session` };
}

/** "1 h 15 min", "40 min", "2 h". */
export function minutesWords(n: number): string {
  const min = Math.max(0, Math.round(Number.isFinite(n) ? n : 0));
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

const LEVEL: Record<LabDef["level"], string> = { foundation: "Foundation", associate: "Associate", expert: "Expert" };
const TYPE: Record<LabDef["type"], string> = { explore: "Explore", "break-fix": "Break-fix" };

// ── Readme blocks ────────────────────────────────────────────────────────

function inline(x: ReadmeInline, showUrl: boolean): string {
  switch (x.t) {
    case "b":
      return `<strong>${esc(x.text)}</strong>`;
    case "code":
      return `<code>${esc(x.text)}</code>`;
    case "a": {
      const href = safeHref(x.href);
      if (!href) return esc(x.text);
      const link = `<a href="${esc(href)}">${esc(x.text)}</a>`;
      return showUrl ? `${link}<span class="url">${esc(href)}</span>` : link;
    }
    default:
      return esc(x.text);
  }
}
const inlines = (list: ReadmeInline[], showUrl = false) => list.map((x) => inline(x, showUrl)).join("");

/** A diagram as a figure: an <img> of the SVG, or a quiet "diagram unavailable" box. */
export function figure(d: GuideDiagram): string {
  const caption = `<figcaption>${esc(d.title)}</figcaption>`;
  if (!d.svg) return `<figure class="diagram diagram--missing"><div class="diagram__missing">Diagram unavailable</div>${caption}</figure>`;
  const b64 = base64Utf8(d.svg);
  return `<figure class="diagram"><img alt="${esc(d.title)}" src="data:image/svg+xml;base64,${b64}">${caption}</figure>`;
}

function base64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

interface Rendered {
  body: string;
  answers: ReadmeBlock[][];
}

/** The readme's blocks as HTML, the answer(s) set aside, the diagrams placed (architecture after "What it deploys", concepts before "Learn more"). */
function readmeHtml(blocks: ReadmeBlock[], diagrams: GuideDiagram[], top = true): Rendered {
  const arch = diagrams.filter((d) => d.kind === "architecture");
  const concepts = diagrams.filter((d) => d.kind === "concept");
  const answers: ReadmeBlock[][] = [];
  const out: string[] = [];
  let section = "";
  let archDone = arch.length === 0;
  let conceptsDone = concepts.length === 0;
  const placeArch = () => {
    if (archDone) return;
    archDone = true;
    out.push(`<section class="figures">${arch.map(figure).join("")}</section>`);
  };
  const placeConcepts = () => {
    if (conceptsDone) return;
    conceptsDone = true;
    out.push(`<section class="figures"><h2>Concepts</h2>${concepts.map(figure).join("")}</section>`);
  };
  const render = (list: ReadmeBlock[], nested: boolean) => {
    for (const b of list) {
      switch (b.t) {
        case "h":
          if (!nested && b.level <= 2) {
            if (section === "What it deploys") placeArch();
            if (b.text === "Learn more") placeConcepts();
            section = b.text;
          }
          out.push(nested || b.level === 3 ? `<h3>${esc(b.text)}</h3>` : `<h2>${esc(b.text)}</h2>`);
          break;
        case "p":
          out.push(`<p>${inlines(b.inlines)}</p>`);
          break;
        case "ul":
          out.push(`<ul${section === "Learn more" ? ' class="links"' : ""}>${b.items.map((it) => `<li>${inlines(it, section === "Learn more")}</li>`).join("")}</ul>`);
          break;
        case "code":
          out.push(`<pre><code>${esc(b.text)}</code></pre>`);
          break;
        case "details":
          if (b.summary === ANSWER_SUMMARY) {
            answers.push(b.blocks);
            out.push(`<p class="answer-note"><strong>The answer is on the last page, “Answers”.</strong> Try to find the fault yourself first.</p>`);
          } else {
            out.push(`<div class="details"><p class="details__summary">${esc(b.summary)}</p>`);
            render(b.blocks, true);
            out.push(`</div>`);
          }
          break;
      }
    }
  };
  // The readme opens with its own words (no heading): under "Overview", so they never read as part of the section above.
  if (blocks.length && blocks[0]!.t !== "h" && top) out.push("<h2>Overview</h2>");
  render(blocks, false);
  // A readme with no "What it deploys" or "Learn more" still gets its diagrams, after everything else.
  placeArch();
  placeConcepts();
  return { body: out.join("\n"), answers };
}

/** Answers' blocks (no further hiding: this page is the answer). */
function answersHtml(answers: ReadmeBlock[][]): string {
  if (!answers.length) return "";
  const inner = answers
    .map((blocks) => readmeHtml(blocks, [], false).body)
    .join("\n");
  return `<section class="answers"><h2>Answers</h2><p class="answers__warn">This page gives the break-fix fault away. Turn back if you have not looked for it yet.</p>${inner}</section>`;
}

// ── The page ─────────────────────────────────────────────────────────────

const CSS = `
@page { size: A4; margin: 16mm 16mm 18mm 16mm; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; color: #1d2430; font: 10pt/1.5 "Segoe UI", "Inter", "Helvetica Neue", Arial, "Liberation Sans", "DejaVu Sans", sans-serif; }
h1, h2, h3, h4 { color: #0f1722; line-height: 1.25; break-after: avoid; page-break-after: avoid; }
h1 { font-size: 21pt; margin: 2pt 0 6pt; letter-spacing: -0.01em; }
h2 { font-size: 13pt; margin: 18pt 0 6pt; padding-bottom: 3pt; border-bottom: 1px solid #d5dbe3; }
h3 { font-size: 11pt; margin: 12pt 0 4pt; }
h4 { font-size: 10pt; margin: 10pt 0 4pt; }
p { margin: 0 0 6pt; orphans: 3; widows: 3; }
ul { margin: 0 0 8pt; padding-left: 16pt; }
li { margin: 0 0 3pt; break-inside: avoid; }
a { color: #0b5cad; text-decoration: underline; text-decoration-thickness: 0.5pt; }
code { font: 8.6pt/1.4 "Cascadia Mono", Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace; background: #f1f4f8; border-radius: 3px; padding: 0 2pt; }
pre { margin: 4pt 0 10pt; padding: 7pt 9pt; background: #f6f8fb; border: 1px solid #e1e6ed; border-radius: 5px; white-space: pre-wrap; word-break: break-word; break-inside: avoid; page-break-inside: avoid; }
pre code { font-size: 7.6pt; background: none; padding: 0; }
.eyebrow { margin: 0; color: #4b5869; font-size: 9pt; letter-spacing: 0.04em; text-transform: uppercase; }
.eyebrow code { text-transform: none; letter-spacing: 0; font-size: 8.6pt; }
.summary { font-size: 11pt; color: #364152; margin-bottom: 10pt; }
.facts { width: 100%; border-collapse: collapse; margin: 8pt 0 6pt; break-inside: avoid; }
.facts td { width: 25%; vertical-align: top; padding: 6pt 8pt; border: 1px solid #d5dbe3; }
.facts .k { display: block; font-size: 7.6pt; text-transform: uppercase; letter-spacing: 0.05em; color: #5a6676; margin-bottom: 1pt; }
.facts .v { display: block; font-weight: 600; font-size: 10pt; }
.facts .s { display: block; font-size: 8.4pt; color: #4b5869; font-weight: 400; }
.meta { font-size: 8.8pt; color: #4b5869; margin: 0 0 4pt; }
.objective { margin: 12pt 0 4pt; padding: 8pt 11pt; border-left: 3pt solid #0b5cad; background: #f2f7fd; break-inside: avoid; }
.objective p { margin: 0; font-size: 10.5pt; }
.objective .k { display: block; font-size: 7.6pt; text-transform: uppercase; letter-spacing: 0.05em; color: #0b5cad; font-weight: 600; margin-bottom: 2pt; }
ul.learn { list-style: none; padding-left: 0; }
ul.learn li { padding-left: 14pt; position: relative; }
ul.learn li::before { content: "✓"; position: absolute; left: 0; color: #0b7a4b; font-weight: 700; }
.figures { margin: 8pt 0; }
.diagram { margin: 6pt 0 12pt; text-align: center; break-inside: avoid; page-break-inside: avoid; }
.diagram img { max-width: 100%; max-height: 205mm; }
.diagram figcaption { font-size: 8.6pt; color: #4b5869; margin-top: 3pt; }
.diagram__missing { padding: 18pt; border: 1px dashed #b8c1cd; border-radius: 5px; color: #5a6676; font-size: 9pt; }
ul.links li { break-inside: avoid; }
.url { display: block; font-size: 7.6pt; color: #5a6676; word-break: break-all; }
.answer-note { padding: 6pt 9pt; border: 1px solid #e5c97a; background: #fdf8e7; border-radius: 5px; break-inside: avoid; }
.details { margin: 4pt 0 10pt; padding: 6pt 9pt; border: 1px solid #e1e6ed; border-radius: 5px; }
.details__summary { font-weight: 600; }
.answers { break-before: page; page-break-before: always; }
.answers__warn { padding: 6pt 9pt; background: #fdecec; border: 1px solid #f0b4b4; border-radius: 5px; font-weight: 600; }
.colophon { margin-top: 18pt; padding-top: 6pt; border-top: 1px solid #d5dbe3; font-size: 8pt; color: #5a6676; }
`;

/** The guide as a complete HTML document. `generatedAt` is an ISO time. */
export function buildGuideHtml(g: GuideInput, generatedAt: string): string {
  const d = g.def;
  const { body, answers } = readmeHtml(g.readme, g.diagrams);
  const exams = d.exams.length ? d.exams.join(", ") : d.exam;
  const areas = d.skill_areas.map((k) => g.skillAreaNames[k] ?? k);
  const learning = g.learning;
  const cost = costWords(g.gbpH, d.timing.session_h);
  const fact = (k: string, v: string, s?: string | null) => `<td><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span>${s ? `<span class="s">${esc(s)}</span>` : ""}</td>`;
  const facts = `<table class="facts"><tr>${[
    fact("Estimated cost", cost.main, cost.sub),
    fact("Learning time", learning ? minutesWords(learning.learning_min) : "Not set"),
    fact("Deploy time", `about ${d.timing.deploy_min} min`, `tear-down about ${d.timing.destroy_min} min`),
    fact("Session", `${d.timing.session_h} h`, `extendable to ${d.timing.max_h} h`),
  ].join("")}</tr></table>`;
  const learn = learning
    ? `<div class="objective"><span class="k">Objective</span><p>${esc(learning.objective)}</p></div>
<h2>What you will learn</h2>
<ul class="learn">${learning.learn.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`
    : `<div class="objective"><span class="k">About this lab</span><p>${esc(d.summary)}</p></div>`;
  const date = guideDate(generatedAt);
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(`Lab ${d.number}: ${d.title} (${d.id}) guide`)}</title>
<style>${CSS}</style>
</head>
<body>
<header>
<p class="eyebrow">Lab ${d.number} · ${esc(exams)} · ${esc(LEVEL[d.level])} · ${esc(TYPE[d.type])} · <code>${esc(d.id)}</code></p>
<h1>${esc(d.title)}</h1>
<p class="summary">${esc(d.summary)}</p>
${facts}
<p class="meta">Skill areas: ${esc(areas.join("; "))}</p>
</header>
${learn}
<main>
${body}
</main>
${answersHtml(answers)}
<p class="colophon">${esc(d.id)} · lab version ${d.version} · guide generated ${esc(date)} by wg-admin. Costs are estimates at Azure list prices; check the dashboard before you deploy.</p>
</body>
</html>`;
}

/** Browser Rendering's page footer: the lab and its version, the date made, and "Page n of m". */
export function guideFooterTemplate(def: LabDef, generatedAt: string): string {
  const left = esc(`${def.id} · v${def.version} · generated ${guideDate(generatedAt)}`);
  return `<div style="width:100%;font-size:7.5pt;font-family:'Segoe UI',Arial,'Liberation Sans',sans-serif;color:#5a6676;padding:0 16mm;display:flex;justify-content:space-between;"><span>${left}</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`;
}
