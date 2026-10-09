// views/labs/topology/static/architectureSvg.ts
//
// Plain English: a lab's planned diagram as one self-contained SVG file, for
// the lab readme (and its PDF). It is the interactive diagram drawn once,
// still: the same stacking (stacks.ts), the same packing (layout.ts, the
// fixed 9:5 shape, no saved positions), the same lines (edges/specs.ts for
// colours and label chips, edges/router.ts for every lane, port and label
// spot). Only the drawing differs: plain SVG shapes in the light theme's
// colours on a white page, the Azure icons the diagram uses copied into the
// file (so it shows anywhere: an <img>, a PDF, a printout), and a small
// legend under it when there are lines.
//
// Pure and deterministic: graph and sprite text in, the same bytes out. No
// DOM, no fonts measured: text is fitted with a character-width estimate
// that errs wide, so it never runs past its box.

import type { TopologyGraph, TopoNode } from "@shared/topology/model";
import { isGroupKind, sortGraph } from "@shared/topology/model";
import { KINDS } from "@shared/topology/kinds";
import { absoluteBoxes, CARD_H, CARD_W, HEADER, layoutTopology, SUBNET_HEADER } from "../layout";
import { stackGraph } from "../stacks";
import { cardProps, groupHeaderBits, IP_PROPS, nodeIndex, propText, rgChipsFor } from "../words";
import { edgeSpecs, sourceColours } from "../edges/specs";
import { edgeLabelText, routeAll, type RouterBox } from "../edges/router";
import { labelSize } from "../edges/labelSpot";

/** The light theme's colours (web/src/styles/themes.css), mixed onto white where the app mixes them. */
export const PALETTE = {
  page: "#ffffff",
  text: "#0f1b2d",
  text2: "#44546a",
  muted: "#5f6f86",
  border: "#c3cddb",
  outline: "#768498",
  tile: "#f4f7fb",
  azure: "#2563eb",
  rgFill: "#f9fbfd",
  vnetHead: "#eaf0fa",
  subnetHead: "#dae5f9",
  subnetBorder: "#97b3ed",
  series: ["#0b62b0", "#c2410c", "#047857", "#a3367f", "#a16207", "#6d28d9"],
} as const;

export const FONT = "'Segoe UI', 'Helvetica Neue', Arial, sans-serif";
export const MONO = "Consolas, 'Cascadia Mono', Menlo, monospace";
/** Room round the picture. */
const MARGIN = 24;

// ── Text ──────────────────────────────────────────────────────────────

const NARROW = new Set([..."iljtfr.,:;|!'`()[]{} -/"]);
const WIDE = new Set([..."mwMW@%"]);

/** About how wide `text` is drawn at `size` px: errs wide (Segoe UI, Helvetica and Arial all fit). */
export function textWidth(text: string, size: number, opts: { bold?: boolean; mono?: boolean } = {}): number {
  if (opts.mono) return text.length * size * 0.61;
  let em = 0;
  for (const c of text) em += NARROW.has(c) ? 0.34 : WIDE.has(c) ? 0.88 : c >= "A" && c <= "Z" ? 0.68 : c >= "0" && c <= "9" ? 0.57 : c === "…" ? 0.9 : c.charCodeAt(0) > 0x2000 ? 0.9 : 0.56;
  return em * size * (opts.bold ? 1.06 : 1);
}

