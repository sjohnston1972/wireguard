// backup.ts
//
// Plain English: the spare set of keys. Two kinds of backup live in R2:
//   backups/*.tfstate          Terraform's record of what it built in Azure,
//                              copied by GitHub Actions after every run (the
//                              workflow keeps the last 20)
//   config-backups/<day>.json  the dashboard's own data, written by the
//                              night watchman once a day (the last 30 kept):
//                              clients, firewall rules, published ports,
//                              profiles, schedules, phones signed up for
//                              alerts, and the Settings page's changes
//
// The config export is also what "Download export" hands you and what
// "Restore from file" reads back. Nothing secret goes in it: no SSH
// passwords, no run tokens (those live in the runs table, which is not
// exported), and never a client's private key (the Worker does not have
// them; only public keys are stored).

import type { Env } from "./env";
import { OVERRIDABLE } from "./settings";
import { isWgKey } from "./peers";

/** What the file says it is, and the format version this code writes and reads. */
export const EXPORT_KIND = "wg-admin-config";
export const EXPORT_VERSION = 1;

/** How many nightly exports to keep in R2. */
export const KEEP_CONFIG_BACKUPS = 30;

/** Biggest restore file accepted. A home setup's export is a few KB. */
export const MAX_RESTORE_BYTES = 1_000_000;

/**
 * The tables in an export, by the name used in the file, and the D1 table
 * each one is. Order matters on restore only for readability; all of it goes
 * in as one all-or-nothing batch.
 */
export const EXPORT_TABLES = {
  peers: "peers",
  fw_rules: "fw_rules",
  forwards: "fw_forwards",
  profiles: "profiles",
  schedules: "schedules",
  push_subs: "push_subs",
  settings: "settings",
} as const;
export type ExportTable = keyof typeof EXPORT_TABLES;

/** Plain English names for the preview. */
export const TABLE_LABEL: Record<ExportTable, string> = {
  peers: "Clients",
  fw_rules: "Firewall rules",
  forwards: "Published ports",
  profiles: "Profiles",
  schedules: "Schedules",
  push_subs: "Phones for alerts",
  settings: "Settings changes",
};

/**
 * A safety net: any column whose name sounds secret is left out of an export
 * and refused in a restore file, even if a future table grows one.
 */
const SECRET_COLUMN = /password|token|secret|private/i;

type Row = Record<string, string | number | null>;

export interface ConfigExport {
  kind: typeof EXPORT_KIND;
  version: number;
  exported_at: string;
  tables: Record<ExportTable, Row[]>;
}

/** The dashboard's data as one JSON-ready object. */
export async function buildExport(env: Env, now = new Date()): Promise<ConfigExport> {
  const tables = {} as Record<ExportTable, Row[]>;
  for (const [name, table] of Object.entries(EXPORT_TABLES) as [ExportTable, string][]) {
    let rows = (await env.DB.prepare(`SELECT * FROM ${table} ORDER BY ${table === "settings" ? "key" : "id"}`).all<Row>()).results;
    // Settings: only the values the Settings page can change, nothing internal.
    if (name === "settings") rows = rows.filter((r) => Object.hasOwn(OVERRIDABLE, String(r.key)));
    tables[name] = rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !SECRET_COLUMN.test(k))));
  }
  return { kind: EXPORT_KIND, version: EXPORT_VERSION, exported_at: now.toISOString(), tables };
}

/** The file name a download or a nightly copy gets. */
export function exportFileName(day: string): string {
  return `wg-admin-config-${day}.json`;
}

// ── Nightly copy ──────────────────────────────────────────────────────────

/**
 * Once a UTC day: write the export to R2 as config-backups/<day>.json and
 * drop all but the newest 30. Returns a note for the watchman's log, or null
 * when today's copy is already there.
 */
