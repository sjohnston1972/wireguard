// node-async-hooks.d.ts
//
// Plain English: the one Node built-in the Worker itself uses, AsyncLocalStorage
// (cron.ts counts each cron run's own calls with it). Cloudflare provides it
// under the nodejs_compat flag (wrangler.toml). Declared here rather than
// installing @types/node, whose globals would leak into the Worker's type
// checking (the Worker runs on Cloudflare, not Node).
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    getStore(): T | undefined;
    run<R>(store: T, fn: () => R): R;
  }
}
