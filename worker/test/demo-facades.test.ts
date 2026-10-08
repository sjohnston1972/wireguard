// demo-facades.test.ts
//
// Plain English: demo mode's store is one SQLite database inside a Durable
// Object. The app's code expects D1, KV, R2 and the run-lock object, so the
// store hands it look-alikes ("facades") over its own SQLite (worker/src/
// demo/sql.ts). These tests pin each look-alike to the behaviour the app
// relies on, over node:sqlite (the harness's sqliteLike, shaped like a
// Durable Object's SqlStorage), and check every write is counted.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sqliteLike, makeEnv } from "./harness";
import { d1Over, kvOver, r2Over, doStorageOver, doNamespaceOver, WriteMeter, splitSql, ensureFacadeTables, type SqlLike } from "../src/demo/sql";
import { DEMO_SCHEMA } from "../src/demo/schema.gen";

let sql: SqlLike;
let meter: WriteMeter;

beforeEach(() => {
  sql = sqliteLike();
  ensureFacadeTables(sql);
  meter = new WriteMeter();
});

describe("splitSql", () => {
  it("splits on semicolons outside comments and quotes", () => {
    const text = "-- a; comment\nCREATE TABLE a (x TEXT DEFAULT 'a;b'); /* c; d */ CREATE TABLE \"b;\" (y INTEGER);\n-- trailing; note\n";
    expect(splitSql(text)).toEqual(["-- a; comment\nCREATE TABLE a (x TEXT DEFAULT 'a;b')", "/* c; d */ CREATE TABLE \"b;\" (y INTEGER)"]);
  });

  it("drops empty and comment-only pieces", () => {
    expect(splitSql(";;\n-- only a comment\n  ")).toEqual([]);
  });

  it("builds every migration statement by statement to the same tables and indexes as D1 gets", async () => {
    for (const m of DEMO_SCHEMA) for (const s of splitSql(m.sql)) sql.exec(s);
    const { env } = makeEnv();
    const master = "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_demo\\_%' ESCAPE '\\' ORDER BY type, name";
    const real = (await env.DB.prepare(master).all<{ type: string; name: string }>()).results;
    expect(sql.exec(master).toArray()).toEqual(real);
    expect(real.length).toBeGreaterThan(40);
  });
});

