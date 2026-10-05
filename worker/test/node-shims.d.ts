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
      run(...args: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    };
  }
}
declare module "node:fs" {
  export function readdirSync(path: string | URL): string[];
  export function readFileSync(path: string | URL, encoding: "utf8"): string;
  export function writeFileSync(path: string | URL, data: string): void;
  export function appendFileSync(path: string | URL, data: string): void;
  export function mkdtempSync(prefix: string): string;
}

// The lab pipeline contract test (labs-pipeline-contract.test.ts) runs infra/ci/lab-parse.sh.
declare module "node:os" {
  export function tmpdir(): string;
}
declare module "node:path" {
  export function join(...parts: string[]): string;
}
declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
  export function pathToFileURL(path: string): URL;
}

// gzip, used only by the cloud-init size test (Terraform's base64gzip).
declare module "node:zlib" {
  export function gzipSync(data: Uint8Array, options?: { level?: number }): Buffer;
  export function gunzipSync(data: Uint8Array): Buffer;
}

// Vitest runs the tests as ES modules, where import.meta.url is the file's URL.
interface ImportMeta {
  readonly url: string;
}

// Node crypto, used only by the Web Push test (typed loosely there).
declare module "node:crypto" {
  const nodeCrypto: any;
  export = nodeCrypto;
}

// Used only to syntax-check the VM agent script (bash -n) from a test.
declare module "node:child_process" {
  export function execFileSync(file: string, args: string[]): unknown;
  export function spawnSync(file: string, args: string[], options?: { encoding?: "utf8"; env?: Record<string, string | undefined>; timeout?: number }): { status: number | null; stdout: string; stderr: string };
}