/** `text`, cut short with an ellipsis to fit `room` px. */
export function fitText(text: string, room: number, size: number, opts: { bold?: boolean; mono?: boolean } = {}): string {
  if (textWidth(text, size, opts) <= room) return text;
  let s = text;
  while (s.length > 1 && textWidth(`${s}…`, size, opts) > room) s = s.slice(0, -1);
  return `${s.trimEnd()}…`;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const n = (v: number) => String(Math.round(v * 10) / 10);

// ── Words ─────────────────────────────────────────────────────────────

const PROPER = ["Route Server", "Container Apps", "App Service", "Cosmos", "Private Link", "Front Door", "Traffic Manager", "Log Analytics", "Service Bus", "Event Grid", "Recovery Services", "Virtual WAN", "Entra", "WireGuard", "Kubernetes", "VM", "VPN", "NAT", "DNS", "SQL", "WAF"];
/** A kind's word inside a sentence: "application gateway", but "VM", "Front Door". */
const inSentence = (w: string) => (PROPER.some((p) => w.startsWith(p)) ? w : w.charAt(0).toLowerCase() + w.slice(1));
const NUMBERS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const article = (w: string) => (/^[aeiou]/i.test(w) || /^[AEFHILMNORX][A-Z]/.test(w) ? "an" : "a");

/** "an application gateway", "two VMs". */
function counted(kind: TopoNode["kind"], count: number): string {
  const k = KINDS[kind];
  if (count === 1) {
    const w = inSentence(k.word);
    return `${article(w)} ${w}`;
  }
  return `${NUMBERS[count] ?? String(count)} ${inSentence(k.plural)}`;
}

/** "a, b and c". */
const listed = (parts: string[]) => (parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`);

/** Kinds of `nodes` counted, in the registry's order. */
function kindsOf(nodes: TopoNode[], max = 4): string[] {
  const counts = new Map<TopoNode["kind"], number>();
  for (const x of nodes) counts.set(x.kind, (counts.get(x.kind) ?? 0) + 1);
  const kinds = [...counts.keys()].sort((a, b) => KINDS[a].order - KINDS[b].order || (KINDS[a].word < KINDS[b].word ? -1 : 1));
  const shown = kinds.slice(0, max).map((k) => counted(k, counts.get(k)!));
  if (kinds.length > max) shown.push("more");
  return shown;
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * A short description of a planned graph for alt text: what sends traffic to what, else what there is, and where.
 * "An application gateway and a load balancer sending traffic to two VMs, in one resource group with one virtual
 * network and two subnets."
 */
export function describeGraph(graph: TopologyGraph): string {
  const byId = nodeIndex(graph);
  const assets = graph.nodes.filter((x) => !isGroupKind(x.kind) && x.kind !== "gateway");
  const isAsset = (id: string) => byId.has(id) && !isGroupKind(byId.get(id)!.kind) && byId.get(id)!.kind !== "gateway";
  const outs = new Set<string>();
  const ins = new Set<string>();
  for (const e of graph.edges) {
    if (e.kind !== "traffic" || e.from === e.to || !isAsset(e.from) || !isAsset(e.to)) continue;
    outs.add(e.from);
    ins.add(e.to);
  }
  const sources = assets.filter((x) => outs.has(x.id) && !ins.has(x.id));
  const sinks = assets.filter((x) => ins.has(x.id) && !outs.has(x.id));
  let what: string;
  if (sources.length && sinks.length) what = `${listed(kindsOf(sources, 3))} sending traffic to ${listed(kindsOf(sinks, 3))}`;
  else if (assets.length) what = listed(kindsOf(assets));
  else what = "no resources";
  const count = (k: TopoNode["kind"]) => graph.nodes.filter((x) => x.kind === k).length;
  const rgs = count("resourceGroup");
  const nets = count("vnet") + count("virtualHub");
  const subnets = count("subnet");
  const holders = [
    nets ? counted(count("vnet") ? "vnet" : "virtualHub", nets).replace(/^an? /, "one ") : null,
    subnets ? counted("subnet", subnets).replace(/^an? /, "one ") : null,
  ].filter((x): x is string => !!x);
  const where = rgs ? `${rgs === 1 ? "in one resource group" : `across ${NUMBERS[rgs] ?? rgs} resource groups`}${holders.length ? ` with ${listed(holders)}` : ""}` : "";
  return `${capital(what)}${where ? `, ${where}` : ""}.`;
}

// ── Icons ─────────────────────────────────────────────────────────────

/** The `<symbol>`s of the sprite by icon name ("virtual-machine"), as text. */
export function spriteSymbols(sprite: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of sprite.matchAll(/<symbol\b[^>]*\bid="az-([^"]+)"[^>]*>[\s\S]*?<\/symbol>/g)) out.set(m[1]!, m[0]);
  return out;
}

// ── Drawing ───────────────────────────────────────────────────────────

export interface ArchitectureSvg {
  svg: string;
  width: number;
  height: number;
  /** describeGraph's sentence. */
  description: string;
}

interface Abs {
  x: number;
  y: number;
  w: number;
  h: number;
}

const headOf = (k: TopoNode["kind"]) => (k === "subnet" ? SUBNET_HEADER : HEADER);

/** A rectangle with only its top corners rounded (a container's header strip). */
const topRounded = (x: number, y: number, w: number, h: number, r: number) =>
  `M${n(x)} ${n(y + h)}V${n(y + r)}Q${n(x)} ${n(y)} ${n(x + r)} ${n(y)}H${n(x + w - r)}Q${n(x + w)} ${n(y)} ${n(x + w)} ${n(y + r)}V${n(y + h)}Z`;

const icon = (name: string, x: number, y: number, size: number) => `<use href="#az-${name}" xlink:href="#az-${name}" x="${n(x)}" y="${n(y)}" width="${size}" height="${size}"/>`;

function chip(x: number, cy: number, text: string, opts: { size?: number; mono?: boolean } = {}): { svg: string; w: number } {
  const size = opts.size ?? 10.5;
  const w = textWidth(text, size, { mono: opts.mono }) + 14;
  const h = 17;
  return {
    w,
    svg: `<rect x="${n(x)}" y="${n(cy - h / 2)}" width="${n(w)}" height="${h}" rx="8.5" fill="${PALETTE.page}" stroke="${PALETTE.border}"/><text x="${n(x + 7)}" y="${n(cy + size * 0.36)}" font-size="${size}" fill="${PALETTE.text2}">${esc(text)}</text>`,
  };
}

function groupSvg(node: TopoNode, b: Abs, icons: Set<string>): string {
  const k = node.kind;
  const head = headOf(k);
  const out: string[] = [];
  const style = {
    resourceGroup: { r: 12, fill: PALETTE.rgFill, fillOpacity: 1, stroke: PALETTE.outline, width: 2, dash: "7 5", headFill: PALETTE.tile },
    vnet: { r: 12, fill: PALETTE.azure, fillOpacity: 0.05, stroke: PALETTE.azure, width: 1.5, dash: null, headFill: PALETTE.vnetHead },
    virtualHub: { r: 18, fill: PALETTE.azure, fillOpacity: 0.05, stroke: PALETTE.azure, width: 1.5, dash: null, headFill: PALETTE.vnetHead },
    subnet: { r: 10, fill: PALETTE.azure, fillOpacity: 0.08, stroke: PALETTE.subnetBorder, width: 1, dash: null, headFill: PALETTE.subnetHead },
    lane: { r: 6, fill: PALETTE.tile, fillOpacity: 0.7, stroke: PALETTE.outline, width: 1.5, dash: null, headFill: PALETTE.tile },
  }[k as "resourceGroup" | "vnet" | "virtualHub" | "subnet" | "lane"];
  const inset = style.width / 2;
  out.push(`<g class="group group--${k}">`);
  out.push(`<rect x="${n(b.x + inset)}" y="${n(b.y + inset)}" width="${n(b.w - 2 * inset)}" height="${n(b.h - 2 * inset)}" rx="${style.r}" fill="${style.fill}"${style.fillOpacity < 1 ? ` fill-opacity="${style.fillOpacity}"` : ""}/>`);
  out.push(`<path d="${topRounded(b.x + inset, b.y + inset, b.w - 2 * inset, head - inset, Math.max(2, style.r - inset))}" fill="${style.headFill}"/>`);
  out.push(`<rect x="${n(b.x + inset)}" y="${n(b.y + inset)}" width="${n(b.w - 2 * inset)}" height="${n(b.h - 2 * inset)}" rx="${style.r}" fill="none" stroke="${style.stroke}" stroke-width="${style.width}"${style.dash ? ` stroke-dasharray="${style.dash}"` : ""}/>`);
  if (k === "lane") out.push(`<path d="${topRounded(b.x, b.y, b.w, 3, 3)}" fill="${PALETTE.outline}"/>`);
  // The header: icon, name, mono address, chips; whatever does not fit is cut short or left out.
  const pad = k === "subnet" ? 10 : 12;
  const cy = b.y + head / 2;
  let x = b.x + pad;
  const right = b.x + b.w - pad;
  if (k !== "lane") {
    const name = KINDS[k].icon;
    icons.add(name);
    out.push(icon(name, x, cy - 8, 16));
    x += 22;
  }
  const lane = k === "lane";
  const nameSize = k === "subnet" ? 11.5 : lane ? 11 : 12;
  const label = lane ? node.label.toUpperCase() : node.label;
  const nameRoom = lane ? right - x : Math.max(40, Math.min(right - x, b.w * 0.5));
  const shown = fitText(label, nameRoom, nameSize, { bold: true });
  out.push(`<text x="${n(x)}" y="${n(cy + nameSize * 0.36)}" font-size="${nameSize}" font-weight="600"${lane ? ` fill="${PALETTE.text2}" letter-spacing="0.6"` : ` fill="${PALETTE.text}"`}>${esc(shown)}</text>`);
  x += textWidth(shown, nameSize, { bold: true }) + (lane ? shown.length * 0.6 : 0) + 6;
  const bits = groupHeaderBits(node);
  if (bits.sub && x + textWidth(bits.sub, 11, { mono: true }) <= right) {
    out.push(`<text x="${n(x)}" y="${n(cy + 4)}" font-size="11" font-family="${MONO}" fill="${PALETTE.text2}">${esc(bits.sub)}</text>`);
    x += textWidth(bits.sub, 11, { mono: true }) + 6;
  }
  const chips = k === "resourceGroup" ? rgChipsFor(node, b.w) : bits.chips;
  for (const c of chips) {
    const room = right - x;
    if (room < 40) break;
    const text = fitText(c, Math.min(220, room) - 14, 10.5);
    const got = chip(x, cy, text);
    out.push(got.svg);
    x += got.w + 6;
  }
  out.push(`</g>`);
  return out.join("");
}

function cardSvg(node: TopoNode, b: Abs, icons: Set<string>): string {
  const k = KINDS[node.kind];
  const stack = node.id.startsWith("stack:");
  const gateway = node.kind === "gateway";
  const out: string[] = [`<g class="card card--${node.kind}">`];
  if (stack) for (const d of [6, 3]) out.push(`<rect x="${n(b.x + d)}" y="${n(b.y + d)}" width="${b.w}" height="${b.h}" rx="10" fill="${PALETTE.page}" stroke="${PALETTE.border}"/>`);
  out.push(`<rect x="${n(b.x)}" y="${n(b.y + 1.5)}" width="${b.w}" height="${b.h}" rx="10" fill="#0f1b2d" fill-opacity="0.07"/>`);
  out.push(`<rect x="${n(b.x + 0.5)}" y="${n(b.y + 0.5)}" width="${b.w - 1}" height="${b.h - 1}" rx="10" fill="${gateway ? PALETTE.tile : PALETTE.page}" stroke="${PALETTE.border}"${gateway ? ` stroke-dasharray="5 4"` : ""}/>`);
  icons.add(k.icon);
  out.push(icon(k.icon, b.x + 10, b.y + 10, 32));
  const tx = b.x + 52;
  const room = b.w - 52 - 10;
  out.push(`<text x="${n(tx)}" y="${n(b.y + 23)}" font-size="12" font-weight="600" fill="${gateway ? PALETTE.text2 : PALETTE.text}">${esc(fitText(node.label, room, 12, { bold: true }))}</text>`);
  out.push(`<text x="${n(tx)}" y="${n(b.y + 39)}" font-size="11" fill="${PALETTE.text2}">${esc(fitText(stack ? k.plural : k.word, room, 11))}</text>`);
  // One or two key props on a line, the second only when the first leaves room.
  let x = tx;
  for (const [p, v] of cardProps(node)) {
    const mono = IP_PROPS.has(p);
    const text = propText(p, v);
    const left = tx + room - x;
    if (left < 30) break;
    const shown = fitText(text, left, 11, { mono });
    out.push(`<text x="${n(x)}" y="${n(b.y + 55)}" font-size="11"${mono ? ` font-family="${MONO}"` : ""} fill="${PALETTE.text2}">${esc(shown)}</text>`);
    x += textWidth(shown, 11, { mono }) + 8;
  }
  out.push(`</g>`);
  return out.join("");
}

/** The chip on a line: its border in the line's colour (dashed for a dependency), a line of text per label. */
function labelChip(at: { x: number; y: number }, text: string, colour: string | null, dependency: boolean): string {
  const lines = text.split("\n");
  const size = labelSize(text);
  const w = Math.max(size.w, ...lines.map((l) => textWidth(l, 10.5, { bold: !dependency }) + 16));
  const h = size.h;
  const x = at.x - w / 2;
  const y = at.y - h / 2;
  const out = [
    `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="9" fill="${PALETTE.page}" stroke="${colour ?? PALETTE.border}" stroke-width="1.5"${dependency ? ` stroke-dasharray="3 2"` : ""}/>`,
  ];
  lines.forEach((l, i) => {
    out.push(`<text x="${n(at.x)}" y="${n(y + 3 + 14 * i + 10.8)}" font-size="10.5"${dependency ? ` fill="${PALETTE.text2}" font-weight="500"` : ` fill="${PALETTE.text}" font-weight="600"`} text-anchor="middle">${esc(l)}</text>`);
  });
  return out.join("");
}

/**
 * The planned graph `graph` as a standalone SVG: `sprite` is the Azure icon sprite's text (icons/azure.svg), `title`
 * the SVG's <title>.
 */
export function architectureSvg(graph: TopologyGraph, opts: { sprite: string; title: string }): ArchitectureSvg {
  // In id order, as a planned file is stored (the colours follow the order the lines appear in).
  const stacked = stackGraph(sortGraph(graph)).graph;
  const byId = nodeIndex(stacked);
  const laid = layoutTopology(stacked, null);
  const abs = absoluteBoxes(laid);
  const description = describeGraph(graph);

  // Lines: the canvas's (dependencies shown, labels on), routed together exactly as the canvas routes them.
  const specs = edgeSpecs(stacked, byId);
  const boxes: RouterBox[] = laid.nodes.map((l) => {
    const b = abs.get(l.id)!;
    const group = isGroupKind(byId.get(l.id)!.kind);
    return { id: l.id, x: b.x, y: b.y, w: b.w, h: b.h, group, head: group ? headOf(byId.get(l.id)!.kind) : 0 };
  });
  const routes = routeAll({ boxes, edges: specs.map((s) => ({ id: s.edge.id, from: s.edge.from, to: s.edge.to, label: edgeLabelText({ label: s.label, showLabel: s.carriesLabel }) })) });

  const minX = Math.min(0, ...boxes.map((b) => b.x));
  const minY = Math.min(0, ...boxes.map((b) => b.y));
  const maxX = Math.max(CARD_W, ...boxes.map((b) => b.x + b.w));
  const maxY = Math.max(CARD_H, ...boxes.map((b) => b.y + b.h));
  // Labels and line stubs may stand a little outside the boxes.
  let x0 = minX;
  let y0 = minY;
  let x1 = maxX;
  let y1 = maxY;
  for (const r of routes.values()) for (const p of r.points) (x0 = Math.min(x0, p.x)), (y0 = Math.min(y0, p.y)), (x1 = Math.max(x1, p.x)), (y1 = Math.max(y1, p.y));

  const icons = new Set<string>();
  const body: string[] = [];
  // Containers (parents first), then the lines over their bodies, then the cards, then the label chips over all.
  for (const l of laid.nodes) {
    const node = byId.get(l.id)!;
    if (isGroupKind(node.kind)) body.push(groupSvg(node, abs.get(l.id)!, icons));
  }
  const colourHex = (c?: number) => (c ? PALETTE.series[(c - 1) % PALETTE.series.length]! : null);
  const markers = new Set<string>();
  for (const s of specs) {
    const r = routes.get(s.edge.id);
    if (!r) continue;
    const traffic = s.edge.kind === "traffic";
    const colour = colourHex(s.colour) ?? (traffic ? PALETTE.text2 : PALETTE.muted);
    const marker = traffic ? `arrow-${s.colour ?? 0}` : null;
    if (marker) markers.add(marker);
    body.push(
      `<path d="${r.path}" fill="none" stroke="${colour}" stroke-width="${traffic ? 2 : 1.2}"${traffic ? "" : ` stroke-dasharray="5 4"`} stroke-linejoin="round"${marker ? ` marker-end="url(#${marker})"` : ""}${marker && s.both ? ` marker-start="url(#${marker})"` : ""}/>`,
    );
  }
  for (const l of laid.nodes) {
    const node = byId.get(l.id)!;
    if (!isGroupKind(node.kind)) body.push(cardSvg(node, abs.get(l.id)!, icons));
  }
  for (const s of specs) {
    const r = routes.get(s.edge.id);
    const text = edgeLabelText({ label: s.label, showLabel: s.carriesLabel });
    if (!r?.label || !text) continue;
    const size = labelSize(text);
    (x0 = Math.min(x0, r.label.x - size.w / 2)), (x1 = Math.max(x1, r.label.x + size.w / 2)), (y0 = Math.min(y0, r.label.y - size.h / 2)), (y1 = Math.max(y1, r.label.y + size.h / 2));
    body.push(labelChip(r.label, text, colourHex(s.colour), s.edge.kind !== "traffic"));
  }

  // The legend: the line styles in use, and each traffic source's colour.
  const legend: string[] = [];
  const traffic = specs.some((s) => s.edge.kind === "traffic");
  const dependency = specs.some((s) => s.edge.kind === "dependency");
  const sources = sourceColours(stacked, byId);
  const items: { line: string; dash: boolean; text: string }[] = [];
  if (traffic) items.push({ line: PALETTE.text2, dash: false, text: "Traffic (solid)" });
  if (dependency) items.push({ line: PALETTE.muted, dash: true, text: "Dependency (dashed)" });
  // Two sources of one name (a subnet in each spoke): each named with its container.
  const twice = new Set(sources.map((s) => s.label).filter((l, i, all) => all.indexOf(l) !== i));
  for (const s of sources) {
    const parent = byId.get(byId.get(s.source)!.parent ?? "");
    items.push({ line: colourHex(s.colour)!, dash: false, text: `from ${s.label}${twice.has(s.label) && parent ? ` (${parent.label})` : ""}` });
  }
  const width0 = x1 - x0;
  let legendH = 0;
  if (items.length) {
    const top = y1 + 28;
    let lx = x0;
    let ly = top;
    legend.push(`<g class="legend" font-size="11.5" fill="${PALETTE.text2}">`);
    for (const it of items) {
      const w = 30 + textWidth(it.text, 11.5) + 22;
      if (lx > x0 && lx + w > x0 + Math.max(width0, 480)) {
        lx = x0;
        ly += 22;
      }
      legend.push(`<line x1="${n(lx)}" y1="${n(ly)}" x2="${n(lx + 24)}" y2="${n(ly)}" stroke="${it.line}" stroke-width="${it.dash ? 1.2 : 2}"${it.dash ? ` stroke-dasharray="5 4"` : ""}/>`);
      legend.push(`<text x="${n(lx + 30)}" y="${n(ly + 4)}">${esc(it.text)}</text>`);
      lx += w;
    }
    legend.push(`</g>`);
    legendH = ly - y1 + 10;
  }

  const vx = Math.floor(x0 - MARGIN);
  const vy = Math.floor(y0 - MARGIN);
  const width = Math.ceil(Math.max(x1 - x0, 480) + 2 * MARGIN);
  const height = Math.ceil(y1 - y0 + legendH + 2 * MARGIN);

  const symbols = spriteSymbols(opts.sprite);
  const defs: string[] = [];
  for (const name of [...icons].sort()) {
    const s = symbols.get(name);
    if (!s) throw new Error(`The icon sprite has no symbol az-${name}.`);
    defs.push(s);
  }
  for (const m of [...markers].sort()) {
    const c = colourHex(Number(m.slice("arrow-".length)) || undefined) ?? PALETTE.text2;
    defs.push(`<marker id="${m}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" markerUnits="strokeWidth" orient="auto-start-reverse"><path d="M0 0L10 5L0 10Z" fill="${c}"/></marker>`);
  }

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="${vx} ${vy} ${width} ${height}" role="img" aria-labelledby="t d" font-family="${FONT}">`,
    `<title id="t">${esc(opts.title)}</title>`,
    `<desc id="d">${esc(description)}</desc>`,
    `<defs>${defs.join("")}</defs>`,
    `<rect x="${vx}" y="${vy}" width="${width}" height="${height}" fill="${PALETTE.page}"/>`,
    ...body,
    ...legend,
    `</svg>`,
  ].join("\n");
  return { svg: svg + "\n", width, height, description };
}
