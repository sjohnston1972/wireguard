// labs/awsTopology.ts
//
// Plain English: the reads behind an AWS lab's live diagram (AWS labs spec §6,
// §10). At most AWS_TOPOLOGY_CALLS_MAX (16) calls, all counted on the Net and
// all filtered by the lab's tag (cloudlabs-lab = <id>): in the session's own
// region (London) the tagged resources, VPCs, subnets, instances, route
// tables, VPC peering connections, Transit Gateway attachments, NAT gateways,
// VPC endpoints and (when a load balancer is tagged) the load balancers; in
// the lab's secondary region, if it has one, the tagged resources, VPCs,
// subnets and instances. Each answer is cut down to an AwsRow (plain props and
// the ids a row sits in) by the small XML helpers; no user data, no policies,
// no raw describe output ever leaves. The graph itself is built by
// shared/topology/awsLive.ts.

import type { Env } from "../env";
import { awsQuery, ec2, filters, xmlAll, xmlFirst, xmlItems, xmlOwn, xmlOwnItems } from "../cloud/awsApi";
import { LAB_TAG, readsUsEast1, readsUsWest2 } from "../../../shared/labs";
import type { AwsRow } from "../../../shared/topology/awsLive";
import { arnParts, labTagged, type TaggedArn } from "./awsReads";
import type { Net } from "./net";

/** Calls one live refresh may make: 10 in the lab's region, 4 in its secondary, 1 in us-east-1 and 1 in us-west-2: lab 26 has all four, ruling P24. */
export const AWS_TOPOLOGY_CALLS_MAX = 16;

const ELB_VERSION = "2015-12-01";

/** What a describe says about one resource, by its id. */
interface Described {
  type: string;
  id: string;
  name?: string | null;
  tags: Record<string, string>;
  props: Record<string, unknown>;
  refs: AwsRow["refs"];
}

const tagsOf = (item: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const t of xmlOwnItems(item, "tagSet")) {
    const k = xmlFirst(t, "key");
    if (k) out[k] = xmlFirst(t, "value") ?? "";
  }
  return out;
};
const field = (item: string, tag: string): string | undefined => xmlFirst(xmlOwn(item), tag) ?? undefined;
/** The text inside a nested non-list element (instanceState, accepterVpcInfo): its first child tag. */
const nested = (item: string, parent: string, tag: string): string | undefined => {
  const m = xmlOwn(item).match(new RegExp(`<${parent}>([\\s\\S]*?)</${parent}>`));
  return m ? (xmlFirst(m[1]!, tag) ?? undefined) : undefined;
};
const plainItems = (item: string, setTag: string): string[] => xmlOwnItems(item, setTag).map((x) => x.replace(/<[^>]*>/g, "").trim()).filter(Boolean);

const tagFilter = (labId: string) => filters([[`tag:${LAB_TAG}`, [labId]]]);

/** A tagged ARN's tagging-API type ("ec2:vpc"), with the types ARNs leave out. */
export function awsTypeOfArn(arn: string): string {
  const p = arnParts(arn);
  const type = p.type || ({ sns: "topic", sqs: "queue", s3: "bucket" } as Record<string, string>)[p.service] || "";
  return type ? `${p.service}:${type}` : p.service;
}

/** A tagged ARN's own id or name: vpc-0a, an instance id, a bucket, a role's name, a load balancer's name. */
export function awsIdOfArn(arn: string): string {
  const p = arnParts(arn);
  if (p.service === "elasticloadbalancing") return p.id.split("/")[1] ?? p.id;
  if (p.service === "autoscaling") return p.id.split("autoScalingGroupName/")[1] ?? p.id;
  if (p.service === "logs" || p.service === "s3") return p.id.replace(/:\*$/, "");
  if (p.service === "ec2" || p.service === "iam" || p.service === "events") return p.id.split("/").at(-1) ?? p.id;
  return p.id;
}

async function describeVpcs(env: Env, net: Net, labId: string, region: string): Promise<Described[]> {
  net.take(1);
  const xml = await ec2(env, "DescribeVpcs", tagFilter(labId), region);
  return xmlItems(xml, "vpcSet").flatMap((it) => {
    const id = field(it, "vpcId");
    const cidr = field(it, "cidrBlock");
    return id ? [{ type: "ec2:vpc", id, tags: tagsOf(it), props: { addressSpace: cidr ? [cidr] : undefined }, refs: {} }] : [];
  });
}

async function describeSubnets(env: Env, net: Net, labId: string, region: string): Promise<Described[]> {
  net.take(1);
  const xml = await ec2(env, "DescribeSubnets", tagFilter(labId), region);
  return xmlItems(xml, "subnetSet").flatMap((it) => {
    const id = field(it, "subnetId");
    return id ? [{ type: "ec2:subnet", id, tags: tagsOf(it), props: { prefix: field(it, "cidrBlock") }, refs: { vpc: field(it, "vpcId") } }] : [];
  });
}

