// test/awsFixtures.ts
//
// Plain English: whole /api/v1/azure/* answers for a server in AWS (AWS
// insights spec 2026-10-15 sections 6 and 7): the same response types as
// Azure's, tagged cloud "aws", each feed naming its AWS source, and the
// figures AWS has no match for (memory free, availability, disk IOPS and
// bandwidth %, every DDoS figure) null. A test overrides only what it is
// about. TEST-NET addresses and invented ids only.

import type { AzureChangeRow, AzureChangesResponse, AzureMetricsResponse, AzureServiceHealthResponse, AzureSummaryResponse, FeedId, FeedStatus, ServiceEvent } from "@shared/api";
import { FEEDS, PIP_COLUMNS, VM_COLUMNS } from "@shared/azureMetrics";

const NOW_MS = Date.parse("2026-10-02T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW_MS - ms).toISOString();
const MIN = 60_000;
const HOUR = 3_600_000;

/** What the Worker names as each feed's source on AWS (worker/src/insights/aws/types.ts AWS_SOURCES, by the FeedId it stands in for). */
export const AWS_FEED_SOURCES: Record<FeedId, string> = {
  health: "AWS EC2",
  vmMetrics: "AWS CloudWatch",
  pipMetrics: "AWS CloudWatch",
  metricDefs: "AWS CloudWatch",
  activity: "AWS CloudTrail",
  serviceHealth: "AWS public status feed",
  capacity: "AWS Service Quotas",
  prices: "AWS Price List",
  bootLog: "AWS console output",
};

/** An AWS feed's status: ok two minutes ago unless told otherwise. */
export const awsFeedFixture = (id: FeedId, over: Partial<FeedStatus> = {}): FeedStatus => {
  const f = FEEDS.find((x) => x.id === id)!;
  return { id, title: f.title, status: "ok", lastOkAt: ago(2 * MIN), error: null, cadenceMin: id === "vmMetrics" || id === "pipMetrics" ? 15 : f.cadenceMin, source: AWS_FEED_SOURCES[id], ...over };
};

/** GET /azure/summary for a running AWS server with AWS connected, both status checks passed and nothing wrong. */
export const awsSummaryFixture = (over: Partial<AzureSummaryResponse> = {}): AzureSummaryResponse => {
  const configured = over.configured ?? true;
  return {
    cloud: "aws",
    configured,
    region: { id: "eu-west-2", name: "London" },
    feeds: FEEDS.map((f) => awsFeedFixture(f.id, configured ? {} : { status: "not_configured", lastOkAt: null })),
    health: configured
      ? { state: "Available", title: "Both AWS status checks passed.", summary: "Both AWS status checks passed.", reason: null, since: null, power: "Server running", provisioning: null, vmAgent: null, bootDiagnostics: true, annotations: [], checkedAt: ago(2 * MIN) }
      : null,
    maintenance: [],
    serviceIssues: [],
    vitals: null,
    agent: "none",
    latest: configured ? { cpuPct: 4, creditsLeft: 140, creditsTrend: "flat", memFreeBytes: null, vipAvailPct: null, underDdos: null, at: ago(5 * MIN) } : { cpuPct: null, creditsLeft: null, memFreeBytes: null, vipAvailPct: null, underDdos: null, at: null },
    ...over,
  };
};

const slots = (n: number) => Array.from({ length: n }, (_, i) => ago((n - i) * 5 * MIN));

/** VM metrics on AWS: VM_COLUMNS, with the columns AWS has no match for null in every slot. */
export function awsVmMetrics(range: AzureMetricsResponse["range"] = "24h"): AzureMetricsResponse {
  const awsOnlyNull = new Set(["mem_free_min", "avail_avg", "os_iops_max", "os_bw_max"]);
  const points = slots(12).map((t, i) => {
    const p: Record<string, number | string | null> = { t };
    for (const c of VM_COLUMNS) p[c] = awsOnlyNull.has(c) ? null : c === "cpu_avg" ? 3 + i : c === "cpu_max" ? 8 + i : c === "credits_min" ? 140 - i : 2000 + i;
    return p;
  });
  return { cloud: "aws", resource: "vm", range, step: 300, columns: ["t", ...VM_COLUMNS], points };
}

/** Public IP metrics on AWS: packets and bytes from the instance's counters; every DDoS figure, SYN and availability null. */
export function awsPipMetrics(range: AzureMetricsResponse["range"] = "24h"): AzureMetricsResponse {
  const points = slots(6).map((t, i) => {
    const p: Record<string, number | string | null> = { t };
    for (const c of PIP_COLUMNS) p[c] = c === "packets" ? 4000 + i : c === "bytes" ? 2_500_000 + i : null;
    return p;
  });
  return { cloud: "aws", resource: "pip", range, step: 300, columns: ["t", ...PIP_COLUMNS], points };
}

/** Two CloudTrail changes: cloudlabs opening a port, and someone resizing the instance by hand. */
export function awsChangesResponse(over: Partial<AzureChangesResponse> = {}): AzureChangesResponse {
  const rows: AzureChangeRow[] = [
    { id: "ev-1", at: ago(20 * MIN), operation: "AuthorizeSecurityGroupIngress", status: "Succeeded", caller: "wg-admin-worker", callerKind: "wgadmin", resourceType: "Security group", resourceName: "sg-0a1b2c3d" },
    { id: "ev-2", at: ago(2 * HOUR), operation: "ModifyInstanceAttribute", status: "Succeeded", caller: "steven", callerKind: "person", resourceType: "EC2 instance", resourceName: "i-0123456789abcdef0" },
    { id: "ev-3", at: ago(3 * HOUR), operation: "AttachVolume", status: "Succeeded", caller: "ec2.amazonaws.com", callerKind: "azure", resourceType: "EBS volume", resourceName: "vol-0f00ba11" },
  ];
  return { cloud: "aws", range: "7d", feed: awsFeedFixture("activity"), rows, ...over };
}

/** One active EC2 issue in London from the public status feed. */
export const awsIssue = (over: Partial<ServiceEvent> = {}): ServiceEvent => ({
  trackingId: "ec2-eu-west-2-1",
  type: "ServiceIssue",
  status: "Active",
  level: null,
  title: "Increased API error rates",
  summary: "We are investigating increased API error rates in the EU-WEST-2 Region.",
  services: ["EC2"],
  startsAt: ago(40 * MIN),
  endsAt: null,
  updatedAt: ago(10 * MIN),
  ...over,
});

export const awsHealthResponse = (events: ServiceEvent[] = [awsIssue()], over: Partial<AzureServiceHealthResponse> = {}): AzureServiceHealthResponse => ({ cloud: "aws", events, feed: awsFeedFixture("serviceHealth"), ...over });
