// devseed-insights-aws.ts
//
// Plain English: the dev seeder's `insights-aws` story (AWS insights spec
// section 7, last bullet): the running story underneath, moved to AWS (the
// snapshot's cloud, region and instance type), plus what the AWS collector
// and a version-7 agent would have stored by now. Every AWS feed ok, a dip
// in the instance's CPU credits, one change to the security group made by a
// person, one active AWS issue in the region, a reboot AWS has scheduled,
// the console output, the region's capacity and list prices, and the
// instance's vitals. Only this story fills the aws_* tables, so every other
// story's pictures stay exactly as before (Azure's az_* tables stay empty).
//
// Fixed values only (no random numbers): seeding twice gives the same rows.
// Fake identities only: made-up instance and group ids, no account number,
// TEST-NET addresses.

import type { Env } from "./env";
import { getSnapshot, saveSnapshot, type VmVitals } from "./state";
import { bucket } from "./history";
import { awsRegionName } from "../../shared/azureMetrics";
import { AWS_FEED_MODULES } from "./insights/aws/feeds/index";
import type { AwsBootLogDoc, AwsHealthDoc } from "./insights/aws/types";
import type { CapacityDoc } from "./insights/types";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const SLOT = 300;
const iso = (ms: number) => new Date(ms).toISOString();

/** The seeded headend and its security group (made-up ids). */
export const SEED_AWS_INSTANCE = "i-0seed0000000000a1";
const SEED_AWS_SG = "sg-0seed00000000000b2";
const SEED_AWS_EIP = "eipalloc-0seed000000000c3";
/** cloudlabs' own Worker user, as CloudTrail names it. */
const WORKER_USER = "wg-admin-worker";

