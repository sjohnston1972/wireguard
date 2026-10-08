// Where the diagram's first view starts (viewport.ts): fitted and centred when the picture fits readably, otherwise at
// the readable zoom from the top-left (the phone's first view used to sit in the middle of a wide picture).
import { describe, expect, it } from "vitest";
import { boundsOf, DETAILS_COVER, DETAILS_FLOAT, DETAILS_MARGIN, FIT_MAX_ZOOM, MIN_FIT_ZOOM, PHONE_MIN_FIT_ZOOM, slideClearOfDetails, START_INSET, startViewport } from "./viewport";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const placesCss = readFileSync(join(HERE, "places.css"), "utf8");
const sidePanelCss = readFileSync(join(HERE, "../../../components/layout/SidePanel.css"), "utf8");
const flowSource = readFileSync(join(HERE, "FlowCanvas.tsx"), "utf8");

describe("startViewport", () => {
  it("a picture that fits is centred at up to 100%", () => {
    const v = startViewport({ x: 0, y: 0, w: 400, h: 200 }, 1000, 600, { padding: 0.08, minZoom: 0.6 });
    expect(v.zoom).toBe(1);
    expect(v).toEqual({ x: 300, y: 200, zoom: 1 });
  });

  it("a picture that fits below 100% is fitted with the padding and centred", () => {
    const v = startViewport({ x: 0, y: 0, w: 2000, h: 500 }, 1160, 600, { padding: 0.08, minZoom: 0.3 });
    expect(v.zoom).toBeCloseTo(0.5, 5);
    expect(v.x).toBeCloseTo((1160 - 1000) / 2, 5);
    expect(v.y).toBeCloseTo((600 - 250) / 2, 5);
  });

  it("on the phone a wide picture starts at the top-left at the readable zoom, not in the middle", () => {
    const v = startViewport({ x: 0, y: 0, w: 2300, h: 600 }, 358, 510, { padding: 0.08, minZoom: PHONE_MIN_FIT_ZOOM });
    expect(v.zoom).toBe(PHONE_MIN_FIT_ZOOM);
    expect(v.x).toBe(START_INSET.left);
    expect(v.y).toBe(START_INSET.top);
  });

  it("bounds that do not start at 0 still start at their own top-left corner", () => {
    const v = startViewport({ x: -100, y: 50, w: 3000, h: 3000 }, 550, 445, { padding: 0.08, minZoom: MIN_FIT_ZOOM.tab });
    expect(v.zoom).toBe(0.7);
    expect(v.x).toBeCloseTo(START_INSET.left + 70, 5);
    expect(v.y).toBeCloseTo(START_INSET.top - 35, 5);
  });

  it("too big on either axis: both start at the top-left inset", () => {
    const v = startViewport({ x: 0, y: 0, w: 3000, h: 200 }, 550, 445, { padding: 0.08, minZoom: 0.7 });
    expect(v).toEqual({ x: START_INSET.left, y: START_INSET.top, zoom: 0.7 });
  });

  it("a fitted picture is centred below the canvas's top panels, not under them", () => {
    const v = startViewport({ x: 0, y: 0, w: 400, h: 200 }, 1000, 600, { padding: 0.08, minZoom: 0.6, reserveTop: 44 });
    expect(v).toEqual({ x: 300, y: 44 + (556 - 200) / 2, zoom: 1 });
  });

  it("the tab reads at 70% or more; the full screen and the phone at 60%", () => {
    expect(MIN_FIT_ZOOM.tab).toBe(0.7);
    expect(MIN_FIT_ZOOM.full).toBe(0.6);
    expect(PHONE_MIN_FIT_ZOOM).toBe(0.6);
  });

  it("fit zooms in to use the space: the tab and the full screen up to 175-200%, the mini at 100%", () => {
    expect(FIT_MAX_ZOOM.full).toBeGreaterThanOrEqual(1.75);
    expect(FIT_MAX_ZOOM.full).toBeLessThanOrEqual(2);
    expect(FIT_MAX_ZOOM.tab).toBeGreaterThanOrEqual(1.5);
    expect(FIT_MAX_ZOOM.mini).toBe(1);
    const v = startViewport({ x: 0, y: 0, w: 400, h: 200 }, 1000, 600, { padding: 0.08, minZoom: 0.6, maxZoom: FIT_MAX_ZOOM.full });
    expect(v.zoom).toBe(FIT_MAX_ZOOM.full);
  });

  it("boundsOf is the box round the top-level boxes", () => {
    expect(boundsOf([])).toBeNull();
    expect(boundsOf([{ x: 0, y: 0, w: 10, h: 10 }, { x: 50, y: -5, w: 10, h: 40 }])).toEqual({ x: 0, y: -5, w: 60, h: 40 });
  });
});

describe("slideClearOfDetails (the floating details cover the canvas's right-hand side)", () => {
  const vp = { x: 0, y: 0, zoom: 1 };
  it("a node clear of the details leaves the view alone", () => {
    expect(slideClearOfDetails({ x: 100, w: 200 }, vp, 1200)).toBeNull();
    expect(1200 - DETAILS_COVER).toBeGreaterThanOrEqual(300);
  });
  it("a node under the details slides left just enough (zoom counted), y and zoom kept", () => {
    const room = 1200 - DETAILS_COVER;
    expect(slideClearOfDetails({ x: room - 100, w: 200 }, vp, 1200)).toEqual({ x: -100, y: 0, zoom: 1 });
    expect(slideClearOfDetails({ x: 500, w: 200 }, { x: 20, y: 7, zoom: 0.5 }, 700)).toEqual({ x: 20 - (20 + 350 - (700 - DETAILS_COVER)), y: 7, zoom: 0.5 });
  });
  it("never slides a node's left edge off the canvas: a node too wide for the room stops at the left margin", () => {
    const v = slideClearOfDetails({ x: 300, w: 900 }, vp, 1000)!;
    expect(300 + v.x).toBe(DETAILS_MARGIN);
  });
  it("never slides right, and does nothing when there is nowhere to go", () => {
    expect(slideClearOfDetails({ x: 0, w: 2000 }, vp, 1000)).toBeNull();
  });
});

describe("the floating details (places.css) only float on wide screens", () => {
  it("tablet keeps the full-width details under the canvas; phone keeps its sheet; wide floats them over the canvas", () => {
    expect(DETAILS_FLOAT).toBe("(min-width: 1100px)");
    // SidePanel stacks the panel under the content up to 1099 px; the float starts where that stops.
    expect(sidePanelCss).toMatch(/@media \(max-width: 1099px\)/);
    const at = placesCss.indexOf("@media (min-width: 1100px)");
    expect(at).toBeGreaterThan(-1);
    const float = placesCss.indexOf("position: absolute");
    expect(float).toBeGreaterThan(at);
  });
  it("the canvas slides only when the details float, by the panel's real footprint, instantly under reduced motion", () => {
    expect(flowSource).toMatch(/useMedia\(DETAILS_FLOAT\)/);
    expect(flowSource).toMatch(/slideClearOfDetails\(/);
    expect(flowSource).toMatch(/duration: reduced \? 0 :/);
    // 350 px panel + 10 px inset, inside the cover.
    expect(placesCss).toMatch(/width: min\(350px, calc\(100% - 20px\)\)/);
    expect(DETAILS_COVER).toBeGreaterThanOrEqual(350 + 10 + DETAILS_MARGIN);
  });
  it("the floating panel's shadow is softer in the light theme (tokens, no raw colours outside a shadow)", () => {
    expect(placesCss).toMatch(/:root\[data-theme="light"\][^{]*\.topo-details/);
  });
});
