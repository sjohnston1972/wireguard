// cloud/aws.ts
//
// Plain English: the AWS side of the cloud door. The headend is the EC2
// instance tagged wg-admin-role=headend; its "edge firewall" is the security
// group with the same tag. Everything wg-admin builds carries wg-admin=vpn,
// so "what exists" is simply "what carries that tag".
//
// Words are Azure's on purpose (deallocated = stopped), so the rest of the
// Worker reads one vocabulary whichever cloud answered.

import type { Env } from "../env";
import { canAws, config } from "../env";
import type { AzureInventory } from "../state";
import type { PublishedNsgRule } from "../firewall";
import type { CloudOps, HeadendView } from "./index";
import { AwsError, awsJson, ec2, filters, xmlFirst, xmlItems, xmlOwn } from "./awsApi";

const TAG: [string, string[]] = ["tag:wg-admin", ["vpn"]];
const HEADEND: [string, string[]] = ["tag:wg-admin-role", ["headend"]];
const LIVE = ["pending", "running", "stopping", "stopped", "shutting-down"];
const POWER: Record<string, string> = { running: "running", stopped: "deallocated", stopping: "deallocating", pending: "starting", "shutting-down": "deleting" };
const SSH_RULE = "ssh-from-home";

interface Headend {
  id: string;
  state: string;
  publicIp: string | null;
  type: string | null;
}

async function findHeadend(env: Env): Promise<Headend | null> {
  const xml = await ec2(env, "DescribeInstances", filters([TAG, HEADEND, ["instance-state-name", LIVE]]));
  // reservationSet -> item -> instancesSet -> item. The instance's own fields only: its network interfaces,
  // groups and tags are nested items with fields of their own (privateIpAddress, association/publicIp, ...).
  const reservation = xmlItems(xml, "reservationSet")[0];
  const instance = reservation ? xmlItems(reservation, "instancesSet")[0] : undefined;
  if (!instance) return null;
  const own = xmlOwn(instance);
  const id = xmlFirst(own, "instanceId");
  if (!id) return null;
  const state = own.match(/<instanceState>\s*<code>\d+<\/code>\s*<name>([a-z-]+)<\/name>/)?.[1] ?? "unknown";
  return { id, state, publicIp: xmlFirst(own, "ipAddress"), type: xmlFirst(own, "instanceType") };
}

async function view(env: Env): Promise<HeadendView> {
  const checked_at = new Date().toISOString();
  try {
    const [vpcs, h, addrs] = await Promise.all([ec2(env, "DescribeVpcs", filters([TAG])), findHeadend(env), ec2(env, "DescribeAddresses", filters([TAG]))]);
    // A leftover Elastic IP bills by itself, so it counts as something still there.
    return { rg_exists: !!xmlFirst(vpcs, "vpcId") || !!h || !!xmlFirst(addrs, "allocationId"), vm_exists: !!h, power: h ? (POWER[h.state] ?? h.state) : null, public_ip: h?.publicIp ?? null, checked_at };
  } catch (e) {
    return { rg_exists: false, vm_exists: false, power: null, public_ip: null, checked_at, error: (e as Error).message };
  }
}

const KIND: Record<string, string> = {
  instance: "Virtual machine",
  "elastic-ip": "Public IP",
  vpc: "Virtual network",
  subnet: "Subnet",
  "security-group": "Security group",
  "internet-gateway": "Internet gateway",
  "route-table": "Route table",
  volume: "OS disk",
  "key-pair": "Key pair",
  "network-interface": "Network interface",
};
const ORDER = ["Virtual network", "Subnet", "Internet gateway", "Route table", "Security group", "Public IP", "Network interface", "Virtual machine", "OS disk", "Key pair"];

async function taggedArns(env: Env): Promise<string[]> {
  const region = config(env).aws.region;
  const arns: string[] = [];
  let token = "";
  for (let page = 0; page < 10; page++) {
    const r = await awsJson<{ ResourceTagMappingList?: { ResourceARN: string }[]; PaginationToken?: string }>(env, {
      service: "tagging",
      region,
      host: `tagging.${region}.amazonaws.com`,
      target: "ResourceGroupsTaggingAPI_20170126.GetResources",
      body: { TagFilters: [{ Key: "wg-admin", Values: ["vpn"] }], ...(token ? { PaginationToken: token } : {}) },
    });
    arns.push(...(r.ResourceTagMappingList ?? []).map((m) => m.ResourceARN));
    token = r.PaginationToken ?? "";
    if (!token) break;
  }
  return arns;
}

async function inventory(env: Env): Promise<AzureInventory> {
  const region = config(env).aws.region;
  const out: AzureInventory = { checked_at: new Date().toISOString(), resource_group: `wg-admin=vpn (${region})`, exists: false, resources: [] };
  try {
    const [arns, h, addrs] = await Promise.all([taggedArns(env), findHeadend(env), ec2(env, "DescribeAddresses", filters([TAG]))]);
    const eip = xmlFirst(addrs, "publicIp");
    for (const arn of arns) {
      const [type, id = ""] = (arn.split(":")[5] ?? "").split("/");
      const kind = KIND[type] ?? type;
      let detail = id;
      if (type === "instance" && h?.id === id) detail = `${h.type ?? "?"}, ${POWER[h.state] ?? h.state}, Ubuntu 24.04, SSH key only`;
      if (type === "elastic-ip") detail = `${eip ?? "not yet allocated"}, Elastic IP`;
      out.resources.push({ kind, name: id, detail });
    }
    out.resources.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
    out.exists = arns.length > 0 || !!h;
    return out;
  } catch (e) {
    out.error = (e as Error).message;
    return out;
  }
}

