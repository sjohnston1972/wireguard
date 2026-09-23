// Stand-in for the "cloudflare:workers" module under Node, so the real
// RunLock class can be exercised by the tests (see harness.ts).
export class DurableObject<E = unknown> {
  ctx: DurableObjectState;
  env: E;
  constructor(ctx: DurableObjectState, env: E) {
    this.ctx = ctx;
    this.env = env;
  }
}
