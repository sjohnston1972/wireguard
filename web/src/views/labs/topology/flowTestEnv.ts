// views/labs/topology/flowTestEnv.ts
//
// Plain English: test-only stand-ins React Flow needs in jsdom (lab topology
// plan T1: "ResizeObserver and DOMMatrixReadOnly stand-ins in the file's
// setup"). ResizeObserver comes from test/polyfills.ts; this adds
// DOMMatrixReadOnly (React Flow reads the viewport's zoom from it). Imported
// by the diagram's test files only, never by the app.

class DOMMatrixStandIn {
  m22 = 1;
  a = 1;
  d = 1;
  e = 0;
  f = 0;
  constructor(transform?: string) {
    const m = transform?.match(/scale\(([\d.]+)\)/);
    if (m) this.m22 = this.a = this.d = Number(m[1]);
  }
}

export function installFlowStandIns(): void {
  const w = window as unknown as { DOMMatrixReadOnly?: unknown };
  if (!w.DOMMatrixReadOnly) w.DOMMatrixReadOnly = DOMMatrixStandIn;
}