export async function nightlyConfigBackup(env: Env, now = new Date()): Promise<string | null> {
  const day = now.toISOString().slice(0, 10);
  if ((await env.STATUS.get("config-backup:day")) === day) return null;
  const exp = await buildExport(env, now);
  await env.STATE.put(`config-backups/${day}.json`, JSON.stringify(exp, null, 1), { httpMetadata: { contentType: "application/json" } });
  await env.STATUS.put("config-backup:day", day);
  // Day names sort in date order, so everything before the newest 30 goes.
  const keys = (await listKeys(env, "config-backups/")).map((o) => o.key).sort();
  const old = keys.slice(0, Math.max(0, keys.length - KEEP_CONFIG_BACKUPS));
  if (old.length) await env.STATE.delete(old);
  await env.STATUS.delete("backup:status");
  return `config backup: ${day} written${old.length ? `, ${old.length} old one(s) removed` : ""}`;
}

// ── What is in R2 ─────────────────────────────────────────────────────────

/** Every object under a prefix (R2 hands them out a page at a time). */
async function listKeys(env: Env, prefix: string): Promise<{ key: string; uploaded: Date }[]> {
  const out: { key: string; uploaded: Date }[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const r = await env.STATE.list({ prefix, cursor });
    out.push(...r.objects.map((o) => ({ key: o.key, uploaded: o.uploaded })));
    if (!r.truncated) break;
    cursor = r.cursor;
  }
  return out;
}

export interface BackupSet {
  count: number;
  /** When the newest one was written (ISO), or null when there are none. */
  newest: string | null;
}

export interface BackupStatus {
  state: BackupSet;
  config: BackupSet & { days: string[] };
  checked_at: string;
  error?: string;
}

function summarise(objs: { key: string; uploaded: Date }[]): BackupSet {
  const newest = objs.reduce<Date | null>((m, o) => (!m || o.uploaded > m ? o.uploaded : m), null);
  return { count: objs.length, newest: newest ? newest.toISOString() : null };
}

/**
 * How many backups of each kind R2 holds, and the newest. The Overview asks
 * every 20 seconds, so the answer is kept for 10 minutes unless `fresh`.
 */
export async function backupStatus(env: Env, fresh = false): Promise<BackupStatus> {
  if (!fresh) {
    const cached = await env.STATUS.get<BackupStatus>("backup:status", "json").catch(() => null);
    if (cached) return cached;
  }
  let status: BackupStatus;
  try {
    const [state, config] = await Promise.all([listKeys(env, "backups/"), listKeys(env, "config-backups/")]);
    const tf = state.filter((o) => o.key.endsWith(".tfstate"));
    const days = config.map((o) => o.key.match(/^config-backups\/(\d{4}-\d{2}-\d{2})\.json$/)?.[1]).filter((d): d is string => !!d).sort().reverse();
    status = { state: summarise(tf), config: { ...summarise(config), days }, checked_at: new Date().toISOString() };
  } catch (e) {
    return { state: { count: 0, newest: null }, config: { count: 0, newest: null, days: [] }, checked_at: new Date().toISOString(), error: (e as Error).message };
  }
  await env.STATUS.put("backup:status", JSON.stringify(status), { expirationTtl: 600 }).catch(() => {});
  return status;
}

// ── Restore ───────────────────────────────────────────────────────────────

export interface RestorePlan {
  exported_at: string;
  /** Rows per table in the file. */
  counts: Record<ExportTable, number>;
  tables: Record<ExportTable, Row[]>;
}

/** The columns a table has today, and which of them must be given. */
async function tableColumns(env: Env, table: string): Promise<{ all: Set<string>; required: string[] }> {
  const info = (await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string; notnull: number; dflt_value: unknown; pk: number }>()).results;
  return { all: new Set(info.map((c) => c.name)), required: info.filter((c) => c.notnull && c.dflt_value === null && !c.pk).map((c) => c.name) };
}

/**
 * Check a restore file before anything is touched. Returns the plan, or a
 * plain-English reason it cannot be used. Nothing is written here.
 */
