// demo-routes.ts
//
// Plain English: the table behind demo mode's "every read" proofs (spec
// §9.2, §9.4): each GET route the API registers, mapped to the concrete
// addresses that exercise it, with the demo's own ids filled in and every
// query variant the app sends. demo-outbound.test.ts fails when a registered
// GET is missing from it; demo-journey.test.ts walks it.
import { api } from "./api-helpers";
import { demoInstance } from "./harness";
import { buildApi } from "../src/api";
import type { Env } from "../src/env";

/** The demo's own ids, read from the demo store's database. */
export type Ids = { peer: number; run: string; finishedRun: string; labRun: string; lab: string; idleLab: string; day: string };

const RANGES = ["1h", "24h", "7d", "30d"];

/** Every registered GET pattern → the concrete addresses that exercise it (spec §9.2's table). */
export const TABLE: Record<string, (ids: Ids) => string[]> = {
  "/session": () => ["/session"],
  "/overview": () => ["/overview"],
  "/ssh-password": () => ["/ssh-password"],
  "/history": (i) => [
    ...RANGES.map((r) => `/history?scope=vm&range=${r}`),
    ...RANGES.map((r) => `/history?scope=client&id=${i.peer}&range=${r}`),
    "/history?scope=rule&id=default&range=24h",
    "/history?scope=rule&id=r1&range=7d",
    "/history?scope=rule&id=f1&range=30d",
    "/history?scope=client&id=99999&range=24h",
    "/history?range=24h",
  ],
  "/clients": () => ["/clients"],
  "/clients/:id": (i) => [`/clients/${i.peer}`, "/clients/99999"],
  "/firewall": () => ["/firewall"],
  "/activity": () => ["/activity", ...["1h", "6h", "24h", "7d", "30d"].map((r) => `/activity?range=${r}`), "/activity?range=30d&kind=deploy", "/activity?range=30d&q=client&page=2"],
  "/runs/:id": (i) => [`/runs/${i.run}`, `/runs/${i.finishedRun}`, `/runs/${i.labRun}`, "/runs/no-such-run"],
  "/runs/:id/log": (i) => [`/runs/${i.run}/log`, `/runs/${i.finishedRun}/log`, `/runs/${i.labRun}/log`, "/runs/no-such-run/log"],
  "/cost": () => ["/cost", "/cost?range=month", "/cost?range=7d", "/cost?range=30d"],
  "/settings": () => ["/settings"],
  "/backup/export": () => ["/backup/export"],
  "/backup/config/:day": (i) => [`/backup/config/${i.day}`, "/backup/config/2001-01-01"],
  "/push/status": () => ["/push/status", "/push/status?endpoint=https%3A%2F%2Fpush.example.invalid%2Fx"],
  "/prefs": () => ["/prefs"],
  "/prefs/topology/:labId": (i) => [`/prefs/topology/${i.lab}`],
  "/azure/summary": () => ["/azure/summary"],
  "/azure/metrics": () => ["vm", "pip", "vitals"].flatMap((res) => RANGES.map((r) => `/azure/metrics?resource=${res}&range=${r}`)),
  "/azure/changes": () => ["/azure/changes", ...["24h", "7d", "30d", "90d"].flatMap((r) => ["all", "others", "wgadmin"].map((w) => `/azure/changes?range=${r}&who=${w}`))],
  "/azure/service-health": () => ["/azure/service-health", "/azure/service-health?range=7d", "/azure/service-health?range=90d"],
  "/azure/capacity": () => ["/azure/capacity?region=uksouth&size=Standard_B1s", "/azure/capacity?region=westeurope&size=Standard_B2s", "/azure/capacity"],
  "/azure/price": () => ["/azure/price?region=uksouth&size=Standard_B1s", "/azure/price?region=westeurope&size=Standard_B2s"],
  "/azure/diagnostics": () => ["/azure/diagnostics"],
  "/azure/bootlog": () => ["/azure/bootlog"],
  "/labs": () => ["/labs"],
  "/labs/sessions": (i) => ["/labs/sessions", `/labs/sessions?lab=${i.lab}&limit=5`],
  "/labs/coverage": () => ["/labs/coverage"],
  "/labs/:id": (i) => [`/labs/${i.lab}`, `/labs/${i.idleLab}`],
  "/labs/:id/topology": (i) => [`/labs/${i.lab}/topology`, `/labs/${i.idleLab}/topology`],
  "/labs/:id/secret": (i) => [`/labs/${i.lab}/secret`, `/labs/${i.idleLab}/secret`],
  "/labs/:id/guide.pdf": (i) => [`/labs/${i.lab}/guide.pdf`, `/labs/${i.idleLab}/guide.pdf`],
};

/** Every GET pattern registered on buildApi(), demo's own switch aside. */
export function registeredGets(): string[] {
  return [...new Set(buildApi().routes.filter((r) => r.method === "GET" && r.path !== "/demo").map((r) => r.path))];
}

export async function demoIds(env: Env): Promise<Ids> {
  const q = (sql: string) => demoInstance(env).state.sql.exec(sql).toArray();
  const settings = (await api(env, "GET", "/settings")).json;
  const running = q("SELECT lab_id FROM lab_sessions WHERE state = 'running' ORDER BY requested_at DESC LIMIT 1")[0];
  const labs = (await api(env, "GET", "/labs")).json;
  const lab = String(running?.lab_id ?? labs.labs[0].id);
  return {
    peer: Number(q("SELECT id FROM peers ORDER BY id LIMIT 1")[0].id),
    run: String(q("SELECT id FROM runs ORDER BY requested_at DESC LIMIT 1")[0].id),
    finishedRun: String(q("SELECT id FROM runs WHERE finished_at IS NOT NULL AND github_run_id IS NOT NULL ORDER BY requested_at DESC LIMIT 1")[0].id),
    labRun: String(q("SELECT id FROM lab_runs ORDER BY requested_at DESC LIMIT 1")[0].id),
    lab,
    idleLab: String(labs.labs.find((l: { id: string }) => l.id !== lab).id),
    day: String(settings.backups.config.days[0]),
  };
}