async function describeInstances(env: Env, net: Net, labId: string, region: string): Promise<Described[]> {
  net.take(1);
  const xml = await ec2(env, "DescribeInstances", tagFilter(labId), region);
  const out: Described[] = [];
  for (const res of xmlItems(xml, "reservationSet")) {
    for (const it of xmlOwnItems(res, "instancesSet")) {
      const id = field(it, "instanceId");
      if (!id) continue;
      out.push({
        type: "ec2:instance",
        id,
        tags: tagsOf(it),
        props: { size: field(it, "instanceType"), privateIp: field(it, "privateIpAddress"), state: nested(it, "instanceState", "name") },
        refs: { vpc: field(it, "vpcId"), subnet: field(it, "subnetId") },
      });
    }
  }
  return out;
}

async function describeRouteTables(env: Env, net: Net, labId: string, region: string): Promise<Described[]> {
  net.take(1);
  const xml = await ec2(env, "DescribeRouteTables", tagFilter(labId), region);
  return xmlItems(xml, "routeTableSet").flatMap((it) => {
    const id = field(it, "routeTableId");
    return id ? [{ type: "ec2:route-table", id, tags: tagsOf(it), props: {}, refs: { vpc: field(it, "vpcId") } }] : [];
  });
}

async function describePeerings(env: Env, net: Net, labId: string, region: string): Promise<Described[]> {
  net.take(1);
  const xml = await ec2(env, "DescribeVpcPeeringConnections", tagFilter(labId), region);
  return xmlItems(xml, "vpcPeeringConnectionSet").flatMap((it) => {
    const id = field(it, "vpcPeeringConnectionId");
    const status = nested(it, "status", "code");
    if (!id || status === "deleted" || status === "rejected" || status === "failed" || status === "expired") return [];
    return [{ type: "ec2:vpc-peering-connection", id, tags: tagsOf(it), props: { status }, refs: { vpc: nested(it, "requesterVpcInfo", "vpcId"), peerVpc: nested(it, "accepterVpcInfo", "vpcId") } }];
  });
}

async function describeTgwAttachments(env: Env, net: Net, labId: string, region: string): Promise<Described[]> {
  net.take(1);
  const xml = await ec2(env, "DescribeTransitGatewayAttachments", tagFilter(labId), region);
  return xmlItems(xml, "transitGatewayAttachments").flatMap((it) => {
    const id = field(it, "transitGatewayAttachmentId");
    if (!id) return [];
    const vpc = field(it, "resourceType") === "vpc" ? field(it, "resourceId") : undefined;
    return [{ type: "ec2:transit-gateway-attachment", id, tags: tagsOf(it), props: { status: field(it, "state") }, refs: { vpc, transitGateway: field(it, "transitGatewayId") } }];
  });
}

async function describeNats(env: Env, net: Net, labId: string, region: string): Promise<Described[]> {
  net.take(1);
  const xml = await ec2(env, "DescribeNatGateways", tagFilter(labId), region);
  return xmlItems(xml, "natGatewaySet").flatMap((it) => {
    const id = field(it, "natGatewayId");
    const state = field(it, "state");
    if (!id || state === "deleted") return [];
    return [{ type: "ec2:natgateway", id, tags: tagsOf(it), props: { state }, refs: { vpc: field(it, "vpcId"), subnet: field(it, "subnetId") } }];
  });
}

async function describeEndpoints(env: Env, net: Net, labId: string, region: string): Promise<Described[]> {
  net.take(1);
  const xml = await ec2(env, "DescribeVpcEndpoints", tagFilter(labId), region);
  return xmlItems(xml, "vpcEndpointSet").flatMap((it) => {
    const id = field(it, "vpcEndpointId");
    if (!id) return [];
    const subnets = plainItems(it, "subnetIdSet");
    return [{ type: "ec2:vpc-endpoint", id, tags: tagsOf(it), props: { groupId: field(it, "serviceName")?.split(".").at(-1) }, refs: { vpc: field(it, "vpcId"), ...(subnets.length ? { subnets } : {}) } }];
  });
}

async function describeLoadBalancers(env: Env, net: Net, region: string, arns: string[]): Promise<Described[]> {
  net.take(1);
  const params: Record<string, string> = {};
  arns.slice(0, 20).forEach((a, i) => (params[`LoadBalancerArns.member.${i + 1}`] = a));
  const xml = await awsQuery(env, "elasticloadbalancing", "DescribeLoadBalancers", params, ELB_VERSION, { region });
  const chunks = xml.split("<LoadBalancerArn>").slice(1);
  return chunks.flatMap((c) => {
    const arn = c.slice(0, c.indexOf("</LoadBalancerArn>"));
    if (!arn) return [];
    return [{ type: "elasticloadbalancing:loadbalancer", id: arn, name: xmlFirst(c, "LoadBalancerName"), tags: {}, props: { sku: xmlFirst(c, "Type") ?? undefined }, refs: { vpc: xmlFirst(c, "VpcId") ?? undefined, subnets: xmlAll(c, "SubnetId") } }];
  });
}