export async function checkRestoreFile(env: Env, text: string): Promise<RestorePlan | string> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return "That file is not JSON. Pick a wg-admin-config-….json file from Download export or R2.";
  }
  const d = data as Partial<ConfigExport> | null;
  if (!d || typeof d !== "object" || d.kind !== EXPORT_KIND) return "That is not a wg-admin config export.";
  if (!Number.isInteger(d.version) || d.version! < 1) return "The file has no format version.";
  if (d.version! > EXPORT_VERSION) return `That export was made by a newer wg-admin (format ${d.version}); this one reads format ${EXPORT_VERSION}.`;
  if (!d.tables || typeof d.tables !== "object") return "The file has no tables in it.";
  const tables = {} as Record<ExportTable, Row[]>;
  const counts = {} as Record<ExportTable, number>;
  for (const [name, table] of Object.entries(EXPORT_TABLES) as [ExportTable, string][]) {
    const rows = (d.tables as Record<string, unknown>)[name];
    if (!Array.isArray(rows)) return `The file is missing the ${TABLE_LABEL[name]} list.`;
    if (rows.length > 5000) return `${TABLE_LABEL[name]}: ${rows.length} is far more than a wg-admin ever holds.`;
    const cols = await tableColumns(env, table);
    for (const [i, row] of rows.entries()) {
      const where = `${TABLE_LABEL[name]}, entry ${i + 1}`;
      if (!row || typeof row !== "object" || Array.isArray(row)) return `${where} is not a record.`;
      for (const [k, v] of Object.entries(row)) {
        if (!cols.all.has(k)) return `${where} has a field "${k}" this wg-admin does not know.`;
        if (SECRET_COLUMN.test(k)) return `${where} has a secret field "${k}"; exports never carry those.`;
        if (v !== null && typeof v !== "string" && typeof v !== "number") return `${where}: "${k}" is not plain text or a number.`;
      }
      for (const k of cols.required) if ((row as Row)[k] === undefined || (row as Row)[k] === null) return `${where} is missing "${k}".`;
      if (name === "peers" && !isWgKey(String((row as Row).public_key))) return `${where} does not have a valid WireGuard public key.`;
      if (name === "settings") {
        const k = String((row as Row).key), ok = Object.hasOwn(OVERRIDABLE, k) ? OVERRIDABLE[k] : null;
        if (!ok) return `${where}: "${k}" is not a setting the Settings page can change.`;
        if (!ok(String((row as Row).value))) return `${where}: "${k}" has a value that does not look right.`;
      }
    }
    tables[name] = rows as Row[];
    counts[name] = rows.length;
  }
  return { exported_at: String(d.exported_at ?? "unknown"), counts, tables };
}

/** How many rows each exported table holds now, for the before/after preview. */
export async function currentCounts(env: Env): Promise<Record<ExportTable, number>> {
  const exp = await buildExport(env);
  return Object.fromEntries(Object.entries(exp.tables).map(([k, rows]) => [k, rows.length])) as Record<ExportTable, number>;
}

/**
 * Replace the exported tables with the plan's rows, in one D1 batch: either
 * all of it lands or none of it does. Settings the file does not mention go
 * back to their defaults; internal settings are left alone.
 */
export async function applyRestore(env: Env, plan: RestorePlan): Promise<void> {
  const stmts: D1PreparedStatement[] = [];
  const keys = Object.keys(OVERRIDABLE);
  for (const [name, table] of Object.entries(EXPORT_TABLES) as [ExportTable, string][]) {
    if (name === "settings") stmts.push(env.DB.prepare(`DELETE FROM settings WHERE key IN (${keys.map((_, i) => `?${i + 1}`).join(", ")})`).bind(...keys));
    else stmts.push(env.DB.prepare(`DELETE FROM ${table}`));
  }
  for (const [name, table] of Object.entries(EXPORT_TABLES) as [ExportTable, string][]) {
    for (const row of plan.tables[name]) {
      // Column names were checked against the real table in checkRestoreFile.
      const cols = Object.keys(row);
      stmts.push(env.DB.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `?${i + 1}`).join(", ")})`).bind(...cols.map((k) => row[k])));
    }
  }
  await env.DB.batch(stmts);
  await env.STATUS.delete("backup:status");
}
