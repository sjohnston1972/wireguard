// topology-capture-keep.test.ts: scripts/topology-capture.mjs keeps every property path the live builder and its rules
// (shared/topology/live.ts, rules/live.ts) read, so a captured fixture can prove every live edge and fold.
//
// How: every live fixture's rows (the hand-written families, the captured labs, every lab's planned graph turned into
// rows, the hand-made and made-by-Azure rows) go through liveGraph with each row's properties wrapped in a Proxy that
// records the path of every read ("ipConfigurations[].properties.subnet.id"). A read path must be inside a kept path
// (a leaf, or a whole subtree the code walks for ARM ids), or lead to one (an object, or a property the row lacks).
// The one walk left out is a generic card's last-resort search of its whole properties for a subnet id.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { liveGraph, type ArgRow } from "../../shared/topology/live";
import { ARM_RULES } from "../../shared/topology/rules/live";
import { CAPTURE_COLUMNS, CAPTURE_KEEP } from "../../scripts/topology-capture.mjs";
import { LAB_IDS, liveCtxFor, plannedOf } from "./fixtures/topology/round-trip";
import { rowsFromPlanned } from "./fixtures/topology/rows-from-planned";
import { CAPTURED, capturedRows } from "./fixtures/topology/captured";

type ReadKind = "leaf" | "object" | "absent";
interface Reads {
  /** path → how it was read, per row. */
  reads: Map<string, ReadKind>;
  /** Paths whose object was walked key by key (Object.values, JSON): the whole subtree is needed. */
  walked: Set<string>;
}

const OBJECT_PROTO = new Set(Object.getOwnPropertyNames(Object.prototype));

/** A row whose properties (and top-level columns) record every read. */
function instrument(row: ArgRow, into: { props: Reads; columns: Set<string> }): ArgRow {
  const wrap = (v: unknown, path: string): unknown => {
    if (!v || typeof v !== "object") return v;
    return new Proxy(v as object, {
      get(t, k, recv) {
        const val = Reflect.get(t, k, recv);
        if (typeof k === "symbol") return val;
        let child: string;
        if (Array.isArray(t)) {
          if (!/^\d+$/.test(k)) return val; // length, map, filter...
          child = `${path}[]`;
        } else {
          if (OBJECT_PROTO.has(k) && !Object.prototype.hasOwnProperty.call(t, k)) return val;
          child = path ? `${path}.${k}` : k;
        }
        const kind: ReadKind = val === undefined ? "absent" : val && typeof val === "object" ? "object" : "leaf";
        const prev = into.props.reads.get(child);
        if (!prev || prev === "absent" || kind === "leaf") into.props.reads.set(child, kind);
        return wrap(val, child);
      },
      ownKeys(t) {
        into.props.walked.add(path);
        return Reflect.ownKeys(t);
      },
    });
  };
  const top = new Proxy(row as object, {
    get(t, k, recv) {
      const val = Reflect.get(t, k, recv);
      if (typeof k !== "string" || OBJECT_PROTO.has(k)) return val;
      into.columns.add(k);
      return k === "properties" ? wrap(val, "") : val;
    },
  });
  return top as ArgRow;
}

const LIVE = new URL("./fixtures/topology/live/", import.meta.url);
const json = (u: URL) => JSON.parse(readFileSync(u, "utf8")) as Record<string, unknown>;

