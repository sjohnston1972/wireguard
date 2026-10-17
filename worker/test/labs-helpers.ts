// labs-helpers.ts
//
// Plain English: the lab engine's test bench (plan L2). A small catalogue of
// its own (so a lab.yaml change in labs/ never moves these tests), a signed-in
// API with the permission check passed, and the steps a lab run goes through
// from the outside: collect its secrets, report its result, ask to peer.
// Each lab takes its exam and cloud from its id; withAwsLabs() adds three
// AWS labs (AWS labs spec §6) beside the Azure ones.

import { vi } from "vitest";
import { apiEnv, api } from "./api-helpers";
import type { World } from "./harness";
import type { Env } from "../src/env";
import { setCatalogueForTest } from "../src/labs/catalogue";
import { issueLabSecrets, handleLabCallback, handleLabPeer } from "../src/labs/callbacks";
import { startLabRun } from "../src/labs/engine";
import type { LabRunDb } from "../src/labs/store";
import { cloudOfId, examOfId, type LabCatalogue, type LabDef, type LabExam } from "../../shared/labs";

/** The skill area a test lab names by default: one of its own exam. */
const AREA: Partial<Record<LabExam, string>> = { "AZ-104": "az104.storage", "AZ-305": "az305.infra", "SOA-C03": "soa.reliability", "SAA-C03": "saa.resilient" };

const base = (id: string, number: number, over: Partial<LabDef> = {}): LabDef => ({
  id,
  number,
  cloud: cloudOfId(id),
  version: 1,
  title: `Lab ${number}`,
  summary: `Lab ${number} summary.`,
  exam: examOfId(id),
  exams: [examOfId(id)],
  skill_areas: [AREA[examOfId(id)] ?? "az104.storage"],
  level: "associate",
  type: "explore",
  prerequisites: [],
  cost: { items: [{ name: "Storage account", gbp_h: 0.01 }], pricey: null },
  timing: { deploy_min: 3, destroy_min: 3, session_h: 2, max_h: 6 },
  capacity: { vm_sizes: [], instance_types: [] },
  regions: { secondary: null },
  connectivity: { peering: "off", dns_link: false, subnets_used: 0 },
  identity: { creates: [], roles: [], governance: false },
  ...over,
});

/** Labs 1, 5, 6, 7 and 28, shaped like the real ones but with round numbers. */
export const TEST_LABS: LabDef[] = [
  base("az104-01-identity", 1, { title: "Identity", identity: { creates: ["user", "group"], roles: [{ role: "Reader", scope: "resource_group" }], governance: true }, timing: { deploy_min: 2, destroy_min: 2, session_h: 1, max_h: 4 } }),
  base("az104-05-storage", 5, { title: "Storage accounts" }),
  base("az104-06-blob-security", 6, {
    title: "Blob security",
    cost: { items: [{ name: "Storage account", gbp_h: 0.0001 }, { name: "Private endpoint", gbp_h: 0.0076, retail: { meter: "Standard Private Endpoint", unit: "1 Hour" } }], pricey: null },
    connectivity: { peering: "optional", dns_link: true, subnets_used: 1 },
    identity: { creates: ["group"], roles: [{ role: "Storage Blob Data Reader", scope: "resource_group" }], governance: false },
    timing: { deploy_min: 4, destroy_min: 3, session_h: 2, max_h: 6 },
  }),
  base("az104-07-files", 7, {
    title: "Azure Files",
    cost: { items: [{ name: "Linux VM, Standard_B1s", gbp_h: 0.0083, retail: { sku: "Standard_B1s" } }, { name: "OS disk", gbp_h: 0.0034 }], pricey: null },
    capacity: { vm_sizes: ["Standard_B1s"], instance_types: [] },
    connectivity: { peering: "optional", dns_link: false, subnets_used: 1 },
  }),
  base("az305-28-hub-spoke-fw", 28, {
    title: "Hub-spoke with Azure Firewall",
    cost: { items: [{ name: "Azure Firewall Basic", gbp_h: 0.4 }, { name: "Public IPs", gbp_h: 0.01, qty: 2 }], pricey: "Azure Firewall Basic" },
    timing: { deploy_min: 15, destroy_min: 10, session_h: 2, max_h: 3 },
    connectivity: { peering: "required", dns_link: false, subnets_used: 2 },
  }),
];

