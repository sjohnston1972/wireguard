// A stand-in for uPlot in every web test (setup.ts mocks "uplot" with it):
// jsdom has no canvas, so the real one crashes on its first draw. Charts'
// own logic (summary text, empty state, lifecycle) still runs. A test can
// read FakeUPlot.instances to see what was drawn.

export interface FakePlotRecord {
  opts: unknown;
  data: unknown;
  destroyed: boolean;
}

export default class FakeUPlot {
  static instances: FakePlotRecord[] = [];
  static paths = { bars: () => () => null, spline: () => () => null, linear: () => () => null, stepped: () => () => null };
  rec: FakePlotRecord;
  cursor = { idx: null as number | null };
  constructor(opts: unknown, data: unknown) {
    this.rec = { opts, data, destroyed: false };
    FakeUPlot.instances.push(this.rec);
  }
  setSize() {}
  setData(d: unknown) {
    this.rec.data = d;
  }
  setCursor() {}
  redraw() {}
  destroy() {
    this.rec.destroyed = true;
  }
}
