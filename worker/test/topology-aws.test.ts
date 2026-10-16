// topology-aws.test.ts
//
// Plain English: AWS labs on the diagram (AWS labs spec §10): the template's
// planned resources become a region container holding the VPC, its subnets,
// the instance, the Instance Connect Endpoint (drawn as a bastion), the S3
// endpoint and the security group, with AWS icons; the live graph built from
// tag-filtered describes keys the same nodes the same way, so the diff lines
// them up; and the route answers no_aws without AWS keys.

import { afterEach, describe, expect, it, vi } from "vitest";
import { AWS_TOPOLOGY_CALLS_MAX, resetTopologyCache } from "../src/labs/topology";
import { plannedGraph } from "../../shared/topology/planned";
import { awsLiveGraph, type AwsRow } from "../../shared/topology/awsLive";
import { KINDS, kindOfAws } from "../../shared/topology/kinds";
import { diffGraphs } from "../../shared/topology/diff";
import { api, freeze, labEnv, runningLab, withAwsLabs } from "./labs-helpers";

const ID = "soa-01-cloudwatch";
const ch = (address: string, after: Record<string, unknown>) => ({ address, type: address.split(".")[0]!, name: address.split(".")[1]!.replace(/\[.*$/, ""), index: /\[(\d+)\]/.exec(address)?.[1] ? Number(/\[(\d+)\]/.exec(address)![1]) : null, after });
const PLANNED = {
  labId: ID,
  version: 1,
  number: "01",
  changes: [
    ch("aws_resourcegroups_group.lab", { name: `lab-${ID}` }),
    ch("aws_vpc.lab", { cidr_block: "10.71.192.0/20", tags: { Name: "vpc-lab" } }),
    ch("aws_subnet.private[0]", { cidr_block: "10.71.192.0/24", tags: { Name: "snet-private-1" } }),
    ch("aws_subnet.private[1]", { cidr_block: "10.71.193.0/24", tags: { Name: "snet-private-2" } }),
    ch("aws_security_group.vms", { name: "lab-vms", tags: { Name: "sg-vms" } }),
    ch("aws_vpc_endpoint.s3", { service_name: "com.amazonaws.eu-west-2.s3", vpc_endpoint_type: "Gateway", tags: { Name: "vpce-s3" } }),
    ch("aws_ec2_instance_connect_endpoint.lab", { tags: { Name: "eice-lab" } }),
    ch("aws_instance.app", { instance_type: "t4g.micro", tags: { Name: "vm-app" } }),
  ],
  outputs: { peer_vpc_id: null },
  refs: {
    "aws_subnet.private": { vpc_id: ["aws_vpc.lab"] },
    "aws_security_group.vms": { vpc_id: ["aws_vpc.lab"] },
    "aws_vpc_endpoint.s3": { vpc_id: ["aws_vpc.lab"] },
    "aws_ec2_instance_connect_endpoint.lab": { subnet_id: ["aws_subnet.private"] },
    "aws_instance.app": { subnet_id: ["aws_subnet.private"], vpc_security_group_ids: ["aws_security_group.vms"] },
    "output.peer_vpc_id": { value: ["aws_vpc.lab"] },
  },
};

describe("AWS on the planned diagram", () => {
  it("the region container holds the VPC; subnets, instance, endpoint and bastion sit where AWS puts them", () => {
    const g = plannedGraph(PLANNED as never);
    const node = (key: string) => g.nodes.find((n) => n.key === key)!;
    const rg = node(`resource-groups:group/lab-${ID}`);
    expect(rg).toMatchObject({ kind: "resourceGroup", cloud: "aws" });
    expect(rg.label).toBe(`lab-${ID} · London`);
    expect(node("ec2:vpc/vpc-lab")).toMatchObject({ kind: "vnet", parent: rg.id });
    expect(node("ec2:subnet/snet-private-1")).toMatchObject({ kind: "subnet", parent: node("ec2:vpc/vpc-lab").id });
    expect(node("ec2:instance/vm-app")).toMatchObject({ kind: "vm", parent: node("ec2:subnet/snet-private-1").id, props: { size: "t4g.micro" } });
    expect(node("ec2:instance-connect-endpoint/eice-lab").kind).toBe("bastion");
    expect(node("ec2:vpc-endpoint/vpce-s3")).toMatchObject({ kind: "privateEndpoint", parent: node("ec2:vpc/vpc-lab").id });
    expect(node("ec2:security-group/sg-vms").kind).toBe("nsg");
  });

  it("a read replica with no subnet group of its own sits in its source database's VPC", () => {
    const plan = {
      ...PLANNED,
      changes: [
        ...PLANNED.changes,
        ch("aws_db_subnet_group.db", { name: `lab-${ID}-db`, tags: { Name: "lab-db" } }),
        ch("aws_db_instance.primary", { identifier: "db-a05k3x9q", instance_class: "db.t4g.micro", tags: { Name: "db-primary" } }),
        ch("aws_db_instance.replica", { identifier: "db-a05k3x9q-replica", instance_class: "db.t4g.micro", tags: { Name: "db-replica" } }),
      ],
      refs: {
        ...PLANNED.refs,
        "aws_db_subnet_group.db": { subnet_ids: ["aws_subnet.private"] },
        "aws_db_instance.primary": { db_subnet_group_name: ["aws_db_subnet_group.db"] },
        "aws_db_instance.replica": { replicate_source_db: ["aws_db_instance.primary"] },
      },
    };
    const g = plannedGraph(plan as never);
    const vpc = g.nodes.find((n) => n.key === "ec2:vpc/vpc-lab")!;
    const dbs = g.nodes.filter((n) => n.kind === "sqlServer");
    expect(dbs.map((n) => n.label).sort()).toEqual(["db-primary", "db-replica"]);
    for (const d of dbs) expect(d.parent).toBe(vpc.id);
  });

  it("every AWS kind has an AWS icon, and tagging types map to kinds", () => {
    for (const k of ["vnet", "subnet", "vm", "vmss", "loadBalancer", "nsg", "routeTable", "internetGateway", "privateEndpoint", "bastion", "sqlServer", "storage", "recoveryVault", "managedIdentity", "monitor", "logAnalytics", "messaging", "resourceGroup"] as const) expect(KINDS[k].awsIcon, k).toBeTruthy();
    expect(kindOfAws("ec2:vpc")).toBe("vnet");
    expect(kindOfAws("ec2:instance-connect-endpoint")).toBe("bastion");
    expect(kindOfAws("ssm:association")).toBe("generic");
  });
});

describe("AWS on the live diagram", () => {
  const rows: AwsRow[] = [
    { arn: `arn:aws:resource-groups:eu-west-2:123456789012:group/lab-${ID}`, type: "resource-groups:group", id: `lab-${ID}`, region: "eu-west-2", name: `lab-${ID}`, tags: { "cloudlabs-lab": ID }, props: {}, refs: {} },
    { arn: "arn:aws:ec2:eu-west-2:123456789012:vpc/vpc-0a", type: "ec2:vpc", id: "vpc-0a", region: "eu-west-2", name: "vpc-lab", tags: { Name: "vpc-lab" }, props: { addressSpace: ["10.71.192.0/20"] }, refs: {} },
    { arn: "arn:aws:ec2:eu-west-2:123456789012:subnet/subnet-0b", type: "ec2:subnet", id: "subnet-0b", region: "eu-west-2", name: "snet-private-1", tags: { Name: "snet-private-1" }, props: { prefix: "10.71.192.0/24" }, refs: { vpc: "vpc-0a" } },
    { arn: "arn:aws:ec2:eu-west-2:123456789012:instance/i-0c", type: "ec2:instance", id: "i-0c", region: "eu-west-2", name: "vm-app", tags: { Name: "vm-app" }, props: { size: "t4g.micro", privateIp: "10.71.192.10" }, refs: { vpc: "vpc-0a", subnet: "subnet-0b" } },
  ];
  it("keys live nodes as the planned ones, so the diff matches them", () => {
    const live = awsLiveGraph(rows, { labId: ID, version: 1, gatewayVpcIds: [], at: "2026-10-15T10:00:00.000Z" });
    const planned = plannedGraph(PLANNED as never);
    const keys = (g: { nodes: { key: string }[] }) => new Set(g.nodes.map((n) => n.key).filter(Boolean));
    for (const k of ["ec2:vpc/vpc-lab", "ec2:subnet/snet-private-1", "ec2:instance/vm-app", `resource-groups:group/lab-${ID}`]) {
      expect(keys(live).has(k), k).toBe(true);
      expect(keys(planned).has(k), k).toBe(true);
    }
    expect(Object.values(diffGraphs(planned, live).status).filter((s) => s === "both").length).toBeGreaterThanOrEqual(4);
  });

  it("the route answers no_aws without AWS keys, never asking AWS", async () => {
    freeze();
    const { env, world } = await labEnv({ AWS_WORKER_ACCESS_KEY_ID: undefined, AWS_WORKER_SECRET_ACCESS_KEY: undefined });
    withAwsLabs();
    await runningLab(env, world, "soa-03-auto-scaling");
    const before = world.calls.length;
    const r = await api(env, "GET", "/labs/soa-03-auto-scaling/topology");
    expect(r.json.status).toBe("no_aws");
    expect(world.calls.slice(before).filter((c) => c.host.endsWith("amazonaws.com"))).toEqual([]);
  });
});

// ── More of the planned builder ──

const PLAN2 = {
  labId: "soa-03-auto-scaling",
  version: 1,
  number: "03",
  changes: [
    ch("aws_resourcegroups_group.lab", { name: "lab-soa-03-auto-scaling" }),
    ch("aws_resourcegroups_group.second", { name: "lab-soa-03-auto-scaling" }),
    ch("aws_vpc.lab", { cidr_block: "10.71.192.0/20", tags: { Name: "vpc-lab" } }),
    ch("aws_vpc.dr", { cidr_block: "10.71.208.0/20", tags: { Name: "vpc-dr" } }),
    ch("aws_subnet.private[0]", { cidr_block: "10.71.192.0/24", tags: { Name: "snet-private-1" } }),
    ch("aws_launch_template.web", { name_prefix: "lt-a03k3x9q-", instance_type: "t4g.micro" }),
    ch("aws_autoscaling_group.web", { name: "asg-web-a03k3x9q", desired_capacity: 2 }),
    ch("aws_autoscaling_policy.cpu", { name: "cpu" }),
    ch("aws_lb.web", { name: "alb-a03k3x9q", load_balancer_type: "application", tags: { Name: "alb-a03k3x9q" } }),
    ch("aws_lb_target_group.web", { name: "tg-web", port: 80 }),
    ch("aws_lb_listener.http", { port: 80, protocol: "HTTP" }),
    ch("aws_internet_gateway.lab", { tags: { Name: "igw-lab" } }),
    ch("aws_route_table.public", { tags: { Name: "rt-public" } }),
    ch("aws_route.out", { destination_cidr_block: "0.0.0.0/0" }),
    ch("aws_vpc_peering_connection.dr", { tags: { Name: "peer-dr" } }),
    ch("aws_cloudwatch_log_group.app", { name: "/lab/app" }),
    ch("aws_cloudwatch_dashboard.main", { dashboard_name: "lab-soa-03-auto-scaling-main" }),
    ch("aws_cloudwatch_query_definition.errors", { name: "lab-soa-03-auto-scaling-errors" }),
    ch("aws_config_config_rule.tags", { name: "lab-soa-03-auto-scaling-tags" }),
    ch("aws_config_configuration_recorder.r", { name: "lab-soa-03-auto-scaling-rec" }),
    ch("aws_ssm_patch_baseline.b", { name: "lab-soa-03-auto-scaling-base" }),
    ch("aws_ssm_patch_group.g", { patch_group: "web" }),
    ch("aws_s3_bucket.logs", { bucket: "cloudlabs-a03k3x9q-logs" }),
    ch("aws_s3_bucket_versioning.logs", { versioning_configuration: [{ status: "Enabled" }] }),
    ch("tls_private_key.k", {}),
  ],
  outputs: { peer_vpc_id: null },
  refs: {
    "aws_vpc.dr": { provider: ["aws.secondary"] },
    "aws_resourcegroups_group.second": { provider: ["aws.secondary"] },
    "aws_subnet.private": { vpc_id: ["aws_vpc.lab"] },
    "aws_autoscaling_group.web": { launch_template: ["aws_launch_template.web"], vpc_zone_identifier: ["aws_subnet.private"], target_group_arns: ["aws_lb_target_group.web"] },
    "aws_autoscaling_policy.cpu": { autoscaling_group_name: ["aws_autoscaling_group.web"] },
    "aws_lb.web": { subnets: ["aws_subnet.private"] },
    "aws_lb_listener.http": { load_balancer_arn: ["aws_lb.web"], default_action: ["aws_lb_target_group.web"] },
    "aws_internet_gateway.lab": { vpc_id: ["aws_vpc.lab"] },
    "aws_route_table.public": { vpc_id: ["aws_vpc.lab"] },
    "aws_route.out": { route_table_id: ["aws_route_table.public"], gateway_id: ["aws_internet_gateway.lab"] },
    "aws_vpc_peering_connection.dr": { vpc_id: ["aws_vpc.lab"], peer_vpc_id: ["aws_vpc.dr"] },
    "aws_s3_bucket_versioning.logs": { bucket: ["aws_s3_bucket.logs"] },
    "aws_ssm_patch_group.g": { baseline_id: ["aws_ssm_patch_baseline.b"] },
    "output.peer_vpc_id": { value: ["aws_vpc.lab"] },
  },
};

describe("AWS planned folding, regions and edges", () => {
  const g = plannedGraph(PLAN2 as never);
  const node = (key: string) => g.nodes.find((n) => n.key === key)!;

  it("a second region's group is its own container, labelled Ireland, and its VPC sits in it", () => {
    const groups = g.nodes.filter((n) => n.kind === "resourceGroup");
    expect(groups.map((n) => n.label).sort()).toEqual(["lab-soa-03-auto-scaling · Ireland", "lab-soa-03-auto-scaling · London"]);
    const dr = node("ec2:vpc/vpc-dr#secondary");
    expect(g.nodes.find((n) => n.id === dr.parent)!.label).toMatch(/Ireland/);
    expect(node("ec2:vpc/vpc-lab").cloud).toBe("aws");
  });

  it("launch template, policy, listener, target group, bucket versioning, dashboard, Config and patch pieces fold in; no Terraform-only key remains", () => {
    const asg = node("autoscaling:autoscalinggroup/asg-web-{p}");
    expect(asg.props).toMatchObject({ size: "t4g.micro", instances: 2 });
    expect(asg.folded!.map((f) => f.id).sort()).toEqual(["tf:aws_autoscaling_policy.cpu", "tf:aws_launch_template.web"]);
    expect(node("elasticloadbalancing:loadbalancer/alb-{p}").folded!.length).toBe(2);
    expect(node("logs:log-group//lab/app").folded!.map((f) => f.id).sort()).toEqual(["tf:aws_cloudwatch_dashboard.main", "tf:aws_cloudwatch_query_definition.errors"]);
    expect(node("config:config-rule/lab-soa-03-auto-scaling-tags").folded).toHaveLength(1);
    expect(node("ssm:patchbaseline/lab-soa-03-auto-scaling-base").folded).toHaveLength(1);
    expect(node("s3:bucket/cloudlabs-{p}-logs").folded).toHaveLength(1);
    expect(g.nodes.filter((n) => n.key.startsWith("terraform/"))).toEqual([]);
    expect(g.nodes.some((n) => n.id.includes("tls_private_key"))).toBe(false);
  });

  it("placement: ASG in its subnet, ALB and IGW and route table in the VPC; the mock prefix shows as a03…", () => {
    expect(node("autoscaling:autoscalinggroup/asg-web-{p}").parent).toBe(node("ec2:subnet/snet-private-1").id);
    for (const k of ["elasticloadbalancing:loadbalancer/alb-{p}", "ec2:internet-gateway/igw-lab", "ec2:route-table/rt-public"]) expect(node(k).parent, k).toBe(node("ec2:vpc/vpc-lab").id);
    expect(node("elasticloadbalancing:loadbalancer/alb-{p}").label).toBe("alb-a03…");
    expect(node("ec2:vpc/vpc-lab").props).toMatchObject({ addressSpace: ["10.71.192.0/20"], peerTarget: true });
  });

  it("edges: LB to the ASG with the listener's port, route table to the IGW, peering between the two VPCs", () => {
    const id = (k: string) => node(k).id;
    const has = (from: string, to: string, label?: string) => g.edges.some((e) => e.from === id(from) && e.to === id(to) && e.label === label);
    expect(has("elasticloadbalancing:loadbalancer/alb-{p}", "autoscaling:autoscalinggroup/asg-web-{p}", "HTTP 80")).toBe(true);
    expect(has("ec2:route-table/rt-public", "ec2:internet-gateway/igw-lab", "0.0.0.0/0")).toBe(true);
    const peering = g.edges.filter((e) => e.label === "peering");
    expect(peering).toHaveLength(1);
    expect([peering[0]!.from, peering[0]!.to].sort()).toEqual([id("ec2:vpc/vpc-lab"), id("ec2:vpc/vpc-dr#secondary")].sort());
  });

  it("is deterministic", () => {
    expect(JSON.stringify(plannedGraph(PLAN2 as never))).toBe(JSON.stringify(g));
  });
});

// ── More of the live builder ──

describe("AWS live: peering to the gateway, Auto Scaling instances, skipped types", () => {
  const arn = (r: string) => `arn:aws:ec2:eu-west-2:123456789012:${r}`;
  const row = (type: string, id: string, over: Partial<AwsRow> = {}): AwsRow => ({ arn: arn(`${type.split(":")[1]}/${id}`), type, id, region: "eu-west-2", name: null, tags: {}, props: {}, refs: {}, ...over });
  const rows: AwsRow[] = [
    row("ec2:vpc", "vpc-0a", { tags: { Name: "vpc-lab" } }),
    row("ec2:subnet", "subnet-0b", { tags: { Name: "snet-1" }, refs: { vpc: "vpc-0a" } }),
    row("ec2:vpc-peering-connection", "pcx-1", { props: { status: "active" }, refs: { vpc: "vpc-0a", peerVpc: "vpc-wg" } }),
    row("ec2:volume", "vol-1"),
    row("ec2:security-group-rule", "sgr-1"),
    row("autoscaling:autoScalingGroup", "asg-web", { arn: "arn:aws:autoscaling:eu-west-2:123456789012:autoScalingGroup:u:autoScalingGroupName/asg-web", refs: { subnets: ["subnet-0b"] } }),
    row("ec2:instance", "i-1", { tags: { Name: "web-1", "aws:autoscaling:groupName": "asg-web" }, props: { state: "running" }, refs: { subnet: "subnet-0b", vpc: "vpc-0a" } }),
    row("ec2:instance", "i-2", { tags: { Name: "solo" }, props: { state: "stopped", size: "t4g.micro" }, refs: { subnet: "subnet-0b", vpc: "vpc-0a" } }),
  ];
  const live = awsLiveGraph(rows, { labId: ID, version: 1, gatewayVpcIds: ["vpc-wg"], at: "2026-10-15T10:00:00.000Z" });

  it("draws the gateway node linked by the peering, folds the group's instances and leaves out volumes and rules", () => {
    const gw = live.nodes.find((n) => n.kind === "gateway")!;
    expect(gw.key).toBe("wg/gateway");
    const vpc = live.nodes.find((n) => n.key === "ec2:vpc/vpc-lab")!;
    expect(live.edges).toEqual([expect.objectContaining({ label: "peering", via: arn("vpc-peering-connection/pcx-1"), state: { tone: "ok", word: "Active" } })]);
    expect([live.edges[0]!.from, live.edges[0]!.to].sort()).toEqual([gw.id, vpc.id].sort());
    expect(live.nodes.map((n) => n.key).sort()).toEqual(["autoscaling:autoscalinggroup/asg-web", "ec2:instance/solo", "ec2:subnet/snet-1", "ec2:vpc/vpc-lab", "wg/gateway"]);
    expect(live.nodes.find((n) => n.key === "autoscaling:autoscalinggroup/asg-web")!.folded).toHaveLength(1);
    expect(live.nodes.find((n) => n.key === "ec2:instance/solo")).toMatchObject({ parent: live.nodes.find((n) => n.key === "ec2:subnet/snet-1")!.id, health: { tone: "bad", word: "Stopped" }, cloud: "aws" });
  });
});

// ── The route, with AWS answering ──

afterEach(() => {
  vi.unstubAllGlobals();
  resetTopologyCache();
});

const xml = (action: string, body: string) => new Response(`<${action}Response>${body}</${action}Response>`, { status: 200 });
const T = "arn:aws:ec2:eu-west-2:123456789012";

/** AWS in front of the harness: the lab's tagged resources and the describes behind them. */
function fakeAws(over: { fail?: { status: number; code: string } } = {}) {
  const seen: { host: string; action: string }[] = [];
  const prev = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const req = typeof input === "object" && "url" in input && !(input instanceof URL) ? input : null;
    const u = new URL(req ? req.url : String(input));
    if (!/^(ec2|tagging|elasticloadbalancing).[a-z0-9-]+.amazonaws.com$/.test(u.hostname)) return prev(input as string, init);
    const target = (init?.headers ? new Headers(init.headers) : req?.headers)?.get("x-amz-target") ?? null;
    const body = init?.body != null ? String(init.body) : req ? await req.clone().text() : "";
    const action = target ?? new URLSearchParams(body).get("Action") ?? "";
    seen.push({ host: u.hostname, action });
    if (over.fail && target) return Response.json({ __type: over.fail.code, message: "no" }, { status: over.fail.status });
    if (over.fail) return new Response(`<Response><Errors><Error><Code>${over.fail.code}</Code><Message>no</Message></Error></Errors></Response>`, { status: over.fail.status });
    if (target && u.hostname === "tagging.us-east-1.amazonaws.com") return Response.json({ ResourceTagMappingList: [{ ResourceARN: "arn:aws:cloudfront::123456789012:distribution/E1ABC", Tags: [{ Key: "cloudlabs-lab", Value: "soa-09-route53-cloudfront" }, { Key: "Name", Value: "cdn-site" }] }] });
    if (target) return Response.json({ ResourceTagMappingList: [{ ResourceARN: `${T}:vpc/vpc-0a`, Tags: [{ Key: "cloudlabs-lab", Value: "soa-03-auto-scaling" }, { Key: "Name", Value: "vpc-lab" }] }, { ResourceARN: `${T}:subnet/subnet-0b`, Tags: [{ Key: "cloudlabs-lab", Value: "soa-03-auto-scaling" }] }, { ResourceARN: "arn:aws:resource-groups:eu-west-2:123456789012:group/lab-soa-09-route53-cloudfront", Tags: [{ Key: "cloudlabs-lab", Value: "soa-09-route53-cloudfront" }] }] });
    switch (action) {
      case "DescribeVpcs":
        return xml(action, "<vpcSet><item><vpcId>vpc-0a</vpcId><cidrBlock>10.71.192.0/20</cidrBlock><cidrBlockAssociationSet><item><cidrBlock>10.71.192.0/20</cidrBlock></item></cidrBlockAssociationSet></item></vpcSet>");
      case "DescribeSubnets":
        return xml(action, "<subnetSet><item><subnetId>subnet-0b</subnetId><vpcId>vpc-0a</vpcId><cidrBlock>10.71.192.0/24</cidrBlock><tagSet><item><key>Name</key><value>snet-private-1</value></item></tagSet></item></subnetSet>");
      case "DescribeInstances":
        return xml(action, "<reservationSet/>");
      case "DescribeVpcPeeringConnections":
        return xml(action, "<vpcPeeringConnectionSet><item><vpcPeeringConnectionId>pcx-1</vpcPeeringConnectionId><requesterVpcInfo><vpcId>vpc-0a</vpcId></requesterVpcInfo><accepterVpcInfo><vpcId>vpc-wg</vpcId></accepterVpcInfo><status><code>active</code></status></item></vpcPeeringConnectionSet>");
      default:
        return xml(action, "");
    }
  });
  return seen;
}