export const TEST_CATALOGUE: LabCatalogue = {
  schema: 2,
  skillAreas: [
    { key: "az104.storage", exam: "AZ-104", name: "Implement and manage storage" },
    { key: "az305.infra", exam: "AZ-305", name: "Design infrastructure solutions" },
  ],
  labs: TEST_LABS,
  readmes: { "az104-05-storage": [{ t: "h", level: 2, text: "What it deploys" }] },
  // Lab 6 has learning content and a planned diagram; lab 5 a diagram only; the others neither.
  learning: {
    "az104-06-blob-security": {
      objective: "Control who reaches one blob container with keys and SAS tokens, Entra roles and a private endpoint.",
      learn: ["Make a SAS from a stored access policy and revoke it", "Grant blob data access to an Entra group", "Resolve the account to a private endpoint address"],
      learning_min: 50,
    },
  },
  resources: {
    "az104-05-storage": { resourceGroup: 1, storage: 2 },
    "az104-06-blob-security": { entraPrincipal: 1, privateDnsZone: 1, privateEndpoint: 1, resourceGroup: 1, storage: 1, subnet: 1, vnet: 1 },
  },
};

/** AWS labs 3, 5, 7, 9, 16 and 31 (AWS labs spec §12.2), shaped like the real ones: lab 3 bills its load balancer per started hour (A20), lab 16 uses Ireland too, lab 31 hands out files (ruling P2). */
export const AWS_TEST_LABS: LabDef[] = [
  base("soa-03-auto-scaling", 3, {
    title: "Auto Scaling behind a load balancer",
    cost: {
      items: [
        { name: "ALB, hourly", gbp_h: 0.0199, whole_hours: true, aws_price: { service: "AWSELB", unit: "Hrs", filters: { productFamily: "Load Balancer-Application", usagetype: "{usage}-LoadBalancerUsage" } } },
        { name: "EC2 t4g.micro", gbp_h: 0.0071, qty: 2, aws_price: { service: "AmazonEC2", unit: "Hrs", filters: { instanceType: "t4g.micro", operatingSystem: "Linux", tenancy: "Shared", preInstalledSw: "NA", capacitystatus: "Used" } } },
      ],
      pricey: null,
    },
    capacity: { vm_sizes: [], instance_types: ["t4g.micro", "t4g.micro"] },
    connectivity: { peering: "optional", dns_link: false, subnets_used: 1 },
  }),
  base("soa-05-rds", 5, { title: "RDS Multi-AZ and a read replica", connectivity: { peering: "optional", dns_link: false, subnets_used: 1 } }),
  base("soa-07-iam-kms", 7, { title: "IAM, permission boundaries and KMS", connectivity: { peering: "off", dns_link: false, subnets_used: 0 } }),
  base("soa-09-route53-cloudfront", 9, { title: "Route 53 routing and CloudFront in front of S3", connectivity: { peering: "off", dns_link: false, subnets_used: 0 } }),
  base("ans-31-client-vpn", 31, {
    title: "AWS Client VPN with certificates, compared with WireGuard",
    exam: "ANS-C01",
    exams: ["ANS-C01"],
    capacity: { vm_sizes: [], instance_types: ["t4g.micro"] },
    connectivity: { peering: "optional", dns_link: false, subnets_used: 1 },
  }),
  base("saa-16-dr-pilot-light", 16, { title: "Pilot-light disaster recovery", regions: { secondary: "eu-west-1" }, connectivity: { peering: "optional", dns_link: false, subnets_used: 1 } }),
  base("ans-26-edge", 26, { title: "Global edge: CloudFront, WAF and Global Accelerator", exam: "ANS-C01", exams: ["ANS-C01"], regions: { secondary: "eu-west-1" }, connectivity: { peering: "optional", dns_link: false, subnets_used: 1 } }),
];

/** The test catalogue with the AWS labs added (and the SOA and SAA skill areas they name). */
export function withAwsLabs(): void {
  setCatalogueForTest({
    ...TEST_CATALOGUE,
    labs: [...TEST_LABS, ...AWS_TEST_LABS],
    skillAreas: [...TEST_CATALOGUE.skillAreas, { key: "soa.reliability", exam: "SOA-C03", name: "Reliability and Business Continuity" }, { key: "saa.resilient", exam: "SAA-C03", name: "Design Resilient Architectures" }],
  });
}

export const NOW = "2026-10-04T12:00:00.000Z";

