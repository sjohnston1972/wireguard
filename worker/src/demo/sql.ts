// demo/sql.ts
//
// Plain English: demo mode's store is one SQLite database inside a Durable
// Object (store.ts). The app's code talks to D1 (DB), KV (STATUS), R2 (STATE)
// and the run-lock object (RUN_LOCK), so this file builds look-alikes of those
// four over that one database ("facades"), the way a lab switch stands in for
// a whole network. The same app code then runs against the demo data without
// knowing, and can never reach a real binding: the facades hold nothing but
// the demo store's SQLite.
//
// Every write is counted (WriteMeter), so the store can keep its refreshes
// inside a daily allowance (demo mode spec §3 ruling 8).
//
// Facade tables (made by ensureFacadeTables, next to the app's own tables):
//   _demo_kv   (k, v, exp)              KV: text values, expiry in ms since 1970
//   _demo_r2   (k, body, ct, uploaded)  R2: bodies up to 1 MiB
//   _demo_do   (k, v)                   RunLock storage, keyed "<instance>|<key>"
//   _demo_meta (k, v)                   the store's own bookkeeping (store.ts)

import { lockFetch, type LockStorage } from "../lock";

// ── The SQLite we stand on ────────────────────────────────────────────────

/** A cursor as a Durable Object's `sql.exec` answers it (the parts used). */
export interface SqlCursorLike {
  toArray(): Record<string, unknown>[];
  /** Rows written by the statement; read after toArray(). */
  readonly rowsWritten: number;
}

/**
 * The subset of a Durable Object's SQL storage the facades use: `exec` runs
 * ONE statement (bindings as `?` or `?NNN`), `transactionSync` runs a function
 * all or nothing. The store passes `ctx.storage.sql` and `ctx.storage`; the
 * tests pass node:sqlite (harness.ts sqliteLike).
 */
export interface SqlLike {
  exec(query: string, ...bindings: unknown[]): SqlCursorLike;
  transactionSync<T>(fn: () => T): T;
}

/** Counts the rows every facade writes (SQLite's own figure, `rowsWritten`). */
export class WriteMeter {
  rows = 0;
  add(n: number): void {
    if (Number.isFinite(n) && n > 0) this.rows += n;
  }
}

/** A value as SQLite in a Durable Object takes it: undefined → null, booleans → 1/0 (as D1), views → ArrayBuffer. */
function bindValue(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "bigint") return Number(v);
  if (ArrayBuffer.isView(v)) return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
  return v;
}

/** Run one statement, count what it wrote, answer its rows. */
function run(sql: SqlLike, meter: WriteMeter, query: string, bindings: unknown[] = []): Record<string, unknown>[] {
  const cursor = sql.exec(query, ...bindings.map(bindValue));
  const rows = cursor.toArray();
  meter.add(cursor.rowsWritten);
  return rows;
}

/**
 * A migration file's statements, one by one. Semicolons inside `--` and
 * `/* *\/` comments and inside quotes ('', "", ``, []) do not split; pieces
 * that are only whitespace or comments are dropped.
 */
export function splitSql(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  const push = () => {
    const meaningful = cur.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").trim();
    if (meaningful) out.push(cur.trim());
    cur = "";
  };
  while (i < text.length) {
    const ch = text[i];
    const two = text.slice(i, i + 2);
    if (two === "--") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      cur += text.slice(i, stop);
      i = stop;
    } else if (two === "/*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      cur += text.slice(i, stop);
      i = stop;
    } else if (ch === "'" || ch === '"' || ch === "`" || ch === "[") {
      const close = ch === "[" ? "]" : ch;
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === close) {
          if (close !== "]" && text[j + 1] === close) j += 2; // a doubled quote is a quote
          else break;
        } else j++;
      }
      cur += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === ";") {
      push();
      i++;
    } else {
      cur += ch;
      i++;
    }
  }
  push();
  return out;
}