/** Tagged ARNs joined with what the describes said about them: one AwsRow each (a describe with no tagged twin is added). */
export function joinRows(tagged: readonly TaggedArn[], described: readonly Described[], region: string): AwsRow[] {
  const byKey = new Map(described.map((d) => [`${d.type.toLowerCase()}|${d.id}`, d]));
  const used = new Set<string>();
  const rows: AwsRow[] = [];
  const account = tagged[0]?.arn.split(":")[4] ?? "000000000000";
  for (const t of tagged) {
    const type = awsTypeOfArn(t.arn);
    const id = awsIdOfArn(t.arn);
    const d = byKey.get(`${type.toLowerCase()}|${id}`) ?? byKey.get(`${type.toLowerCase()}|${t.arn}`);
    if (d) used.add(`${d.type.toLowerCase()}|${d.id}`);
    rows.push({ arn: t.arn, type, id, region, name: d?.name ?? (type.startsWith("ec2:") ? null : id), tags: { ...(d?.tags ?? {}), ...t.tags }, props: d?.props ?? {}, refs: d?.refs ?? {} });
  }
  for (const d of described) {
    if (used.has(`${d.type.toLowerCase()}|${d.id}`) || d.type === "elasticloadbalancing:loadbalancer") continue;
    const resource = d.type.split(":")[1] ?? "";
    rows.push({ arn: `arn:aws:ec2:${region}:${account}:${resource}/${d.id}`, type: d.type, id: d.id, region, name: null, tags: d.tags, props: d.props, refs: d.refs });
  }
  return rows;
}

export interface AwsTopologyRead {
  rows: AwsRow[];
  /** True when the tagging API had more than the first page. */
  truncated: boolean;
  /** The accepter-side VPC ids of the lab's peerings: the VPN server's VPCs. */
  gatewayVpcIds: string[];
}

/** Everything the live diagram needs from AWS, in at most AWS_TOPOLOGY_CALLS_MAX counted calls. Throws AwsError on a refusal. */
export async function readAwsTopology(env: Env, net: Net, labId: string, region: string, secondary: string | null): Promise<AwsTopologyRead> {
  const tagged = await labTagged(env, net, region, labId);
  const lbArns = tagged.filter((t) => awsTypeOfArn(t.arn) === "elasticloadbalancing:loadbalancer").map((t) => t.arn);
  const [vpcs, subnets, instances, routeTables, peerings, tgw, nats, endpoints, lbs] = await Promise.all([
    describeVpcs(env, net, labId, region),
    describeSubnets(env, net, labId, region),
    describeInstances(env, net, labId, region),
    describeRouteTables(env, net, labId, region),
    describePeerings(env, net, labId, region),
    describeTgwAttachments(env, net, labId, region),
    describeNats(env, net, labId, region),
    describeEndpoints(env, net, labId, region),
    lbArns.length ? describeLoadBalancers(env, net, region, lbArns) : Promise.resolve([] as Described[]),
  ]);
  const rows = joinRows(tagged, [...vpcs, ...subnets, ...instances, ...routeTables, ...peerings, ...tgw, ...nats, ...endpoints, ...lbs], region);
  let truncated = tagged.truncated;
  if (secondary) {
    const t2 = await labTagged(env, net, secondary, labId);
    const [v2, s2, i2] = await Promise.all([describeVpcs(env, net, labId, secondary), describeSubnets(env, net, labId, secondary), describeInstances(env, net, labId, secondary)]);
    rows.push(...joinRows(t2, [...v2, ...s2, ...i2], secondary));
    truncated = truncated || t2.truncated;
  }
  // Rulings P7 and P5: a global lab's CloudFront and Route 53 items, and a DNS lab's Route 53 items, tagged in us-east-1, sit in the lab's own container (the
  // planned graph draws them there): one more tagging call, no describes.
  if (readsUsEast1(labId)) {
    const tg = await labTagged(env, net, "us-east-1", labId);
    rows.push(...joinRows(tg, [], region));
    truncated = truncated || tg.truncated;
  }
  // Ruling P24: Global Accelerator's items are tagged in us-west-2; they sit in the lab's own container.
  if (readsUsWest2(labId)) {
    const tw = await labTagged(env, net, "us-west-2", labId);
    rows.push(...joinRows(tw, [], region));
    truncated = truncated || tw.truncated;
  }
  const own = new Set(vpcs.map((v) => v.id));
  const gatewayVpcIds = [...new Set(peerings.map((p) => p.refs.peerVpc).filter((x): x is string => !!x && !own.has(x)))];
  return { rows, truncated, gatewayVpcIds };
}
