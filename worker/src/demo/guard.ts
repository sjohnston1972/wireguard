// demo/guard.ts
//
// Plain English: the last line of defence against demo mode calling the
// outside world (demo mode spec §3 ruling 3, §9.2). The demo environment
// has no secrets, so the app's code never even tries Azure, GitHub, DNS or
// push there. This guard makes sure of it anyway: while code runs inside
// demoScope (the demo store's serve and refresh), any fetch() fails at once
// with DemoOutboundError instead of leaving the Worker. Outside demoScope,
// fetch works exactly as before.
//
// It wraps the global fetch once (installDemoFetchGuard is idempotent). cron.ts
// wraps fetch with its call meter while a cron run is going and puts back what
// it found, so the guard survives it; the demo store re-installs the guard at
// the start of every serve and refresh in case anything replaced fetch since.

import { AsyncLocalStorage } from "node:async_hooks";

/** Set while code runs for demo mode (demo/store.ts). Its value is always true. */
export const demoScope = new AsyncLocalStorage<true>();

/** A fetch attempted while serving or seeding demo data. Never sent. */
export class DemoOutboundError extends Error {
  constructor(readonly target: string) {
    super(`Demo mode never calls outside services (refused a request to ${target}).`);
    this.name = "DemoOutboundError";
  }
}

/** The last refused attempts (host and path only), newest last: for tests and the Worker's log. */
export const demoOutboundLog: string[] = [];

const guards = new WeakSet<object>();

function targetOf(input: RequestInfo | URL): string {
  try {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return `${u.host}${u.pathname}`;
  } catch {
    return "an unreadable address";
  }
}

/** Put the guard around the global fetch, unless it already is the guard. */
export function installDemoFetchGuard(): void {
  const inner = globalThis.fetch;
  if (typeof inner !== "function" || guards.has(inner)) return;
  const guard: typeof fetch = (input, init) => {
    if (demoScope.getStore()) {
      const target = targetOf(input);
      demoOutboundLog.push(target);
      if (demoOutboundLog.length > 50) demoOutboundLog.shift();
      console.error(`demo mode: refused an outside call to ${target}`);
      return Promise.reject(new DemoOutboundError(target));
    }
    return inner(input, init);
  };
  guards.add(guard);
  globalThis.fetch = guard;
}

/** True when the global fetch is currently the guard (tests). */
export function demoFetchGuarded(): boolean {
  return guards.has(globalThis.fetch);
}
