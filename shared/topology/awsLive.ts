// shared/topology/awsLive.ts
//
// Plain English: an AWS lab's live diagram (AWS labs spec §10, §6), built from
// what the Worker's tag-filtered AWS reads found: the resources tagged
// cloudlabs-lab = <id> (Resource Groups Tagging API) and the describes of VPCs,
// subnets, instances, route tables, peerings, NAT gateways, endpoints and load
// balancers, each reduced to an AwsRow with plain props and the ids it
// references. The graph has the planned graph's keys ("<tagging type>/<Name
// tag, else name>"), so diff.ts lines the two up; the lab's resource group is
// the container of its region. A resource the plan folds into another card (a
// volume, a rule, a target group, an Auto Scaling group's own instances) is
// folded here too or left out, never drawn as "added by hand". No raw
// properties leave: props go through the same scrub as the Azure view.

import { TOPOLOGY_SCHEMA, sortGraph, type TopoEdge, type TopoHealth, type TopologyGraph, type TopoNode } from "./model";
import { kindOfAws } from "./kinds";
import { AWS_MOCK_NAME, disambiguate, nodeKey, SYNTHETIC_KEYS, type NameCtx } from "./keys";
import { scrubProps, withheldNote } from "./props";
import { AWS_IN_SUBNET, AWS_IN_VPC, AWS_REGION_WORD } from "./awsPlannedGraph";

/** One AWS resource as the Worker's reads give it. */
export interface AwsRow {
  arn: string;
  /** The tagging-API type: "ec2:vpc". */
  type: string;
  /** The resource's own id or name: vpc-0a, i-0c, a bucket's name. */
  id: string;
  region: string;
  name: string | null;
  tags: Record<string, string>;
  /** PROP_NAMES values, plus `state` (an instance's) and `status` (a peering's), which are read here and not drawn as props. */
  props: Record<string, unknown>;
  /** Ids of what this row sits in or reaches (a row's `id`). */
  refs: { vpc?: string; subnet?: string; subnets?: string[]; peerVpc?: string; targets?: string[]; transitGateway?: string };
}

export interface AwsLiveCtx {
  labId: string;
  version: number;
  /** Ids of the VPN server's VPCs (the accepter side of the lab's peerings): the gateway node. */
  gatewayVpcIds: string[];
  at: string;
  /** The session's name_prefix, so a bucket or role named with it keys as {p}. */
  namePrefix?: string;
  region?: string;
  secondaryRegion?: string | null;
}

/**
 * Tagged types the plan folds into another card (or never draws), so the live view does not either. A peering and a
 * Transit Gateway attachment are edges; an Auto Scaling group's own instances fold into it.
 */
export const AWS_LIVE_SKIP: ReadonlySet<string> = new Set([
  "ec2:volume",
  "ec2:network-interface",
  "ec2:security-group-rule",
  "ec2:snapshot",
  "ec2:launch-template",
  "apigateway:stages",
  "elasticache:cluster",
  "ec2:elastic-ip",
  "ec2:vpc-peering-connection",
  "ec2:transit-gateway-attachment",
  "iam:instance-profile",
  "iam:policy",
  "elasticloadbalancing:targetgroup",
  "elasticloadbalancing:listener",
  "elasticloadbalancing:listener-rule",
  "ecs:task",
  "ecs:task-definition",
  "ec2:transit-gateway-route-table",
  "ec2:ipam-pool",
  "ec2:ipam-scope",
  "vpc-lattice:listener",
  "vpc-lattice:targetgroup",
  "vpc-lattice:servicenetworkvpcassociation",
  "vpc-lattice:servicenetworkserviceassociation",
  "route53resolver:firewall-rule-group-association",
  "route53resolver:firewall-domain-list",
  "network-firewall:stateful-rulegroup",
  "network-firewall:stateless-rulegroup",
  "ec2:traffic-mirror-filter-rule",
]);

const lower = (s: string) => s.toLowerCase();
const stateHealth = (state: unknown): TopoHealth | undefined => {
  const s = typeof state === "string" ? state.toLowerCase() : "";
  if (!s) return undefined;
  const word = s.charAt(0).toUpperCase() + s.slice(1);
  if (["running", "available", "active", "in-service"].includes(s)) return { tone: "ok", word };
  if (["pending", "stopping", "starting", "modifying", "creating", "pending-acceptance", "provisioning"].includes(s)) return { tone: "warn", word };
  if (["stopped", "terminated", "shutting-down", "failed", "deleted", "deleting", "rejected", "expired"].includes(s)) return { tone: "bad", word };
  return { tone: "unknown", word };
};