/** The facades' own tables. Safe to run again. */
export function ensureFacadeTables(sql: SqlLike): void {
  sql.exec("CREATE TABLE IF NOT EXISTS _demo_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER)");
  sql.exec("CREATE TABLE IF NOT EXISTS _demo_r2 (k TEXT PRIMARY KEY, body BLOB NOT NULL, ct TEXT, uploaded TEXT NOT NULL)");
  sql.exec("CREATE TABLE IF NOT EXISTS _demo_do (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  sql.exec("CREATE TABLE IF NOT EXISTS _demo_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
}

// ── D1 ────────────────────────────────────────────────────────────────────

type D1Meta = { changes: number; last_row_id: number; rows_written: number; rows_read: number; duration: number; changed_db: boolean; size_after: number };

class DemoStatement {
  constructor(
    private readonly sql: SqlLike,
    private readonly meter: WriteMeter,
    readonly query: string,
    readonly args: unknown[] = [],
  ) {}

  bind(...args: unknown[]): DemoStatement {
    return new DemoStatement(this.sql, this.meter, this.query, args);
  }

  /** Runs now, synchronously (batch needs that inside transactionSync). */
  execSync(): { results: Record<string, unknown>[]; success: true; meta: D1Meta } {
    const before = Number(this.sql.exec("SELECT total_changes() AS t").toArray()[0]?.t ?? 0);
    const cursor = this.sql.exec(this.query, ...this.args.map(bindValue));
    const results = cursor.toArray();
    const written = cursor.rowsWritten;
    this.meter.add(written);
    const after = this.sql.exec("SELECT total_changes() AS t, last_insert_rowid() AS r").toArray()[0] ?? {};
    const changes = Number(after.t ?? 0) - before;
    return { results, success: true, meta: { changes, last_row_id: Number(after.r ?? 0), rows_written: written, rows_read: 0, duration: 0, changed_db: changes > 0, size_after: 0 } };
  }

  async first<T = Record<string, unknown>>(col?: string): Promise<T | null> {
    const row = run(this.sql, this.meter, this.query, this.args)[0];
    if (!row) return null;
    if (col === undefined) return { ...row } as T;
    if (!(col in row)) throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${col})`);
    return row[col] as T;
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: true; meta: D1Meta }> {
    const r = this.execSync();
    return { ...r, results: r.results.map((x) => ({ ...x })) as T[] };
  }

  async run(): Promise<{ results: Record<string, unknown>[]; success: true; meta: D1Meta }> {
    return this.execSync();
  }

  async raw<T = unknown[]>(opts?: { columnNames?: boolean }): Promise<T[]> {
    const rows = run(this.sql, this.meter, this.query, this.args);
    const arrays = rows.map((r) => Object.values(r));
    if (opts?.columnNames) return [Object.keys(rows[0] ?? {}), ...arrays] as T[];
    return arrays as T[];
  }
}

/** D1-shaped, over the demo store's SQLite: prepare/bind/first/all/run/raw and batch (one transaction). */
export function d1Over(sql: SqlLike, meter: WriteMeter): D1Database {
  return {
    prepare: (query: string) => new DemoStatement(sql, meter, query),
    async batch(stmts: DemoStatement[]) {
      return sql.transactionSync(() => stmts.map((s) => s.execSync()));
    },
  } as unknown as D1Database;
}

// ── KV ────────────────────────────────────────────────────────────────────

/** KV-shaped: text values with get (text/json), put (expirationTtl/expiration), delete, list({ prefix }). */
export function kvOver(sql: SqlLike, meter: WriteMeter): KVNamespace {
  const live = (k: string): string | null => {
    const row = run(sql, meter, "SELECT v, exp FROM _demo_kv WHERE k = ?1", [k])[0];
    if (!row) return null;
    if (row.exp !== null && Number(row.exp) <= Date.now()) return null;
    return String(row.v);
  };
  return {
    async get(k: string, opt?: string | { type?: string }) {
      const v = live(k);
      if (v === null) return null;
      const type = typeof opt === "string" ? opt : opt?.type;
      if (type === "json") return JSON.parse(v);
      if (type === "arrayBuffer") return new TextEncoder().encode(v).buffer;
      return v;
    },
    async put(k: string, v: unknown, opts?: { expirationTtl?: number; expiration?: number }) {
      if (typeof v !== "string") throw new TypeError("The demo KV stores text only.");
      const exp = opts?.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : opts?.expiration ? opts.expiration * 1000 : null;
      run(sql, meter, "INSERT OR REPLACE INTO _demo_kv (k, v, exp) VALUES (?1, ?2, ?3)", [k, v, exp]);
    },
    async delete(k: string) {
      run(sql, meter, "DELETE FROM _demo_kv WHERE k = ?1", [k]);
    },
    async list(opts: { prefix?: string; limit?: number; cursor?: string } = {}) {
      const prefix = opts.prefix ?? "";
      const limit = opts.limit ?? 1000;
      const rows = run(sql, meter, "SELECT k, exp FROM _demo_kv WHERE substr(k, 1, ?1) = ?2 AND k > ?3 ORDER BY k LIMIT ?4", [prefix.length, prefix, opts.cursor ?? "", limit + 1]).filter(
        (r) => r.exp === null || Number(r.exp) > Date.now(),
      );
      const page = rows.slice(0, limit);
      const more = rows.length > limit;
      return { keys: page.map((r) => ({ name: String(r.k), ...(r.exp !== null ? { expiration: Math.floor(Number(r.exp) / 1000) } : {}) })), list_complete: !more, ...(more ? { cursor: String(page.at(-1)!.k) } : {}) };
    },
  } as unknown as KVNamespace;
}

// ── R2 ────────────────────────────────────────────────────────────────────

/** The largest demo R2 value (the seeded backups are a few kB). */
export const DEMO_R2_MAX_BYTES = 1024 * 1024;

async function bytesOf(v: unknown): Promise<Uint8Array> {
  if (v === null || v === undefined) return new Uint8Array();
  if (typeof v === "string") return new TextEncoder().encode(v);
  if (v instanceof ArrayBuffer) return new Uint8Array(v.slice(0));
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
  if (typeof Blob !== "undefined" && v instanceof Blob) return new Uint8Array(await v.arrayBuffer());
  if (v instanceof ReadableStream) return new Uint8Array(await new Response(v).arrayBuffer());
  throw new TypeError("The demo R2 stores text, ArrayBuffer, typed arrays, Blob or a stream.");
}

function objectOf(row: Record<string, unknown>, withBody: boolean) {
  const raw = row.body;
  const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : ArrayBuffer.isView(raw) ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : new TextEncoder().encode(String(raw ?? ""));
  const base = {
    key: String(row.k),
    size: bytes.byteLength,
    uploaded: new Date(String(row.uploaded)),
    httpMetadata: row.ct ? { contentType: String(row.ct) } : {},
    customMetadata: {},
    etag: "",
    httpEtag: '""',
    version: "",
  };
  if (!withBody) return base;
  const copy = () => bytes.slice().buffer;
  return {
    ...base,
    body: new Response(copy()).body,
    bodyUsed: false,
    arrayBuffer: async () => copy(),
    text: async () => new TextDecoder().decode(bytes),
    json: async () => JSON.parse(new TextDecoder().decode(bytes)),
    blob: async () => new Blob([copy()]),
  };
}

/** R2-shaped: put, get (body/text/json/arrayBuffer/httpMetadata), head, delete (one or many), list({ prefix, cursor, limit }). */
export function r2Over(sql: SqlLike, meter: WriteMeter): R2Bucket {
  return {
    async put(k: string, v: unknown, opts?: { httpMetadata?: { contentType?: string } }) {
      const bytes = await bytesOf(v);
      if (bytes.byteLength > DEMO_R2_MAX_BYTES) throw new RangeError(`The demo R2 keeps values up to 1 MiB; ${k} is ${bytes.byteLength} bytes.`);
      const uploaded = new Date().toISOString();
      run(sql, meter, "INSERT OR REPLACE INTO _demo_r2 (k, body, ct, uploaded) VALUES (?1, ?2, ?3, ?4)", [k, bytes, opts?.httpMetadata?.contentType ?? null, uploaded]);
      return objectOf({ k, body: bytes, ct: opts?.httpMetadata?.contentType ?? null, uploaded }, false);
    },
    async get(k: string) {
      const row = run(sql, meter, "SELECT k, body, ct, uploaded FROM _demo_r2 WHERE k = ?1", [k])[0];
      return row ? objectOf(row, true) : null;
    },
    async head(k: string) {
      const row = run(sql, meter, "SELECT k, body, ct, uploaded FROM _demo_r2 WHERE k = ?1", [k])[0];
      return row ? objectOf(row, false) : null;
    },
    async delete(keys: string | string[]) {
      for (const k of ([] as string[]).concat(keys)) run(sql, meter, "DELETE FROM _demo_r2 WHERE k = ?1", [k]);
    },
    async list(opts: { prefix?: string; cursor?: string; limit?: number } = {}) {
      const prefix = opts.prefix ?? "";
      const limit = opts.limit ?? 1000;
      const rows = run(sql, meter, "SELECT k, body, ct, uploaded FROM _demo_r2 WHERE substr(k, 1, ?1) = ?2 AND k > ?3 ORDER BY k LIMIT ?4", [prefix.length, prefix, opts.cursor ?? "", limit + 1]);
      const page = rows.slice(0, limit);
      const truncated = rows.length > limit;
      return { objects: page.map((r) => objectOf(r, false)), truncated, delimitedPrefixes: [], ...(truncated ? { cursor: String(page.at(-1)!.k) } : {}) };
    },
  } as unknown as R2Bucket;
}

// ── Durable Object storage (RunLock) ──────────────────────────────────────

/** RunLock's storage for one instance name, over _demo_do (values as JSON). */
export function doStorageOver(sql: SqlLike, instance: string, meter: WriteMeter): LockStorage {
  const pre = `${instance}|`;
  return {
    async get<T>(key: string) {
      const row = run(sql, meter, "SELECT v FROM _demo_do WHERE k = ?1", [pre + key])[0];
      return row ? (JSON.parse(String(row.v)) as T) : undefined;
    },
    async put<T>(key: string, value: T) {
      run(sql, meter, "INSERT OR REPLACE INTO _demo_do (k, v) VALUES (?1, ?2)", [pre + key, JSON.stringify(value)]);
    },
    async delete(key: string) {
      const had = run(sql, meter, "SELECT 1 AS x FROM _demo_do WHERE k = ?1", [pre + key]).length > 0;
      if (had) run(sql, meter, "DELETE FROM _demo_do WHERE k = ?1", [pre + key]);
      return had;
    },
    async list<T>({ prefix }: { prefix: string }) {
      const full = pre + prefix;
      const rows = run(sql, meter, "SELECT k, v FROM _demo_do WHERE substr(k, 1, ?1) = ?2 ORDER BY k", [full.length, full]);
      return new Map(rows.map((r) => [String(r.k).slice(pre.length), JSON.parse(String(r.v)) as T]));
    },
  };
}

/**
 * RUN_LOCK-shaped: idFromName/get, each instance answering fetch() with
 * RunLock's own handling (lockFetch) on its demo storage, one request at a
 * time per instance (a real Durable Object's input gate).
 */
export function doNamespaceOver(sql: SqlLike, meter: WriteMeter): DurableObjectNamespace {
  const queues = new Map<string, Promise<unknown>>();
  const stubFor = (name: string) => ({
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const prev = queues.get(name) ?? Promise.resolve();
      const next = prev.then(() => lockFetch(doStorageOver(sql, name, meter), new Request(input, init), Date.now()));
      queues.set(
        name,
        next.catch(() => undefined),
      );
      return next;
    },
  });
  return {
    idFromName: (name: string) => ({ name, toString: () => name, equals: (o: { name?: string }) => o?.name === name }),
    get: (id: { name: string }) => stubFor(id.name),
  } as unknown as DurableObjectNamespace;
}