/** Move the running story to AWS and fill the aws_* tables for an instance that came up at `startMs`. */
export async function seedAwsInsights(env: Env, now: number, startMs: number, aws: { region: string; instanceType: string }): Promise<void> {
  const place = awsRegionName(aws.region);
  const stmts: D1PreparedStatement[] = [];
  const add = (sql: string, ...args: unknown[]) => stmts.push(env.DB.prepare(sql).bind(...args));

  // Every AWS feed worked a couple of minutes ago (the boot log after the start, housekeeping overnight).
  for (const f of AWS_FEED_MODULES) {
    const ok = f.id === "aws.bootLog" ? startMs + 6 * MIN : f.id === "aws.housekeeping" ? now - 7 * HOUR : now - 2 * MIN;
    add("INSERT INTO aws_feed (feed, last_try_at, last_ok_at, status, error, next_due_at) VALUES (?1, ?2, ?2, 'ok', NULL, ?3)", f.id, iso(ok), f.cadenceMin === null ? null : iso(ok + f.cadenceMin * MIN));
  }

  // CloudWatch's figures, one 5-minute slot at a time since the instance came up. The credits dip about an hour ago.
  const first = Date.parse(bucket(startMs, SLOT));
  const last = Date.parse(bucket(now - SLOT * 1000, SLOT));
  let i = 0;
  for (let t = first; t <= last; t += SLOT * 1000, i++) {
    const minsAgo = (now - t) / MIN;
    const busy = minsAgo > 55 && minsAgo < 95;
    const cpu = busy ? 36 + (i % 4) * 6 : 3 + (i % 5) * 1.5;
    const credits = busy ? Math.max(20, 150 - (95 - minsAgo) * 3) : minsAgo >= 95 ? 152 : Math.min(80, 20 + (55 - minsAgo) * 1.2);
    const netIn = 19_000 + (i % 7) * 2_300;
    const netOut = 16_000 + (i % 5) * 1_900;
    add(
      "INSERT INTO hist_aws_vm (res, t, cpu_avg, cpu_max, net_in, net_out, disk_read, disk_write, disk_rops, disk_wops, credits_min, credits_used, status_failed, pkts_in, pkts_out) VALUES (CAST(?1 AS INTEGER), ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 0, ?13, ?14)",
      SLOT, bucket(t, SLOT), cpu, Math.min(100, cpu * 1.8), netIn, netOut, 1_100 + (i % 3) * 350, 8_500 + (i % 4) * 1_400, 0.3 + (i % 3) * 0.2, 1.9 + (i % 4) * 0.5, Math.round(credits * 10) / 10, busy ? 4.1 : 0.3, 11_000 + (i % 7) * 850, 9_500 + (i % 5) * 700,
    );
  }

  // What EC2 says about the instance now, and a reboot AWS has scheduled.
  const health: AwsHealthDoc = {
    instanceId: SEED_AWS_INSTANCE,
    health: {
      state: "Available",
      title: "Both AWS status checks passed.",
      summary: "AWS's hardware check and the instance check both passed.",
      reason: null,
      since: null,
      power: "Server running",
      provisioning: null,
      vmAgent: null,
      bootDiagnostics: true,
      checkedAt: iso(now - 2 * MIN),
    },
    maintenance: [{ id: "instance-event-0seed00000000001", type: "system-reboot", status: "Scheduled", notBefore: iso(now + 2 * DAY), source: "AWS", description: "scheduled reboot", durationS: 2 * 3600 }],
  };
  add("INSERT INTO aws_latest (key, json, updated_at) VALUES ('health', ?1, ?2)", JSON.stringify(health), iso(now - 2 * MIN));

  // The console output read after the start, stored as the collector stores it: redacted, no URL.
  const bootText = [
    "[    0.000000] Booting Linux on physical CPU 0x0000000000 [0x413fd0c1]",
    "[    0.000000] Linux version 6.8.0-1016-aws (buildd@bos02-arm64-011) (aarch64-linux-gnu-gcc-13) #17-Ubuntu SMP",
    "[    0.000000] Machine model: Amazon EC2 t4g.micro",
    "[    1.611092] EXT4-fs (nvme0n1p1): mounted filesystem with ordered data mode.",
    "[    4.302114] cloud-init[598]: Cloud-init v. 24.1 running 'init' at Fri, 02 Oct 2026 12:04:31 +0000.",
    "[    8.871034] cloud-init[598]: ci-info: | ens5 | True | 10.60.1.10 | 255.255.255.0 | global |",
    "[   21.940552] cloud-init[1012]: Setting up wireguard-tools (1.0.20210914-1ubuntu4) ...",
    "[   23.511840] cloud-init[1012]: chpasswd: ubuntu password set to ‹redacted›",
    "[   25.904117] wg-quick[1371]: [#] wg setconf wg0 /dev/fd/63 (private key ‹redacted›)",
    "[   26.300410] systemd[1]: Started wg-agent.timer - wg-admin status agent.",
    "[   30.118377] cloud-init[1012]: Cloud-init v. 24.1 finished. Datasource DataSourceEc2Local. Up 30.11 seconds",
    "",
  ].join("\n");
  const bootLog: AwsBootLogDoc = { fetchedAt: iso(startMs + 6 * MIN), bytes: new TextEncoder().encode(bootText).length, truncated: false, redactions: 2, text: bootText, reason: null, launchTime: iso(startMs) };
  add("INSERT INTO aws_latest (key, json, updated_at) VALUES ('bootlog', ?1, ?2)", JSON.stringify(bootLog), iso(startMs + 6 * MIN));

  // CloudTrail: cloudlabs' own deploy, one change to the security group by a person, and AWS acting on its own.
  const act = (id: string, at: number, op: string, caller: string, kind: string, type: string, name: string, status = "Succeeded") =>
    add("INSERT INTO aws_activity (id, at, operation, status, caller, caller_kind, resource_type, resource_name) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)", id, iso(at), op, status, caller, kind, type, name);
  act("00000000-seed-aws0-0000-000000000001", startMs + 1 * MIN, "CreateSecurityGroup", WORKER_USER, "wgadmin", "Security group", SEED_AWS_SG);
  act("00000000-seed-aws0-0000-000000000002", startMs + 1 * MIN + 20_000, "AuthorizeSecurityGroupIngress", WORKER_USER, "wgadmin", "Security group", SEED_AWS_SG);
  act("00000000-seed-aws0-0000-000000000003", startMs + 2 * MIN, "RunInstances", WORKER_USER, "wgadmin", "EC2 instance", SEED_AWS_INSTANCE);
  act("00000000-seed-aws0-0000-000000000004", startMs + 3 * MIN, "AssociateAddress", WORKER_USER, "wgadmin", "Elastic IP", SEED_AWS_EIP);
  act("00000000-seed-aws0-0000-000000000005", now - 40 * MIN, "AuthorizeSecurityGroupIngress", "someone", "person", "Security group", SEED_AWS_SG);
  act("00000000-seed-aws0-0000-000000000006", now - 3 * DAY, "ModifyInstanceAttribute", "ec2.amazonaws.com", "aws", "EC2 instance", SEED_AWS_INSTANCE);

  // AWS's status feed: an active EC2 issue in the region now, and last week's resolved VPC one.
  add(
    "INSERT INTO aws_service_events (tracking_id, type, status, level, title, summary, services, regions, starts_at, ends_at, updated_at) VALUES ('seed-aws-ec2-1', 'ServiceIssue', 'Active', NULL, ?1, ?2, ?3, ?4, ?5, NULL, ?6)",
    `Increased network latency for instances in ${place}`, "We are investigating increased network latency for some EC2 instances in a single Availability Zone.", JSON.stringify(["EC2"]), JSON.stringify([place]), iso(now - 50 * MIN), iso(now - 12 * MIN),
  );
  add(
    "INSERT INTO aws_service_events (tracking_id, type, status, level, title, summary, services, regions, starts_at, ends_at, updated_at) VALUES ('seed-aws-vpc-1', 'ServiceIssue', 'Resolved', NULL, ?1, ?2, ?3, ?4, ?5, NULL, ?5)",
    `[RESOLVED] Elevated VPC API error rates in ${place}`, "Between 09:10 and 09:55 some VPC API calls returned errors. The issue has been resolved and the service is operating normally.", JSON.stringify(["VPC"]), JSON.stringify([place]), iso(now - 8 * DAY),
  );

  // Capacity: both sizes cloudlabs deploys are offered; the quota is mostly free.
  const capacity: CapacityDoc = {
    sizes: [
      { name: aws.instanceType, available: true, reason: null, vcpus: 2, family: "standard" },
      { name: "t4g.nano", available: true, reason: null, vcpus: 2, family: "standard" },
    ],
    usages: [{ family: "standard", used: 2, limit: 32 }],
    cores: { used: 2, limit: 32 },
  };
  add("INSERT INTO aws_capacity (region, json, fetched_at) VALUES (?1, ?2, ?3)", aws.region, JSON.stringify(capacity), iso(now - 2 * HOUR));

  // List prices (USD converted to GBP), before discounts and VAT.
  const price = (item: string, gbp: number, unit: string, meter: string) => add("INSERT INTO aws_prices (region, item, gbp, unit, meter, fetched_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)", aws.region, item, gbp, unit, meter, iso(now - 5 * HOUR));
  price(aws.instanceType, 0.0068, "1 Hour", "EUW2-BoxUsage:t4g.micro");
  price("disk:gp3", 0.0711, "GB-Mo", "EUW2-EBS:VolumeUsage.gp3");
  price("ip:v4", 0.0039, "1 Hour", "EUW2-PublicIPv4:InUseAddress");

  // The instance's own vitals in its heartbeat history.
  add(
    "UPDATE hist_vm SET mem_used_pct = 41 + (CAST(substr(t, 15, 2) AS INTEGER) % 7), disk_used_pct = 27.5, steal_pct = (CAST(substr(t, 15, 2) AS INTEGER) % 3) * 0.3, conntrack_pct = 0.2 + (CAST(substr(t, 15, 2) AS INTEGER) % 5) * 0.05, net_rtt_ms = 8 + (CAST(substr(t, 15, 2) AS INTEGER) % 4), net_loss_pct = 0 WHERE t >= ?1",
    bucket(startMs, 60),
  );
  await env.DB.batch(stmts);

  // The server is in AWS, with a version-7 agent sending vitals (AWS's scheduled events come from EC2, not the heartbeat).
  const snap = await getSnapshot(env);
  const vitals: VmVitals = {
    mem: { total: 948_000_000, available: 540_000_000 },
    disk: { total: 8_300_000_000, used: 2_280_000_000, avail: 6_020_000_000 },
    cpu: { steal_pct: 0.3, iowait_pct: 0.1, ncpu: 2 },
    conntrack: { count: 58, max: 32768 },
    updates: { pending: 2, security: 0, at: iso(now - 2 * HOUR) },
    events: null,
    net: { at: iso(now - 3 * MIN), method: "icmp", targets: [{ ip: "1.1.1.1", rtt_ms: 8.6, loss_pct: 0 }, { ip: "8.8.8.8", rtt_ms: 9.2, loss_pct: 0 }] },
  };
  await saveSnapshot(env, {
    cloud: "aws",
    region: aws.region,
    vm_size: aws.instanceType,
    profile: null,
    azure: null,
    ...(snap.agent ? { agent: { ...snap.agent, agent_version: 7, vitals } } : {}),
  });
}