export function awsLiveGraph(rows: readonly AwsRow[], ctx: AwsLiveCtx): TopologyGraph {
  const primary = ctx.region ?? AWS_MOCK_NAME.region;
  const nameCtx: NameCtx = { prefix: ctx.namePrefix ?? "", region: primary, secondaryRegion: ctx.secondaryRegion ?? AWS_MOCK_NAME.secondaryRegion };
  const primaryRg = `lab-${ctx.labId}`;
  const regionKind = (r: AwsRow): "primary" | "secondary" => (r.region && r.region !== primary ? "secondary" : "primary");
  const nameOf = (r: AwsRow): string => r.tags.Name || r.name || r.id;

  const nodes = new Map<string, TopoNode>();
  const byRowId = new Map<string, string>(); // row.id → node id
  const rowOf = new Map<string, AwsRow>(); // node id → row
  const asgByName = new Map<string, string>(); // ASG name → node id
  const container = new Map<"primary" | "secondary", string>();
  const notes: string[] = [];

  // Ruling P19: what a CloudFormation stack made carries the stack's tags too, and CloudFormation's own
  // aws:cloudformation:stack-name: the planned graph draws only the stack, so the live one folds them into it.
  const fromStack = (row: AwsRow) => typeof row.tags["aws:cloudformation:stack-name"] === "string" && row.type !== "cloudformation:stack";
  // Ruling P20: a global table's replica (the same name, the secondary region) folds into its table, as the plan draws one card.
  const primaryTables = new Set(rows.filter((r) => r.type === "dynamodb:table" && regionKind(r) === "primary").map((r) => r.id));
  const replica = (r: AwsRow) => r.type === "dynamodb:table" && regionKind(r) === "secondary" && primaryTables.has(r.id);
  const kept = rows.filter((r) => !AWS_LIVE_SKIP.has(lower(r.type)) && !fromStack(r) && !replica(r));
  // Pass 1: containers, then everything else (parents are looked up by node id, so order does not matter for them).
  for (const r of kept) {
    const kind = kindOfAws(r.type);
    const id = lower(r.arn);
    const asg = r.tags["aws:autoscaling:groupName"];
    if (lower(r.type) === "ec2:instance" && asg && kept.some((x) => lower(x.type) === "autoscaling:autoscalinggroup" && x.id === asg)) continue; // folded below
    const health = stateHealth(r.props.state);
    const label = kind === "resourceGroup" ? `${nameOf(r)} · ${AWS_REGION_WORD[r.region] ?? r.region}` : nameOf(r);
    const n: TopoNode = { id, key: "", kind, label, props: {}, armType: r.type, scope: "lab", cloud: "aws" };
    if (health) n.health = health;
    nodes.set(id, n);
    byRowId.set(r.id, id);
    rowOf.set(id, r);
    if (kind === "resourceGroup" && !container.has(regionKind(r))) container.set(regionKind(r), id);
    if (lower(r.type) === "autoscaling:autoscalinggroup") asgByName.set(r.id, id);
  }
  for (const r of kept) {
    const asg = r.tags["aws:autoscaling:groupName"];
    const home = lower(r.type) === "ec2:instance" && asg ? asgByName.get(asg) : undefined;
    if (home) (nodes.get(home)!.folded ??= []).push({ id: lower(r.arn), label: nameOf(r), armType: r.type });
  }

  const containerFor = (r: AwsRow): string | undefined => container.get(regionKind(r)) ?? container.get("primary") ?? [...container.values()][0];
  const node = (id: string | undefined): TopoNode | undefined => (id ? nodes.get(byRowId.get(id) ?? "") : undefined);
  for (const n of nodes.values()) {
    const r = rowOf.get(n.id)!;
    if (n.kind === "resourceGroup") continue;
    const subnet = node(r.refs.subnet) ?? node(r.refs.subnets?.[0]);
    const vpc = node(r.refs.vpc);
    const interfaceEndpoint = lower(r.type) === "ec2:vpc-endpoint" && !!subnet;
    let parent: string | undefined;
    if (n.kind === "subnet") parent = vpc?.id;
    else if (AWS_IN_SUBNET.has(n.kind) || (n.kind === "privateEndpoint" && interfaceEndpoint)) parent = subnet?.id ?? vpc?.id;
    else if (AWS_IN_VPC.has(n.kind) || n.kind === "privateEndpoint") parent = vpc?.id ?? subnet?.parent;
    parent ??= containerFor(r);
    if (parent && parent !== n.id) n.parent = parent;
  }

  // Edges: peerings (to the gateway node or another lab VPC), Transit Gateway attachments, load balancer targets.
  const edges = new Map<string, TopoEdge>();
  const addEdge = (e: Omit<TopoEdge, "id">) => {
    let { from, to } = e;
    if (e.label === "peering" && to < from) [from, to] = [to, from];
    const id = `${e.kind}:${from}>${to}:${e.label ?? ""}`;
    if (from !== to && !edges.has(id)) edges.set(id, { ...e, id, from, to });
  };
  const gatewayIds = new Set(ctx.gatewayVpcIds);
  for (const p of rows.filter((x) => lower(x.type) === "ec2:vpc-peering-connection")) {
    const local = node(p.refs.vpc);
    const remote = p.refs.peerVpc;
    if (!local || !remote) continue;
    const state = stateHealth(p.props.status);
    const via = lower(p.arn);
    if (gatewayIds.has(remote)) {
      nodes.set("wg/gateway", { id: "wg/gateway", key: SYNTHETIC_KEYS.gateway, kind: "gateway", label: "WireGuard gateway VPC", props: {}, cloud: "aws" });
      addEdge({ from: local.id, to: "wg/gateway", kind: "traffic", label: "peering", via, ...(state ? { state } : {}) });
    } else if (node(remote)) addEdge({ from: local.id, to: node(remote)!.id, kind: "traffic", label: "peering", via, ...(state ? { state } : {}) });
  }
  for (const a of rows.filter((x) => lower(x.type) === "ec2:transit-gateway-attachment")) {
    const tgw = node(a.refs.transitGateway);
    const vpc = node(a.refs.vpc);
    if (tgw && vpc) addEdge({ from: tgw.id, to: vpc.id, kind: "traffic", label: "attachment", via: lower(a.arn) });
  }
  for (const r of kept) {
    const from = byRowId.get(r.id);
    if (!from || kindOfAws(r.type) !== "loadBalancer") continue;
    const label = typeof r.props.targetLabel === "string" ? r.props.targetLabel : undefined;
    for (const t of r.refs.targets ?? []) {
      const to = byRowId.get(t) ?? asgByName.get(t);
      if (to) addEdge({ from, to, kind: "traffic", ...(label ? { label } : {}) });
    }
  }

  // Props, scrubbed.
  let withheld = 0;
  for (const n of nodes.values()) {
    const r = rowOf.get(n.id);
    if (!r) continue;
    const s = scrubProps(r.props);
    withheld += s.withheld;
    n.props = s.props;
  }

  // Keys.
  const regionOfN = (n: TopoNode): "primary" | "secondary" => regionKind(rowOf.get(n.id) ?? ({ region: primary } as AwsRow));
  const keyed = [...nodes.values()].map((n) => {
    if (n.kind === "gateway") return { id: n.id, key: n.key, group: null };
    const r = rowOf.get(n.id)!;
    const region = regionOfN(n);
    const key = n.kind === "resourceGroup" ? nodeKey("resource-groups:group", region === "secondary" ? [nameOf(r), "secondary"] : [nameOf(r)], nameCtx) : nodeKey(r.type, [nameOf(r)], nameCtx);
    return { id: n.id, key, group: n.kind === "resourceGroup" ? null : region === "secondary" ? `${primaryRg}-secondary` : primaryRg };
  });
  const keys = disambiguate(keyed, primaryRg);
  for (const n of nodes.values()) if (n.kind !== "gateway") n.key = keys[n.id] ?? n.key;
  if (withheld) notes.push(withheldNote(withheld));

  return sortGraph({
    schema: TOPOLOGY_SCHEMA,
    labId: ctx.labId,
    version: ctx.version,
    source: "live",
    at: ctx.at,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    ...(notes.length ? { notes } : {}),
  });
}