async function runningAws() {
  freeze();
  const { env, world } = await labEnv();
  withAwsLabs();
  resetTopologyCache();
  await runningLab(env, world, "soa-03-auto-scaling");
  return { env, world };
}

describe("GET /labs/:id/topology for an AWS lab", () => {
  it("builds the live graph from at most 14 tag-filtered reads, gateway node included", async () => {
    const { env } = await runningAws();
    const seen = fakeAws();
    const r = await api(env, "GET", "/labs/soa-03-auto-scaling/topology");
    expect(r.json.status).toBe("ok");
    expect(seen.length).toBeLessThanOrEqual(AWS_TOPOLOGY_CALLS_MAX);
    expect(seen.map((s) => s.action).sort()).toEqual(["DescribeInstances", "DescribeNatGateways", "DescribeRouteTables", "DescribeSubnets", "DescribeTransitGatewayAttachments", "DescribeVpcEndpoints", "DescribeVpcPeeringConnections", "DescribeVpcs", "ResourceGroupsTaggingAPI_20170126.GetResources"].sort());
    const keys = (r.json.live.nodes as { key: string }[]).map((n) => n.key);
    expect(keys).toEqual(expect.arrayContaining(["ec2:vpc/vpc-lab", "ec2:subnet/snet-private-1", "wg/gateway"]));
    expect(JSON.stringify(r.json)).not.toMatch(/cidrBlockAssociation|AccessKey/);
    // Cached for 30 s: a second ask makes no AWS call.
    const n = seen.length;
    await api(env, "GET", "/labs/soa-03-auto-scaling/topology");
    expect(seen.length).toBe(n);
  });

  it("ruling P7: a global lab's us-east-1 items join its London container, within the call cap", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    resetTopologyCache();
    await runningLab(env, world, "soa-09-route53-cloudfront");
    const seen = fakeAws();
    const r = await api(env, "GET", "/labs/soa-09-route53-cloudfront/topology");
    expect(seen.length).toBeLessThanOrEqual(AWS_TOPOLOGY_CALLS_MAX);
    const nodes = r.json.live.nodes as { key: string; kind: string; cloud: string; parent: string | null; id: string }[];
    const node = nodes.find((n) => n.key === "cloudfront:distribution/cdn-site");
    expect(node).toMatchObject({ kind: "frontDoor", cloud: "aws" });
    expect(nodes.find((n) => n.id === node!.parent)!.kind).toBe("resourceGroup");
  });

  it("ruling P5: a two-region DNS lab's live graph reads London, Ireland and us-east-1 within the call cap", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    resetTopologyCache();
    await runningLab(env, world, "saa-16-dr-pilot-light");
    const seen = fakeAws();
    const r = await api(env, "GET", "/labs/saa-16-dr-pilot-light/topology");
    expect(r.json.status).toBe("ok");
    expect(AWS_TOPOLOGY_CALLS_MAX).toBe(15);
    expect(seen.length).toBeLessThanOrEqual(AWS_TOPOLOGY_CALLS_MAX);
    expect(seen.filter((s) => s.host.endsWith(".us-east-1.amazonaws.com")).map((s) => s.action)).toEqual(["ResourceGroupsTaggingAPI_20170126.GetResources"]);
    expect(seen.some((s) => s.host === "tagging.eu-west-1.amazonaws.com")).toBe(true);
  });

  it("an AWS refusal is failed in plain words; throttling is throttled", async () => {
    const { env } = await runningAws();
    fakeAws({ fail: { status: 403, code: "UnauthorizedOperation" } });
    const refused = await api(env, "GET", "/labs/soa-03-auto-scaling/topology");
    expect(refused.json).toMatchObject({ status: "failed", live: null });
    expect(refused.json.message).toMatch(/UnauthorizedOperation/);
    vi.unstubAllGlobals();
    resetTopologyCache();
    const { env: env2 } = await runningAws();
    fakeAws({ fail: { status: 400, code: "RequestLimitExceeded" } });
    const busy = await api(env2, "GET", "/labs/soa-03-auto-scaling/topology");
    expect(busy.json.status).toBe("throttled");
  });
});

