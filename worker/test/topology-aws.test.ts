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
    if (target) return Response.json({ ResourceTagMappingList: [{ ResourceARN: `${T}:vpc/vpc-0a`, Tags: [{ Key: "cloudlabs-lab", Value: "soa-03-auto-scaling" }, { Key: "Name", Value: "vpc-lab" }] }, { ResourceARN: `${T}:subnet/subnet-0b`, Tags: [{ Key: "cloudlabs-lab", Value: "soa-03-auto-scaling" }] }] });
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