async function power(env: Env, op: "hibernate" | "resume"): Promise<void> {
  const verb = op === "hibernate" ? "stop" : "start";
  try {
    const h = await findHeadend(env);
    if (!h) throw new Error(`there is no wg-admin server to ${verb}`);
    await ec2(env, op === "hibernate" ? "StopInstances" : "StartInstances", { "InstanceId.1": h.id });
  } catch (e) {
    const code = e instanceof AwsError ? ` (${e.code})` : "";
    throw new Error(`AWS refused to ${verb} the server${code}: ${(e as Error).message}`.slice(0, 300));
  }
}

interface SgRule {
  id: string;
  protocol: string;
  from: number;
  to: number;
  cidr: string | null;
  description: string;
}

async function headendGroup(env: Env): Promise<string> {
  const id = xmlFirst(await ec2(env, "DescribeSecurityGroups", filters([TAG, HEADEND])), "groupId");
  if (!id) throw new Error("AWS would not show the server's security group");
  return id;
}

async function ingressRules(env: Env, group: string): Promise<SgRule[]> {
  const xml = await ec2(env, "DescribeSecurityGroupRules", filters([["group-id", [group]]]));
  // Whole items, never "cut at the id": EC2 lists each rule's fields alphabetically, so the id comes near the end.
  return xmlItems(xml, "securityGroupRuleSet")
    .map(xmlOwn)
    .filter((r) => xmlFirst(r, "isEgress") !== "true")
    .map((r) => ({
      id: xmlFirst(r, "securityGroupRuleId") ?? "",
      protocol: xmlFirst(r, "ipProtocol") ?? "",
      from: Number(xmlFirst(r, "fromPort") ?? -1),
      to: Number(xmlFirst(r, "toPort") ?? -1),
      cidr: xmlFirst(r, "cidrIpv4"),
      description: xmlFirst(r, "description") ?? "",
    }));
}

const permission = (p: { protocol: string; port: number; cidr: string; description: string }): Record<string, string> => ({
  "IpPermissions.1.IpProtocol": p.protocol,
  "IpPermissions.1.FromPort": String(p.port),
  "IpPermissions.1.ToPort": String(p.port),
  "IpPermissions.1.IpRanges.1.CidrIp": p.cidr,
  "IpPermissions.1.IpRanges.1.Description": p.description,
});

const revokeIds = (ids: string[]) => Object.fromEntries(ids.map((id, i) => [`SecurityGroupRuleId.${i + 1}`, id]));

/** New SSH source first, old one after: there is never a moment with SSH shut. */
async function setSshAllowedCidr(env: Env, cidr: string): Promise<void> {
  try {
    const g = await headendGroup(env);
    const old = (await ingressRules(env, g)).filter((r) => r.description === SSH_RULE);
    const keep = old.find((r) => r.cidr === cidr && r.from === 22 && r.to === 22);
    if (!keep) await ec2(env, "AuthorizeSecurityGroupIngress", { GroupId: g, ...permission({ protocol: "tcp", port: 22, cidr, description: SSH_RULE }) });
    const drop = old.filter((r) => r !== keep).map((r) => r.id);
    if (drop.length) await ec2(env, "RevokeSecurityGroupIngress", { GroupId: g, ...revokeIds(drop) });
  } catch (e) {
    throw new Error(`AWS refused the security group change: ${(e as Error).message}`.slice(0, 300));
  }
}

/** The security group's published-* rules become exactly `rules`. Every other rule (WireGuard, SSH, VPC) is left alone. */
async function setPublishedPorts(env: Env, rules: PublishedNsgRule[]): Promise<void> {
  try {
    const g = await headendGroup(env);
    const have = (await ingressRules(env, g)).filter((r) => r.description.startsWith("published-"));
    const want = rules.map((w) => ({ description: w.name, protocol: w.protocol === "Udp" ? "udp" : "tcp", port: Number(w.port), cidr: w.source === "*" ? "0.0.0.0/0" : w.source }));
    const same = (h: SgRule, w: (typeof want)[number]) => h.description === w.description && h.protocol === w.protocol && h.from === w.port && h.to === w.port && h.cidr === w.cidr;
    const add = want.filter((w) => !have.some((h) => same(h, w)));
    const drop = have.filter((h) => !want.some((w) => same(h, w)));
    for (const w of add) await ec2(env, "AuthorizeSecurityGroupIngress", { GroupId: g, ...permission(w) });
    if (drop.length) await ec2(env, "RevokeSecurityGroupIngress", { GroupId: g, ...revokeIds(drop.map((r) => r.id)) });
  } catch (e) {
    throw new Error(`AWS refused to update the published ports: ${(e as Error).message}`.slice(0, 300));
  }
}

export const awsOps: CloudOps = {
  id: "aws",
  label: "AWS",
  configured: canAws,
  view,
  inventory,
  power,
  setSshAllowedCidr,
  setPublishedPorts,
};
