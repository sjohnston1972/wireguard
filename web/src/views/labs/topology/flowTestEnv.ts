// views/labs/topology/flowTestEnv.ts
//
// Plain English: test-only stand-ins React Flow needs in jsdom (lab topology
// plan T1: "ResizeObserver and DOMMatrixReadOnly stand-ins in the file's
// setup"). Imported by the diagram's test files only, never by the app.
//
// - DOMMatrixReadOnly: React Flow reads the viewport's zoom from it.
// - measureFromStyle(): jsdom lays nothing out, so an element's offsetWidth
//   and offsetHeight are read from its inline style, and a ResizeObserver
//   reports each observed element once, as a browser does when it first
//   lays it out. React Flow then measures its nodes and fits the view.

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

class ReportingResizeObserver {
  constructor(private cb: ResizeObserverCallback) {}
  observe(target: Element) {
    const el = target as HTMLElement;
    const contentRect = { x: 0, y: 0, top: 0, left: 0, width: el.offsetWidth ?? 0, height: el.offsetHeight ?? 0 };
    queueMicrotask(() => this.cb([{ target, contentRect } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver));
  }
  unobserve() {}
  disconnect() {}
}

/** Size elements from their inline style and report them to ResizeObservers; returns the undo. */
export function measureFromStyle(): () => void {
  const proto = HTMLElement.prototype;
  const ow = Object.getOwnPropertyDescriptor(proto, "offsetWidth");
  const oh = Object.getOwnPropertyDescriptor(proto, "offsetHeight");
  const ro = globalThis.ResizeObserver;
  Object.defineProperty(proto, "offsetWidth", { configurable: true, get(this: HTMLElement) { return parseFloat(this.style.width) || 0; } });
  Object.defineProperty(proto, "offsetHeight", { configurable: true, get(this: HTMLElement) { return parseFloat(this.style.height) || 0; } });
  globalThis.ResizeObserver = ReportingResizeObserver as unknown as typeof ResizeObserver;
  return () => {
    if (ow) Object.defineProperty(proto, "offsetWidth", ow);
    if (oh) Object.defineProperty(proto, "offsetHeight", oh);
    globalThis.ResizeObserver = ro;
  };
}