/** The lab a fixture's rows belong to: the catalogue id whose primary group holds most of them. */
const labOf = (rows: ArgRow[]): string => {
  const count = new Map<string, number>();
  for (const r of rows) for (const id of LAB_IDS) if (r.resourceGroup === `rg-lab-${id}` || r.resourceGroup?.startsWith(`rg-lab-${id}-`)) count.set(id, (count.get(id) ?? 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "az104-13-vnets";
};

/** Rows (shapes from the ARM reference) of the rule types no fixture has: a log alert and a flow log. */
const RG = "/subscriptions/00000000-0000-4000-8000-000000000000/resourceGroups/rg-lab-az104-18-monitor";
const EXTRA: ArgRow[] = [
  { id: `${RG}/providers/Microsoft.OperationalInsights/workspaces/log-lab`, name: "log-lab", type: "microsoft.operationalinsights/workspaces", resourceGroup: "rg-lab-az104-18-monitor", properties: { provisioningState: "Succeeded", retentionInDays: 30 } },
  { id: `${RG}/providers/Microsoft.Insights/actionGroups/ag-lab`, name: "ag-lab", type: "microsoft.insights/actiongroups", resourceGroup: "rg-lab-az104-18-monitor", properties: {} },
  {
    id: `${RG}/providers/Microsoft.Insights/scheduledQueryRules/alert-errors`,
    name: "alert-errors",
    type: "microsoft.insights/scheduledqueryrules",
    resourceGroup: "rg-lab-az104-18-monitor",
    properties: { scopes: [`${RG}/providers/Microsoft.OperationalInsights/workspaces/log-lab`], actions: { actionGroups: [`${RG}/providers/Microsoft.Insights/actionGroups/ag-lab`] } },
  },
  {
    id: `${RG}/providers/Microsoft.Network/networkWatchers/nw-lab/flowLogs/fl-lab`,
    name: "fl-lab",
    type: "microsoft.network/networkwatchers/flowlogs",
    resourceGroup: "rg-lab-az104-18-monitor",
    properties: {
      targetResourceId: `${RG}/providers/Microsoft.OperationalInsights/workspaces/log-lab`,
      storageId: `${RG}/providers/Microsoft.Insights/actionGroups/ag-lab`,
      retentionPolicy: { enabled: true, days: 7 },
      flowAnalyticsConfiguration: { networkWatcherFlowAnalyticsConfiguration: { enabled: true, workspaceResourceId: `${RG}/providers/Microsoft.OperationalInsights/workspaces/log-lab` } },
    },
  },
];

/** Every row set the live tests run, each with its lab. */
function rowSets(): { name: string; labId: string; rows: ArgRow[]; prefix?: string }[] {
  const out: { name: string; labId: string; rows: ArgRow[]; prefix?: string }[] = [];
  for (const f of readdirSync(LIVE).filter((x) => x.endsWith(".json"))) {
    const fx = json(new URL(f, LIVE));
    if (Array.isArray(fx.rows)) out.push({ name: f, labId: labOf(fx.rows as ArgRow[]), rows: fx.rows as ArgRow[] });
    if (fx.families) for (const [k, fam] of Object.entries(fx.families as Record<string, { lab: string; known: ArgRow; unknown: ArgRow }>)) out.push({ name: `${f} ${k}`, labId: fam.lab, rows: [...rowsFromPlanned(plannedOf(fam.lab)), fam.known, fam.unknown] });
    if (fx.azureMade) for (const a of fx.azureMade as { pattern: string; row: ArgRow }[]) out.push({ name: `${f} ${a.pattern}`, labId: labOf([a.row]), rows: [a.row] });
  }
  for (const [labId, prefix] of Object.entries(CAPTURED)) out.push({ name: `captured ${labId}`, labId, prefix, rows: capturedRows(labId) });
  for (const labId of LAB_IDS) out.push({ name: `planned ${labId}`, labId, rows: rowsFromPlanned(plannedOf(labId)) });
  out.push({ name: "rule types no other fixture has", labId: "az104-18-monitor", rows: EXTRA });
  return out;
}

const within = (r: string, k: string) => r === k || r.startsWith(`${k}.`) || r.startsWith(`${k}[]`);

describe("the capture's keep list (scripts/topology-capture.mjs)", () => {
  // Every read, by row type.
  const byType = new Map<string, Reads>();
  const columns = new Set<string>();
  const generic = new Set<string>();
  for (const set of rowSets()) {
    const ctx = liveCtxFor(set.labId, set.prefix ? { namePrefix: set.prefix } : {});
    // A generic card searches its whole properties for a subnet (the last resort): its rows are not counted.
    for (const n of liveGraph(set.rows, ctx).nodes) if (n.kind === "generic") generic.add(n.id);
    const rows = set.rows.map((r) => {
      if (!r || generic.has(String(r.id).toLowerCase())) return r;
      const t = String(r.type).toLowerCase();
      if (!byType.has(t)) byType.set(t, { reads: new Map(), walked: new Set() });
      return instrument(r, { props: byType.get(t)!, columns });
    });
    liveGraph(rows, ctx);
  }

  it("the rules were seen reading (the instrument works), and every rule's type had a row to read", () => {
    expect(byType.get("microsoft.network/virtualnetworks")?.reads.get("subnets[].properties.addressPrefix")).toBe("leaf");
    expect(Object.keys(ARM_RULES).filter((t) => !byType.has(t)).sort()).toEqual([]);
  });

  it("every property path read is kept: a leaf or walked subtree inside a kept path, an object or missing property on the way to one", () => {
    const keep = [...CAPTURE_KEEP];
    const problems: string[] = [];
    for (const [type, { reads, walked }] of [...byType].sort()) {
      for (const [path, kind] of reads) {
        const inside = keep.some((k) => within(path, k));
        const toward = keep.some((k) => within(k, path));
        if (!(inside || (kind !== "leaf" && toward))) problems.push(`${type}: ${path} (${kind})`);
      }
      for (const path of walked) if (path && !keep.some((k) => within(path, k))) problems.push(`${type}: ${path} (walked: keep it whole)`);
    }
    expect([...new Set(problems.map((p) => p.replace(/^[^:]+: /, "")))].sort(), problems.join("\n")).toEqual([]);
  });

  it("no kept path is inside another (a narrower path after a wider one would cut the wider one down)", () => {
    const keep = [...CAPTURE_KEEP];
    expect(keep.filter((p, i) => keep.some((k, j) => j !== i && within(p, k)))).toEqual([]);
  });

  it("every column read is kept, but identity (dropped on purpose: principal ids) and tags (only lab and project)", () => {
    expect([...columns].filter((c) => ![...CAPTURE_COLUMNS, "properties", "identity", "tags"].includes(c)).sort()).toEqual([]);
  });
});
