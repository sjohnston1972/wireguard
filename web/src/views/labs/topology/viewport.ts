// views/labs/topology/viewport.ts
//
// Plain English: where the diagram's view starts (lab topology spec §9.2).
// The layout is packed for the shape of the space it is shown in (the tab,
// the full screen, the hover), so the first view usually fits all of it.
// When it cannot without shrinking the cards below a readable size (the tab:
// 70%; the full screen and the phone: 60%), the view stops at that zoom and
// starts at the top-left of the picture (the gateway, the Global lane and the
// first resource group), clear of the panels, rather than in the middle of a
// wide picture; the rest is a pan away, and the full screen's fit button
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
