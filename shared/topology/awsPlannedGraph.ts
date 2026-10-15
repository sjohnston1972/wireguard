// shared/topology/awsPlannedGraph.ts
//
// Plain English: an AWS lab's planned diagram (AWS labs spec §10, plan ruling
// P5), made offline from the lab's Terraform mock plan exactly as the Azure
// one is (planned.ts hands an input with aws_ resources to this). The lab's
// aws_resourcegroups_group is the container where Azure draws the resource
// group, one per region ("lab-<id> · London", "· Ireland" for a group under
// provider = aws.secondary); a VPC sits in its region's container, its
// subnets in it, and each card where AWS puts it (an instance in its subnet,
// a load balancer, security group or route table in its VPC, S3, IAM and the
// monitoring pieces in the region container). The rules (rules/awsPlanned.ts)
// say what folds into what and which edges a resource makes; the key of every
// node is "<tagging-API type>/<Name tag, else name>", so it agrees with the
// live graph (awsLive.ts) built from the tag-filtered AWS reads.
//
// Like the Azure one: sorted, no timestamp, every resource a card, a folded
// entry or the `via` of an edge. The nodes carry `cloud: "aws"`.

import { TOPOLOGY_SCHEMA, sortGraph, type TopoKind, type TopologyGraph, type TopoNode } from "./model";
import { kindOfTf } from "./kinds";
import { awsMockNameCtx, disambiguate, nodeKey, planLabelAws } from "./keys";
import { withheldNote } from "./props";
import { awsNameOf } from "./rules/awsPlanned";
import { tfIgnored, tfRule, type PlannedHelpers, type TfInst, type TfRule } from "./rules/planned";
import type { PlannedInput } from "./planned";
import { addFoldedLists, cmp, collectEdges, configOf, homeOf, makeRefTools, ownerCycle, scrubNodes } from "./plannedShared";

/** The region words on the container ("lab-<id> · London"). */
export const AWS_REGION_WORD: Record<string, string> = { "eu-west-2": "London", "eu-west-1": "Ireland" };

/** True for a plan with AWS resources (the lab's cloud is its id's prefix, but the plan is what the builder has). */
export const isAwsInput = (input: Pick<PlannedInput, "changes">): boolean => input.changes.some((c) => c.type.startsWith("aws_"));

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

type Region = "primary" | "secondary";
/** Kinds drawn inside a subnet, and kinds drawn inside their VPC; everything else sits in the region container. */
export const AWS_IN_SUBNET = new Set<TopoKind>(["vm", "vmss", "natGateway", "bastion", "clientVpn"]);
export const AWS_IN_VPC = new Set<TopoKind>(["loadBalancer", "nsg", "routeTable", "internetGateway", "sqlServer"]);

