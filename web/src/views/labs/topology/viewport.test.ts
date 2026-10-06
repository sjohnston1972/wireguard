// Where the diagram's first view starts (viewport.ts): fitted and centred when the picture fits readably, otherwise at
// the readable zoom from the top-left (the phone's first view used to sit in the middle of a wide picture).
import { describe, expect, it } from "vitest";
import { boundsOf, MIN_FIT_ZOOM, PHONE_MIN_FIT_ZOOM, START_INSET, startViewport } from "./viewport";

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

  it("boundsOf is the box round the top-level boxes", () => {
    expect(boundsOf([])).toBeNull();
    expect(boundsOf([{ x: 0, y: 0, w: 10, h: 10 }, { x: 50, y: -5, w: 10, h: 40 }])).toEqual({ x: 0, y: -5, w: 60, h: 40 });
  });
});