// ── Every kind an AWS lab can draw has an AWS icon ──

describe("AWS icons cover every kind an AWS lab produces", () => {
  it("each kind named by an AWS rule, an AWS Terraform type or a tagging type has an awsIcon, so no AWS card falls back to an Azure icon", async () => {
    const { AWS_TF_RULES } = await import("../../shared/topology/rules/awsPlanned");
    const { kindOfTf } = await import("../../shared/topology/kinds");
    const kinds = new Set<string>(["gateway", "generic"]);
    for (const [type, rule] of Object.entries(AWS_TF_RULES)) {
      if (rule.ignore || rule.fold || rule.foldToReferrer || rule.foldInto) continue;
      kinds.add(rule.kind ?? kindOfTf(type));
    }
    for (const [k, d] of Object.entries(KINDS)) if (d.awsTypes.length || d.tfTypes.some((t) => t.startsWith("aws_"))) kinds.add(k);
    // `gateway` is the one synthetic kind an AWS graph may carry; it is drawn with the Azure gateway icon, which loads with the page.
    for (const k of kinds) if (k !== "gateway") expect(KINDS[k as keyof typeof KINDS].awsIcon, k).toBeTruthy();
  });
});

describe("batch 2's types on the diagrams", () => {
  const b2 = (labId: string, changes: ReturnType<typeof ch>[], refs: Record<string, Record<string, string[]>>) => plannedGraph({ labId, version: 1, number: "10", changes: [ch("aws_resourcegroups_group.lab", { name: `lab-${labId}` }), ...changes], outputs: { peer_vpc_id: null }, refs } as never);

  it("an ECS service behind an ALB: the task definition folds in, the LB's edge reaches the service; ECR and the cluster are their own cards", () => {
    const g = b2("soa-10-containers", [
      ch("aws_lb.web", { load_balancer_type: "application", tags: { Name: "alb-web" } }),
      ch("aws_lb_target_group.web", { tags: { Name: "tg-web" } }),
      ch("aws_lb_listener.http", { port: 80, protocol: "HTTP", tags: { Name: "listener-http" } }),
      ch("aws_ecs_cluster.lab", { name: "lab-soa-10-containers", tags: { Name: "ecs-lab" } }),
      ch("aws_ecs_task_definition.web", { family: "lab-soa-10-containers-web", tags: { Name: "td-web" } }),
      ch("aws_ecs_service.web", { name: "lab-soa-10-containers-web", desired_count: 2, tags: { Name: "svc-web" } }),
      ch("aws_ecr_repository.web", { name: "lab-soa-10-containers-web", tags: { Name: "ecr-web" } }),
      ch("aws_ecr_lifecycle_policy.web", {}),
    ], {
      "aws_lb_listener.http": { load_balancer_arn: ["aws_lb.web"], default_action: ["aws_lb_target_group.web"] },
      "aws_ecs_service.web": { cluster: ["aws_ecs_cluster.lab"], task_definition: ["aws_ecs_task_definition.web"], load_balancer: ["aws_lb_target_group.web"] },
      "aws_ecr_lifecycle_policy.web": { repository: ["aws_ecr_repository.web"] },
    });
    const keys = g.nodes.map((n) => n.key);
    for (const k of ["ecs:service/svc-web", "ecs:cluster/ecs-lab", "ecr:repository/ecr-web", "elasticloadbalancing:loadbalancer/alb-web"]) expect(keys).toContain(k);
    expect(keys).not.toContain("ecs:task-definition/td-web");
    expect(g.nodes.find((n) => n.key === "ecs:service/svc-web")).toMatchObject({ kind: "containerApp" });
    const nid = (k: string) => g.nodes.find((n) => n.key === k)?.id;
    expect(g.edges.some((e) => e.from === nid("elasticloadbalancing:loadbalancer/alb-web") && e.to === nid("ecs:service/svc-web") && e.label === "HTTP 80")).toBe(true);
  });

  it("a distribution fronting its bucket, a zone and a health check; a user, a key and a secret; a stack; a flow log", () => {
    const g = b2("soa-09-route53-cloudfront", [
      ch("aws_s3_bucket.site", { bucket: "cloudlabs-a09k3x9q-site", tags: { Name: "site" } }),
      ch("aws_cloudfront_origin_access_control.site", { name: "lab-soa-09-route53-cloudfront-a09k3x9q" }),
      ch("aws_cloudfront_distribution.site", { tags: { Name: "cdn-site" } }),
      ch("aws_route53_zone.lab", { name: "a09k3x9q.labs.clydeford.net", tags: { Name: "zone-lab" } }),
      ch("aws_route53_record.www_primary", { name: "www.a09k3x9q.labs.clydeford.net" }),
      ch("aws_route53_health_check.primary", { tags: { Name: "hc-primary" } }),
      ch("aws_iam_user.ann", { name: "lab-x-ann", tags: { Name: "user-ann" } }),
      ch("aws_iam_user_policy_attachment.ann", {}),
      ch("aws_kms_key.data", { tags: { Name: "key-data" } }),
      ch("aws_kms_alias.data", { name: "alias/lab-x-data" }),
      ch("aws_secretsmanager_secret.app", { name: "lab-x-app", tags: { Name: "secret-app" } }),
      ch("aws_cloudformation_stack.lab", { name: "lab-x-stack", tags: { Name: "stack-lab" } }),
      ch("aws_flow_log.data", { tags: { Name: "flow-data" } }),
    ], {
      "aws_cloudfront_distribution.site": { origin: ["aws_s3_bucket.site", "aws_cloudfront_origin_access_control.site"] },
      "aws_route53_record.www_primary": { zone_id: ["aws_route53_zone.lab"] },
      "aws_kms_alias.data": { target_key_id: ["aws_kms_key.data"] },
      "aws_iam_user_policy_attachment.ann": { user: ["aws_iam_user.ann"] },
    });
    const kind = (k: string) => g.nodes.find((n) => n.key === k)?.kind;
    expect([kind("cloudfront:distribution/cdn-site"), kind("route53:hostedzone/zone-lab"), kind("route53:healthcheck/hc-primary"), kind("iam:user/user-ann"), kind("kms:key/key-data"), kind("secretsmanager:secret/secret-app"), kind("ec2:vpc-flow-log/flow-data")]).toEqual(["frontDoor", "dnsZone", "monitor", "managedIdentity", "keyVault", "keyVault", "flowLog"]);
    expect(kind("cloudformation:stack/stack-lab")).toBe("generic");
    expect(g.nodes.some((n) => n.key.includes("origin-access-control") || n.key.startsWith("route53:record"))).toBe(false);
    const nid = (k: string) => g.nodes.find((n) => n.key === k)?.id;
    expect(g.edges.some((e) => e.from === nid("cloudfront:distribution/cdn-site") && e.to === nid("s3:bucket/site") && e.label === "origin")).toBe(true);
  });

  it("the live view draws the same kinds as the plan (C13)", () => {
    expect([kindOfAws("iam:user"), kindOfAws("secretsmanager:secret"), kindOfAws("kms:key"), kindOfAws("route53:healthcheck"), kindOfAws("ec2:vpc-flow-log")]).toEqual(["managedIdentity", "keyVault", "keyVault", "monitor", "flowLog"]);
  });

  it("ruling P19: live rows CloudFormation made fold into their stack; ECS tasks and task definitions are left out", () => {
    const row = (type: string, id: string, tags: Record<string, string>): AwsRow => ({ arn: `arn:aws:${type.split(":")[0]}:eu-west-2:123456789012:${type.split(":")[1]}/${id}`, type, id, region: "eu-west-2", name: tags.Name ?? null, tags: { "cloudlabs-lab": "soa-06-cloudformation", ...tags }, props: {}, refs: {} });
    const g = awsLiveGraph([
      row("resource-groups:group", "lab-soa-06-cloudformation", { Name: "lab-soa-06-cloudformation" }),
      row("cloudformation:stack", "lab-soa-06-cloudformation-stack", { Name: "stack-lab" }),
      row("sqs:queue", "lab-soa-06-cloudformation-stack-WorkQueue-AbC", { "aws:cloudformation:stack-name": "lab-soa-06-cloudformation-stack" }),
      row("ecs:task", "c/0abc", {}),
      row("ecs:task-definition", "t:1", {}),
    ], { labId: "soa-06-cloudformation", version: 1, gatewayVpcIds: [], at: "2026-10-16T00:00:00Z" });
    const keys = g.nodes.map((n) => n.key);
    expect(keys).toContain("cloudformation:stack/stack-lab");
    expect(keys.some((k) => k.startsWith("sqs:queue") || k.startsWith("ecs:task"))).toBe(false);
  });
});