export function awsPlannedGraph(input: PlannedInput): TopologyGraph {
  const nameCtx = awsMockNameCtx(input.number);
  const primaryRg = `lab-${input.labId}`;
  const notes: string[] = [];

  // ── Instances ──
  const insts: TfInst[] = [];
  for (const c of [...input.changes].sort((a, b) => cmp(a.address, b.address))) {
    if (c.address.startsWith("data.") || tfIgnored(c.type)) continue;
    insts.push({ id: `tf:${c.address}`, address: c.address, config: configOf(c.address), type: c.type, name: c.name, index: c.index ?? null, after: c.after ?? {} });
  }
  const byId = new Map(insts.map((i) => [i.id, i]));
  const { byConfig, refs, referrers } = makeRefTools(insts, input.refs, { skipAttrs: ["provider"] });

  const ruleOf = (i: TfInst): TfRule => tfRule(i.type);
  const regionOf = (i: TfInst): Region => ((input.refs[i.config]?.provider ?? []).some((p) => /secondary/i.test(p)) ? "secondary" : "primary");
  const nameOf = (i: TfInst): string => awsNameOf(i);
  const labelOf = (i: TfInst): string => planLabelAws(nameOf(i), input.number);

  // ── Groups: the region containers, VPCs, subnets ──
  const nodes = new Map<string, TopoNode>();
  const addNode = (n: TopoNode) => nodes.set(n.id, n);
  const regionOfNode = new Map<string, Region>();
  const container = new Map<Region, string>();
  for (const g of insts.filter((x) => x.type === "aws_resourcegroups_group")) {
    const region = regionOf(g);
    const code = region === "secondary" ? nameCtx.secondaryRegion! : nameCtx.region;
    addNode({ id: g.id, key: "", kind: "resourceGroup", label: `${labelOf(g)} · ${AWS_REGION_WORD[code] ?? code}`, props: { region: code }, armType: "resource-groups:group", scope: "lab", cloud: "aws" });
    regionOfNode.set(g.id, region);
    if (!container.has(region)) container.set(region, g.id);
  }
  const containerFor = (i: TfInst): string | undefined => container.get(regionOf(i)) ?? container.get("primary") ?? [...container.values()][0];

  const isGroupInst = (i: TfInst) => i.type === "aws_resourcegroups_group" || i.type === "aws_vpc" || i.type === "aws_subnet";
  for (const v of insts.filter((x) => x.type === "aws_vpc")) {
    addNode({ id: v.id, key: "", kind: "vnet", label: labelOf(v), parent: containerFor(v), props: {}, armType: "ec2:vpc", cloud: "aws" });
    regionOfNode.set(v.id, regionOf(v));
  }
  for (const s of insts.filter((x) => x.type === "aws_subnet")) {
    const vpc = refs(s, ["vpc_id"]).find((r) => r.type === "aws_vpc");
    addNode({ id: s.id, key: "", kind: "subnet", label: labelOf(s), parent: vpc?.id ?? containerFor(s), props: {}, armType: "ec2:subnet", cloud: "aws" });
    regionOfNode.set(s.id, regionOf(s));
  }

  // ── Folding ──
  const owner = new Map<string, TfInst>();
  for (const i of insts) {
    if (isGroupInst(i)) continue;
    const rule = ruleOf(i);
    let target: TfInst | undefined;
    for (const a of rule.fold ?? []) {
      target = refs(i, [a])[0];
      if (target) break;
    }
    if (!target && rule.foldToReferrer) target = referrers(i, rule.foldToReferrer.types, rule.foldToReferrer.attrs).sort((a, b) => cmp(a.address, b.address))[0];
    if (target && !ownerCycle(owner, i, target)) owner.set(i.id, target);
  }
  // foldInto needs the helpers (byType); the rest of them are plain lookups.
  const early: PlannedHelpers = {
    refs,
    referrers,
    byType: (...types) => insts.filter((i) => types.includes(i.type)),
    home: () => null,
    label: labelOf,
    nodeByPrivateIp: () => null,
    subnetsOf: () => [],
  };
  for (const i of insts) {
    if (owner.has(i.id)) continue;
    const t = ruleOf(i).foldInto?.(i, early);
    if (t && t !== i && !ownerCycle(owner, i, t)) owner.set(i.id, t);
  }
  for (const i of insts) for (const a of ruleOf(i).pull ?? []) for (const t of refs(i, [a])) if (!owner.has(t.id) && !isGroupInst(t) && t !== i && !ownerCycle(owner, t, i)) owner.set(t.id, i);

  const home = (i: TfInst): string | null => homeOf(i, owner, (x) => (nodes.has(x.id) && isGroupInst(x) ? x.id : null));

  // ── Cards ──
  const kindOf = (i: TfInst): TopoKind => ruleOf(i).kind ?? kindOfTf(i.type);
  const cards = insts.filter((i) => !isGroupInst(i) && !owner.has(i.id));
  for (const i of cards) addNode({ id: i.id, key: "", kind: kindOf(i), label: labelOf(i), props: {}, armType: ruleOf(i).arm ?? null, scope: "lab", cloud: "aws" });
  addFoldedLists(insts, (i) => owner.has(i.id), home, nodes, ruleOf, labelOf, (i) => ruleOf(i).arm ?? null);

  // Where each card sits: through what is folded into it for subnets and VPCs (a database's subnet group).
  const part = (i: TfInst) => [i, ...insts.filter((f) => owner.get(f.id) === i)];
  const subnetsOf = (i: TfInst): string[] => {
    const out = new Set<string>();
    for (const p of part(i)) for (const t of refs(p)) if (t.type === "aws_subnet") out.add(t.id);
    return [...out].sort();
  };
  const vpcOf = (i: TfInst): string | null => {
    for (const p of part(i)) {
      const v = refs(p).find((t) => t.type === "aws_vpc");
      if (v) return v.id;
    }
    const s = subnetsOf(i)[0];
    return s ? (nodes.get(s)?.parent ?? null) : null;
  };
  for (const i of cards) {
    const n = nodes.get(i.id)!;
    let parent: string | null | undefined;
    const interfaceEndpoint = i.type === "aws_vpc_endpoint" && str(i.after.vpc_endpoint_type)?.toLowerCase() !== "gateway";
    if (AWS_IN_SUBNET.has(n.kind) || (n.kind === "privateEndpoint" && interfaceEndpoint)) parent = subnetsOf(i)[0] ?? vpcOf(i);
    else if (AWS_IN_VPC.has(n.kind) || n.kind === "privateEndpoint") parent = vpcOf(i);
    parent ??= containerFor(i);
    if (parent) n.parent = parent;
    regionOfNode.set(i.id, regionOf(i));
  }

  // ── Props, edges ──
  const helpers: PlannedHelpers = {
    refs,
    referrers,
    byType: (...types) => insts.filter((i) => types.includes(i.type)),
    home: (i) => home(i),
    label: labelOf,
    nodeByPrivateIp: (ip) => {
      for (const n of [...nodes.values()].sort((a, b) => cmp(a.id, b.id))) if (n.props.privateIp === ip) return n.id;
      return null;
    },
    subnetsOf,
  };
  const raw = new Map<string, Record<string, unknown>>();
  for (const i of insts) {
    const n = nodes.get(i.id);
    if (!n) continue;
    raw.set(n.id, { ...(raw.get(n.id) ?? {}), ...n.props, ...(ruleOf(i).props?.(i, helpers) ?? {}) });
  }
  // Peer target: the VPC the peer_vpc_id output names.
  for (const cfg of input.refs["output.peer_vpc_id"]?.value ?? []) for (const t of byConfig.get(cfg) ?? []) if (t.type === "aws_vpc") raw.set(t.id, { ...(raw.get(t.id) ?? {}), peerTarget: true });

  const withheld = scrubNodes(nodes, raw);

  const edges = collectEdges(insts, ruleOf, helpers, home, nodes);

  // ── Keys ──
  const keyed = [...nodes.values()].map((n) => {
    const i = byId.get(n.id)!;
    const region = regionOfNode.get(n.id) ?? "primary";
    let key: string;
    if (n.kind === "resourceGroup") key = nodeKey("resource-groups:group", region === "secondary" ? [str(i.after.name) ?? i.name, "secondary"] : [str(i.after.name) ?? i.name], nameCtx);
    else if (n.armType) key = nodeKey(n.armType, [nameOf(i)], nameCtx);
    else key = `terraform/${i.type}/${nameOf(i).toLowerCase()}`;
    return { id: n.id, key, group: n.kind === "resourceGroup" ? null : region === "secondary" ? `${primaryRg}-secondary` : primaryRg };
  });
  const keys = disambiguate(keyed, primaryRg);
  for (const n of nodes.values()) n.key = keys[n.id] ?? n.key;

  const generic = [...nodes.values()].filter((n) => n.kind === "generic").length;
  if (generic) notes.push(`${generic} resource${generic === 1 ? "" : "s"} of a type the diagram draws plainly`);
  if (withheld) notes.push(withheldNote(withheld));

  return sortGraph({
    schema: TOPOLOGY_SCHEMA,
    labId: input.labId,
    version: input.version,
    source: "planned",
    at: null,
    nodes: [...nodes.values()].map((n) => {
      const out: TopoNode = { id: n.id, key: n.key, kind: n.kind, label: n.label, props: n.props };
      if (n.parent) out.parent = n.parent;
      if (n.armType !== undefined) out.armType = n.armType;
      if (n.scope) out.scope = n.scope;
      if (n.folded?.length) out.folded = n.folded;
      out.cloud = "aws";
      return out;
    }),
    edges: [...edges.values()],
    ...(notes.length ? { notes } : {}),
  });
}