describe("sqliteLike (the harness's Durable Object SqlStorage)", () => {
  it("refuses more than one statement in one exec, so the store never relies on it", () => {
    expect(() => sql.exec("SELECT 1; SELECT 2")).toThrow(/one statement/);
  });
  it("binds ArrayBuffer as a blob and reads blobs back as ArrayBuffer, as a Durable Object does", () => {
    sql.exec("CREATE TABLE t (b BLOB)");
    sql.exec("INSERT INTO t VALUES (?)", new Uint8Array([1, 2, 3]).buffer);
    const v = sql.exec("SELECT b FROM t").toArray()[0].b;
    expect(v).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(v as ArrayBuffer)]).toEqual([1, 2, 3]);
  });
  it("transactionSync rolls back on a throw", () => {
    sql.exec("CREATE TABLE t (x INTEGER)");
    expect(() =>
      sql.transactionSync(() => {
        sql.exec("INSERT INTO t VALUES (1)");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(sql.exec("SELECT COUNT(*) AS n FROM t").toArray()[0].n).toBe(0);
  });
});

describe("d1Over", () => {
  let db: D1Database;
  beforeEach(() => {
    db = d1Over(sql, meter);
    sql.exec("CREATE TABLE p (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, flag INTEGER, note TEXT)");
  });

  it("first, first(col), all().results", async () => {
    await db.prepare("INSERT INTO p (name, flag) VALUES (?1, ?2)").bind("a", 1).run();
    await db.prepare("INSERT INTO p (name, flag) VALUES (?1, ?2)").bind("b", 0).run();
    expect(await db.prepare("SELECT name, flag FROM p WHERE name = ?1").bind("a").first()).toEqual({ name: "a", flag: 1 });
    expect(await db.prepare("SELECT name FROM p WHERE name = ?1").bind("a").first("name")).toBe("a");
    expect(await db.prepare("SELECT name FROM p WHERE name = 'zz'").first()).toBeNull();
    expect(await db.prepare("SELECT name FROM p WHERE name = 'zz'").first("name")).toBeNull();
    await expect(db.prepare("SELECT name FROM p").first("nope")).rejects.toThrow(/nope/);
    const all = await db.prepare("SELECT name FROM p ORDER BY id").all<{ name: string }>();
    expect(all.results).toEqual([{ name: "a" }, { name: "b" }]);
    expect(all.success).toBe(true);
  });

  it("run().meta.changes (0 for a no-op UPDATE) and last_row_id", async () => {
    const r1 = await db.prepare("INSERT INTO p (name) VALUES (?1)").bind("a").run();
    expect(r1.meta.changes).toBe(1);
    expect(r1.meta.last_row_id).toBe(1);
    const r2 = await db.prepare("INSERT INTO p (name) VALUES (?1)").bind("b").run();
    expect(r2.meta.last_row_id).toBe(2);
    expect((await db.prepare("UPDATE p SET note = 'x' WHERE name = 'nobody'").run()).meta.changes).toBe(0);
    expect((await db.prepare("UPDATE p SET note = 'x'").run()).meta.changes).toBe(2);
    expect((await db.prepare("SELECT * FROM p").run()).meta.changes).toBe(0);
  });

  it("binds undefined as null and booleans as 1/0, as D1 does", async () => {
    await db.prepare("INSERT INTO p (name, flag, note) VALUES (?1, ?2, ?3)").bind("a", true, undefined).run();
    await db.prepare("INSERT INTO p (name, flag) VALUES (?1, ?2)").bind("b", false).run();
    expect((await db.prepare("SELECT name, flag, note FROM p ORDER BY id").all()).results).toEqual([
      { name: "a", flag: 1, note: null },
      { name: "b", flag: 0, note: null },
    ]);
  });

  it("raw() answers rows as arrays", async () => {
    await db.prepare("INSERT INTO p (name, flag) VALUES ('a', 1)").run();
    expect(await db.prepare("SELECT name, flag FROM p").raw()).toEqual([["a", 1]]);
  });

  it("batch is all or nothing, and answers each statement's results", async () => {
    const ok = await db.batch([db.prepare("INSERT INTO p (name) VALUES ('a')"), db.prepare("SELECT name FROM p")]);
    expect(ok).toHaveLength(2);
    expect(ok[0].meta.changes).toBe(1);
    expect(ok[1].results).toEqual([{ name: "a" }]);
    await expect(db.batch([db.prepare("INSERT INTO p (name) VALUES ('b')"), db.prepare("INSERT INTO nowhere VALUES (1)")])).rejects.toThrow();
    expect((await db.prepare("SELECT name FROM p").all()).results).toEqual([{ name: "a" }]);
  });

  it("an error statement rejects (never throws synchronously, never answers)", async () => {
    const p = db.prepare("SELEC nonsense").all();
    await expect(p).rejects.toThrow();
    await expect(db.prepare("INSERT INTO nowhere VALUES (1)").run()).rejects.toThrow();
  });

  it("counts every write in the meter, and no read", async () => {
    await db.prepare("SELECT * FROM p").all();
    expect(meter.rows).toBe(0);
    await db.prepare("INSERT INTO p (name) VALUES ('a')").run();
    await db.batch([db.prepare("INSERT INTO p (name) VALUES ('b')"), db.prepare("INSERT INTO p (name) VALUES ('c')")]);
    expect(meter.rows).toBeGreaterThanOrEqual(3);
  });
});

describe("kvOver", () => {
  let kv: KVNamespace;
  beforeEach(() => {
    kv = kvOver(sql, meter);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("get text, json and { type: json }; null when missing", async () => {
    expect(await kv.get("nope")).toBeNull();
    await kv.put("t", "hello");
    await kv.put("j", JSON.stringify({ a: 1 }));
    expect(await kv.get("t")).toBe("hello");
    expect(await kv.get("t", "text")).toBe("hello");
    expect(await kv.get("j", "json")).toEqual({ a: 1 });
    expect(await kv.get("j", { type: "json" })).toEqual({ a: 1 });
  });

  it("put replaces; delete removes", async () => {
    await kv.put("k", "1");
    await kv.put("k", "2");
    expect(await kv.get("k")).toBe("2");
    await kv.delete("k");
    expect(await kv.get("k")).toBeNull();
    await kv.delete("never-there");
  });

  it("put with expirationTtl expires; expiration (seconds since 1970) too", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-08T12:00:00Z"));
    await kv.put("ttl", "x", { expirationTtl: 60 });
    await kv.put("abs", "y", { expiration: Date.parse("2026-10-08T12:05:00Z") / 1000 });
    expect(await kv.get("ttl")).toBe("x");
    vi.setSystemTime(new Date("2026-10-08T12:01:01Z"));
    expect(await kv.get("ttl")).toBeNull();
    expect(await kv.get("abs")).toBe("y");
    vi.setSystemTime(new Date("2026-10-08T12:05:01Z"));
    expect(await kv.get("abs")).toBeNull();
  });

  it("list({ prefix }) answers the live keys in order", async () => {
    await kv.put("a:2", "x");
    await kv.put("a:1", "x");
    await kv.put("b:1", "x");
    const r = await kv.list({ prefix: "a:" });
    expect(r.keys.map((k) => k.name)).toEqual(["a:1", "a:2"]);
    expect(r.list_complete).toBe(true);
  });

  it("refuses a value that is not text (the app only stores text)", async () => {
    await expect(kv.put("b", new ArrayBuffer(2) as unknown as string)).rejects.toThrow(/text/);
  });

  it("counts writes", async () => {
    await kv.get("x");
    expect(meter.rows).toBe(0);
    await kv.put("x", "1");
    await kv.delete("x");
    expect(meter.rows).toBeGreaterThanOrEqual(2);
  });
});

describe("r2Over", () => {
  let r2: R2Bucket;
  beforeEach(() => {
    r2 = r2Over(sql, meter);
  });

  it("put text with httpMetadata; get answers text(), json(), body and the metadata", async () => {
    await r2.put("config-backups/2026-10-01.json", JSON.stringify({ a: 1 }), { httpMetadata: { contentType: "application/json" } });
    const o = (await r2.get("config-backups/2026-10-01.json"))!;
    expect(o.key).toBe("config-backups/2026-10-01.json");
    expect(o.httpMetadata?.contentType).toBe("application/json");
    expect(o.size).toBe(7);
    expect(o.uploaded).toBeInstanceOf(Date);
    expect(await o.json()).toEqual({ a: 1 });
    const again = (await r2.get("config-backups/2026-10-01.json"))!;
    expect(await again.text()).toBe('{"a":1}');
    const viaBody = (await r2.get("config-backups/2026-10-01.json"))!;
    expect(await new Response(viaBody.body).text()).toBe('{"a":1}');
    expect(await r2.get("missing")).toBeNull();
  });

  it("put ArrayBuffer and Uint8Array bodies", async () => {
    await r2.put("ab", new Uint8Array([104, 105]).buffer);
    await r2.put("u8", new Uint8Array([111, 107]));
    expect(await (await r2.get("ab"))!.text()).toBe("hi");
    expect(new Uint8Array(await (await r2.get("u8"))!.arrayBuffer())).toEqual(new Uint8Array([111, 107]));
  });

  it("head answers the object without a body; null when missing", async () => {
    await r2.put("h", "abc");
    const h = (await r2.head("h"))!;
    expect(h.key).toBe("h");
    expect(h.size).toBe(3);
    expect("body" in h).toBe(false);
    expect(await r2.head("nope")).toBeNull();
  });

  it("delete one key or many", async () => {
    for (const k of ["a", "b", "c"]) await r2.put(k, "x");
    await r2.delete("a");
    await r2.delete(["b", "c", "never"]);
    expect((await r2.list()).objects).toEqual([]);
  });

  it("list({ prefix, cursor }) pages in key order", async () => {
    for (const k of ["p/3", "p/1", "p/2", "q/1"]) await r2.put(k, "x");
    const first = await r2.list({ prefix: "p/", limit: 2 });
    expect(first.objects.map((o) => o.key)).toEqual(["p/1", "p/2"]);
    expect(first.truncated).toBe(true);
    const next = await r2.list({ prefix: "p/", limit: 2, cursor: (first as { cursor: string }).cursor });
    expect(next.objects.map((o) => o.key)).toEqual(["p/3"]);
    expect(next.truncated).toBe(false);
    expect(next.objects[0].uploaded).toBeInstanceOf(Date);
  });

  it("refuses a value over 1 MiB", async () => {
    await expect(r2.put("big", "x".repeat(1024 * 1024 + 1))).rejects.toThrow(/1 MiB/);
    expect(await r2.head("big")).toBeNull();
  });

  it("counts writes", async () => {
    await r2.put("x", "1");
    expect(meter.rows).toBeGreaterThanOrEqual(1);
  });
});

describe("doStorageOver and doNamespaceOver (RunLock's storage, per instance name)", () => {
  it("two instance names never see each other's keys", async () => {
    const a = doStorageOver(sql, "singleton", meter);
    const b = doStorageOver(sql, "lab:az104-01-x", meter);
    await a.put("snapshot", { state: "running" });
    await a.put("act:1", { action: "extend", expiresAt: 1 });
    await b.put("lock", { runId: "r", since: "s", expiresAt: 2 });
    expect(await a.get("snapshot")).toEqual({ state: "running" });
    expect(await b.get("snapshot")).toBeUndefined();
    expect([...(await a.list({ prefix: "act:" })).keys()]).toEqual(["act:1"]);
    expect([...(await b.list({ prefix: "" })).keys()]).toEqual(["lock"]);
    expect(await a.delete("snapshot")).toBe(true);
    expect(await a.delete("snapshot")).toBe(false);
    expect(meter.rows).toBeGreaterThanOrEqual(3);
  });

  it("a prefix is matched literally (no LIKE wildcards)", async () => {
    const a = doStorageOver(sql, "singleton", meter);
    await a.put("a_b", 1);
    await a.put("axb", 2);
    expect([...(await a.list({ prefix: "a_" })).keys()]).toEqual(["a_b"]);
  });

  it("the namespace runs RunLock's own handling (lockFetch) on demo storage, one instance per name", async () => {
    const ns = doNamespaceOver(sql, meter);
    const one = ns.get(ns.idFromName("singleton"));
    const r = await one.fetch("https://lock/snapshot", { method: "POST", body: JSON.stringify({ patch: { state: "running" } }) });
    expect(((await r.json()) as { snapshot: { state: string } }).snapshot.state).toBe("running");
    const got = (await (await one.fetch("https://lock/snapshot")).json()) as { snapshot: { state: string } };
    expect(got.snapshot.state).toBe("running");
    const lab = ns.get(ns.idFromName("lab:az104-01-x"));
    expect(((await (await lab.fetch("https://lock/snapshot")).json()) as { snapshot: unknown }).snapshot).toBeNull();
    const acq = await lab.fetch("https://lock/acquire", { method: "POST", body: JSON.stringify({ runId: "r1" }) });
    expect(acq.status).toBe(200);
    expect(((await (await one.fetch("https://lock/status")).json()) as { held: boolean }).held).toBe(false);
  });
});
