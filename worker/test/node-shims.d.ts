// The few Node built-ins the test harness uses. Declared here rather than
// installing @types/node, whose globals would leak into the Worker's own
// type checking (the Worker runs on Cloudflare, not Node).
declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): {
      get(...args: unknown[]): Record<string, unknown> | undefined;
      all(...args: unknown[]): Record<string, unknown>[];
      run(...args: unknown[]): unknown;
    };
  }
}
declare module "node:fs" {
  export function readdirSync(path: string | URL): string[];
  export function readFileSync(path: string | URL, encoding: "utf8"): string;
}

// Vitest runs the tests as ES modules, where import.meta.url is the file's URL.
interface ImportMeta {
  readonly url: string;
}