/** Freeze the clock (Date only) at `at`. */
export function freeze(at = NOW): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(at));
}

/** Move the frozen clock on by `ms`. */
export function advance(ms: number): Date {
  const t = new Date(Date.now() + ms);
  vi.setSystemTime(t);
  return t;
}

export const MIN = 60_000;
export const HOUR = 3_600_000;

/** A signed-in API on the test catalogue, with the permission check passed (the AWS ticks too). */
export async function labEnv(overrides: Partial<Env> = {}): Promise<{ env: Env; world: World }> {
  setCatalogueForTest(TEST_CATALOGUE);
  const r = apiEnv(overrides);
  await r.env.STATUS.put("labs:permissions", JSON.stringify({ checkedAt: NOW, role: true, users: true, groups: true, awsRole: true, awsBoundary: true, awsCostTag: true, message: null }));
  return r;
}

/** The GitHub run id the harness gave the dispatch of our run `runId`. */
export function ghIdFor(world: World, runId: string): number {
  const r = [...world.ghRuns.values()].find((x) => x.display_title.endsWith(` ${runId}`));
  if (!r) throw new Error(`no GitHub run for ${runId}`);
  return r.id;
}

/** The lab workflows' dispatches (lab.yml and lab-aws.yml), newest last. */
export const labDispatches = (world: World) => world.dispatches.filter((d) => d.workflow === "lab.yml" || d.workflow === "lab-aws.yml");

/** Collect a lab run's secrets as its workflow would (after the OIDC check). */
export async function secrets(env: Env, world: World, runId: string): Promise<{ callback_token: string; admin_password: string }> {
  const r = await issueLabSecrets(env, runId, ghIdFor(world, runId));
  if (r.status !== 200) throw new Error(`secrets: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as { callback_token: string; admin_password: string };
}

/** Report a lab run's result as step 16 does. */
export async function report(env: Env, runId: string, token: string, status: string, outputs: Record<string, unknown> = {}, action?: string) {
  const row = await env.DB.prepare("SELECT action FROM lab_runs WHERE id = ?1").bind(runId).first<{ action: string }>();
  return handleLabCallback(env, token, { run_id: runId, action: action ?? row?.action ?? "deploy", status, outputs });
}

export const peer = (env: Env, token: string, body: unknown) => handleLabPeer(env, token, body);

/** Deploy a lab through the API; returns the session and run ids. */
export async function deployLab(env: Env, id: string, body: Record<string, unknown> = { hours: 2, peer: false }) {
  const r = await api(env, "POST", `/labs/${id}/deploy`, body);
  return r;
}

/** Deploy and finish the deploy with a successful result. */
export async function runningLab(env: Env, world: World, id: string, body: Record<string, unknown> = { hours: 2, peer: false }, outputs: Record<string, unknown> = { private_ips: { vm: "10.64.0.4" }, connect: ["ssh azureuser@10.64.0.4"], clean: true, leftovers: [], deploy_seconds: 120, destroy_seconds: 0 }) {
  const r = await deployLab(env, id, body);
  if (r.status !== 200) throw new Error(`deploy ${id}: ${r.status} ${r.text}`);
  const runId = r.json.runId as string;
  const sid = r.json.sessionId as string;
  const s = await secrets(env, world, runId);
  const done = await report(env, runId, s.callback_token, "success", outputs);
  if (done.status !== 200) throw new Error(`callback: ${done.status} ${JSON.stringify(done.body)}`);
  return { sid, runId, token: s.callback_token, password: s.admin_password };
}

/** Start a peer run for a session and collect its secrets, as its workflow would: the run and its callback token. */
export async function peerRunFor(env: Env, world: World, sid: string): Promise<{ run: LabRunDb; token: string }> {
  const run = await startLabRun(env, sid, "peer", "steven", "peer to the gateway");
  const s = await secrets(env, world, run.id);
  return { run, token: s.callback_token };
}

export const session = (env: Env, sid: string) => env.DB.prepare("SELECT * FROM lab_sessions WHERE id = ?1").bind(sid).first<Record<string, any>>();
export const labRun = (env: Env, id: string) => env.DB.prepare("SELECT * FROM lab_runs WHERE id = ?1").bind(id).first<Record<string, any>>();
export const rows = async <T = Record<string, any>>(env: Env, sql: string, ...args: unknown[]) => (await env.DB.prepare(sql).bind(...args).all<T>()).results;
export { api };
