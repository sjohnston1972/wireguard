// views/labs/topology/viewport.ts
//
// Plain English: where the diagram's view starts (lab topology spec §9.2).
// Every placement (the tab, the full screen, the pop-out, the hover) draws the
// same layout (layout.ts LAYOUT_ASPECT); only this view differs: fitted to its
// own space, zoomed in to fill up to FIT_MAX_ZOOM. When it cannot fit
// without shrinking the cards below a readable size (the tab: 70%; the full
// screen and the phone: 60%), the view stops at that zoom and starts at the
// top-left of the picture (the gateway, the Global lane and the first
// resource group), clear of the panels, rather than in the middle of a wide
// picture; the rest is a pan away, and the full screen's fit button
// shows everything. Pure: bounds and size in, a React Flow viewport out.

import type { DiagramVariant } from "./contract";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

/** The smallest first-fit zoom where card names stay readable. */
export const MIN_FIT_ZOOM: Record<DiagramVariant, number> = { tab: 0.7, full: 0.6, mini: 0.05 };
/** On the phone: the same as the full screen (both are what a phone shows). */
export const PHONE_MIN_FIT_ZOOM = 0.6;
/**
 * The largest zoom a fit goes to: a small picture zooms in to use the space (Steven, 2026-10-08: "look at all the
 * space we have") rather than sitting at 100% in the middle. The mini hover stays at 100% at most.
 */
export const FIT_MAX_ZOOM: Record<DiagramVariant, number> = { tab: 1.75, full: 1.75, mini: 1 };
/** Padding around a fitted picture, as a share of the space (React Flow's fitView padding). */
export const FIT_PADDING: Record<DiagramVariant, number> = { tab: 0.08, full: 0.08, mini: 0.04 };
/** Where a picture too big to fit starts: clear of the canvas's top panels (Legend, Animate traffic). */
export const START_INSET = { left: 32, top: 56 } as const;
/** The canvas's top panels' height: a fitted picture is centred in the room below them. */
export const PANEL_RESERVE: Record<DiagramVariant, number> = { tab: 44, full: 44, mini: 0 };

/** The bounds of laid-out top-level boxes. */
export function boundsOf(boxes: readonly Rect[]): Rect | null {
  if (!boxes.length) return null;
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
}

/**
 * The first view of a picture with `bounds` in a `width` × `height` space:
 * fitted and centred at up to 100%, never below `minZoom`; a picture that
 * still does not fit at that zoom starts at the top-left inset.
 */
export function startViewport(bounds: Rect, width: number, height: number, opts: { padding: number; minZoom: number; maxZoom?: number; reserveTop?: number }): Viewport {
  const maxZoom = opts.maxZoom ?? 1;
  // A fitted picture sits below the canvas's top panels (Legend, Animate traffic), not under them.
  const top = Math.min(opts.reserveTop ?? 0, height / 4);
  const room = height - top;
  const fit = Math.min(width / (bounds.w * (1 + 2 * opts.padding)), room / (bounds.h * (1 + 2 * opts.padding)));
  const zoom = Math.max(opts.minZoom, Math.min(maxZoom, Number.isFinite(fit) && fit > 0 ? fit : maxZoom));
  // Too big either way at this zoom: start at the top-left corner, clear of the panels.
  const fits = bounds.w * zoom <= width && bounds.h * zoom <= room;
  if (!fits) return { x: START_INSET.left - bounds.x * zoom, y: START_INSET.top - bounds.y * zoom, zoom };
  return { x: (width - bounds.w * zoom) / 2 - bounds.x * zoom, y: top + (room - bounds.h * zoom) / 2 - bounds.y * zoom, zoom };
}

/** Where the picked node's details float over the diagram instead of stacking under it (SidePanel stacks up to 1099 px). */
export const DETAILS_FLOAT = "(min-width: 1100px)";
/** How much of the canvas's right-hand side the floating details cover (350 px panel, 10 px inset, a margin). */
export const DETAILS_COVER = 384;
/** The gap kept between a slid node and the canvas's left edge. */
export const DETAILS_MARGIN = 16;

/**
 * The view slid left just enough that a node (flow coordinates) clears the floating details, or null when it
 * already does. It never slides right, and never pushes the node's left edge past DETAILS_MARGIN: a node too
 * wide for the room stops at the left margin instead.
 */
export function slideClearOfDetails(node: { x: number; w: number }, vp: Viewport, canvasW: number, cover = DETAILS_COVER): Viewport | null {
  const left = node.x * vp.zoom + vp.x;
  const right = (node.x + node.w) * vp.zoom + vp.x;
  const over = right - (canvasW - cover);
  if (over <= 0) return null;
  const by = Math.min(over, left - DETAILS_MARGIN);
  if (by <= 0) return null;
  return { ...vp, x: vp.x - by };
}
