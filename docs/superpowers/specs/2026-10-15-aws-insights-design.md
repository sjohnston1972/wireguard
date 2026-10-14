# cloudlabs AWS insights: design

Date: 2026-10-15. Status: Steven approved the design in conversation (panels in Part 1, build in Part 2) and said "I'm happy
for you to just build it". This spec is the record and the builders' brief; there was no separate review stop.
Builds on `2026-10-04-azure-insights-design.md` (live) and `2026-10-14-aws-vpn-design.md` (live). Folds in issue #129.

## 1. Intent

When the VPN server runs in AWS, the insight panels show **AWS's figures** instead of "AWS insights are coming soon". AWS data
is collected by the Worker on the existing insights timer and stored in D1. Pages read D1 only and never wait on AWS.
**Nothing changes until Steven changes something:** the panels keep their on/off settings (Azure's ship off), and only warnings
appear unasked.

| Panel (widget id unchanged) | AWS source | Cadence | AWS cost |
|---|---|---|---|
| VM performance (`overview.vmPerformance`) | CloudWatch `GetMetricData`, namespace AWS/EC2 | 15 min, while running | ~1p/day while running |
| Health and power (`overview.azureHealth`, title "Cloud health") | EC2 `DescribeInstanceStatus` | 5 min | free |
| Change log (`activity.azureChanges`, title "Cloud changes") | CloudTrail `LookupEvents` | 5 min | free |
| Boot log (modal) | EC2 `GetConsoleOutput` | after each start + Fetch now | free |
| Service health (`activity.serviceHealth`, top-bar pill, verdict) | public AWS status RSS (EC2, VPC) for the region | 15 min | free |
| Public IP (`firewall.publicIp`) | the instance's packet and byte counters (same CloudWatch call) | 15 min | (in VM performance) |
| Capacity and quota (deploy form warning) | EC2 `DescribeInstanceTypeOfferings`, `DescribeInstanceTypes`, Service Quotas `GetServiceQuota`, `DescribeInstances` | daily | free |
| Price (Settings → Deployment, AWS part) | AWS Price List `GetProducts` (us-east-1), USD → GBP | daily | free |
| System vitals (`overview.vitals`) | the agent heartbeat (already cloud-neutral) | heartbeat | free |

Every AWS panel names its source in its footer ("AWS CloudWatch · 4 min ago", "AWS public status feed", "Server's network
counters").

## 2. Decisions

1. **Free near-equivalents (Steven's choice "A").** Service health uses AWS's public status RSS, not the Health API (which needs
   a paid support plan). Public IP shows the instance's own packet/byte counters; AWS gives no free per-address or DDoS metrics,
   and the panel says so in one line: "AWS has no per-address or DDoS figures without Shield Advanced."
2. **AWS feeds alongside Azure (Steven's choice "approach 1").** New feed modules in `worker/src/insights/aws/`, own `aws_*`
   tables mirroring the `az_*` ones, the same runner and timer. The read layer answers the **same response types** as Azure, so the
   web panels render AWS data unchanged apart from labels. Azure's feeds and tables are not modified.
3. **API addresses stay `/api/v1/azure/*`** (an internal name, like the Worker's). Each response gains `cloud: "azure" | "aws"`;
   the read layer picks the cloud from the snapshot (`cloudOf(snap)`, and for a destroyed server the cloud last deployed).
4. **Which feeds run.** Server feeds (health, metrics, activity, boot log) run for the cloud the server is in, while it exists.
   Cloud-wide feeds (service health, capacity, prices) run for **each** cloud whose login is configured, whatever the server is
   doing, so the deploy form's warning and prices are ready before a deploy.
5. **Metrics every 15 minutes, not 5.** CloudWatch bills per metric requested, not per data point. One call every 15 min fetching
   the last 45 minutes of 5-minute points (overlap re-fills late points) gives the same 5-minute graph at a third of the cost.
6. **Estimates keep the fixed AWS rates.** The AWS list price is shown beside them in Settings for comparison; there is no AWS
   `rate_source` (YAGNI). Azure's price behaviour is unchanged.
7. **Panel titles become cloud-neutral** where they say "Azure" ("Azure health" → "Cloud health", "Azure changes" → "Cloud
   changes"); widget ids stay as they are so saved layouts keep working. Text that is about Azure only (the not-connected line
   for Azure) stays.
8. **Parity with Azure's warnings:** a change to cloudlabs' AWS resources by anyone other than cloudlabs writes one watchman note
   ("Changed in AWS outside cloudlabs: …"); each new AWS scheduled event (from `DescribeInstanceStatus`) writes one watchman note
   and sends one push, exactly as Azure's scheduled events do. cloudlabs never acts on them.

## 3. Architecture

```
insights cron (2,7,…,57) ─► runInsights (runner.ts)
                              ├─ Azure feeds (unchanged)  ─ when Azure is configured; server feeds only if server is Azure
                              └─ AWS feeds (new, aws/*)   ─ when AWS is configured;  server feeds only if server is AWS
                                   each: fetch (signed, via cloud/awsApi.ts) → normalise → store (aws_* tables)
pages ─► /api/v1/azure/* (api/azure.ts) ─► read.ts ─► az_* or aws_* tables, by cloud ─► same response shapes
```

- The runner keeps one shared call budget (`AZ_RUN_BUDGET` = 25, taken from the cron's parent budget). AWS feeds go after Azure's
  in priority order; when the server is in AWS, Azure's server feeds are skipped (as today: status `skipped`, error
  "The server runs in AWS.") and the AWS server feeds run first.
- The headend's instance id is looked up once per run (`DescribeInstances` with `tag:wg-admin-role=headend`, the existing
  `findHeadend` in `cloud/aws.ts`, exported) and shared by the AWS server feeds; 1 call.
- `awsConfigured(env)`: both `AWS_WORKER_ACCESS_KEY_ID` and `AWS_WORKER_SECRET_ACCESS_KEY` set and `config(env).aws.enabled`.
  Without it every AWS feed records `not_configured` and makes no call.

## 4. AWS feeds

All AWS feed ids are prefixed `aws.` in the `aws_feed` table and in diagnostics; the read layer maps them back onto the Azure
`FeedId` they stand in for, so `FeedStatus.id` keeps its type.

| Feed (stands in for) | when | cadence | calls | AWS call(s) | Stores |
|---|---|---|---|---|---|
| `aws.health` (`health`) | server exists | 5 | 1 (+1 shared lookup) | `DescribeInstanceStatus` `IncludeAllInstances=true` | `aws_latest['health']` |
| `aws.metrics` (`vmMetrics` and `pipMetrics`) | running, and 15 min after a stop | 15 | 1 | CloudWatch `GetMetricData` (Query API, Version 2010-08-01) | `hist_aws_vm` |
| `aws.activity` (`activity`) | always (while AWS configured) | 5 | ≤ 3 pages | CloudTrail `LookupEvents`, `ReadOnly=false` | `aws_activity` |
| `aws.serviceHealth` (`serviceHealth`) | always | 15 | 2 | GET `https://status.aws.amazon.com/rss/ec2-<region>.rss` and `vpc-<region>.rss` | `aws_service_events` |
| `aws.capacity` (`capacity`) | always | 1440 | 4 | `DescribeInstanceTypeOfferings`, `DescribeInstanceTypes`, `GetServiceQuota` (ec2, `L-1216C47A`), `DescribeInstances` | `aws_capacity` |
| `aws.prices` (`prices`) | always | 1440 | 3 | Price List `GetProducts` ×3 | `aws_prices` |
| `aws.bootLog` (`bootLog`) | server exists | on demand | 1 | `GetConsoleOutput` `Latest=true` | `aws_latest['bootlog']` |
| `aws.housekeeping` | always | 1440 | 0 | — | prunes `aws_*` like Azure's housekeeping |

There is no AWS `metricDefs` feed: the AWS/EC2 metric names are fixed. Its `FeedStatus` reads `ok` with the AWS catalogue.

### 4.1 Metrics (`aws.metrics`)

One `GetMetricData` call, dimension `InstanceId`, `Period=300`, `StartTime = now − 45 min` (slot-aligned), `EndTime = now`.
Stored in `hist_aws_vm`, one wide row per 5-minute slot (upsert), using **the same column names as `hist_az_vm`** where the
meaning matches, so the reader can serve `VM_COLUMNS` directly:

| Column | AWS metric, stat | Stored as |
|---|---|---|
| `cpu_avg` / `cpu_max` | CPUUtilization, Average / Maximum | % |
| `net_in` / `net_out` | NetworkIn / NetworkOut, Sum | bytes/s (Sum ÷ 300) |
| `disk_read` / `disk_write` | EBSReadBytes / EBSWriteBytes, Sum | bytes/s (Sum ÷ 300) |
| `disk_rops` / `disk_wops` | EBSReadOps / EBSWriteOps, Sum | ops/s (Sum ÷ 300) |
| `credits_min` | CPUCreditBalance, Minimum | credits |
| `credits_used` | CPUCreditUsage, Sum | credits |
| `status_failed` | StatusCheckFailed, Maximum | 0 or 1 |
| `pkts_in` / `pkts_out` | NetworkPacketsIn / NetworkPacketsOut, Sum | packets in the slot |

`mem_free_min`, `avail_avg`, `os_iops_max`, `os_bw_max` do not exist on AWS: the reader returns them as null. Memory comes from
the vitals (as on Azure). The Public IP panel on AWS reads `packets = pkts_in + pkts_out` and `bytes = (net_in + net_out) × 300`
from the same rows; every DDoS column, `syn` and `vip_avail` are null. `shared/azureMetrics.ts` gains an `AWS_METRICS` catalogue
(AWS name, stat, column, title, unit) so the panels' small print shows AWS's metric names on AWS.

### 4.2 Health (`aws.health`)

`DescribeInstanceStatus` for the headend → `AzureHealth`:
- `state`: `Available` when system and instance checks are both `ok`; `Unavailable` when either is `impaired`; `Degraded` when
  either is `initializing` or `insufficient-data`; `Unknown` otherwise (including stopped, where checks are `not-applicable`).
- `title`/`summary`: plain words, e.g. "Both AWS status checks passed." / "AWS's hardware check failed (system status impaired)."
- `power`: "Server running", "Server stopped", "Server starting", "Server stopping" from `instanceState.name`.
- `reason`, `since`, `provisioning`, `vmAgent`: null. `bootDiagnostics`: true (AWS keeps console output for every instance).
- `annotations`: [] on AWS.
- AWS scheduled events (`eventsSet`: `instance-reboot`, `system-reboot`, `system-maintenance`, `instance-retirement`,
  `instance-stop`) are stored in the same doc and served as `maintenance: ScheduledEvent[]` (`type` = the AWS code, `status`
  "Scheduled", `notBefore`, `description`, `source` "AWS", `durationS` from notAfter − notBefore when both exist). Events whose
  description starts with "[Completed]" or "[Canceled]" are dropped.

### 4.3 Change log (`aws.activity`)

`LookupEvents` (JSON 1.1, target `com.amazonaws.cloudtrail.v20131101.CloudTrail_20131101.LookupEvents`), lookup attribute
`ReadOnly=false`, `StartTime` = newest stored `at` − 20 min overlap (7 days ago on the first run),
`MaxResults=50`, at most 3 pages per run. Each event is kept when **any** of:
- its `Username`/`userIdentity` is cloudlabs: the Worker IAM user `wg-admin-worker`, or a session of the GitHub deploy role
  `wg-admin-deploy` (ARN contains `:assumed-role/wg-admin-deploy/`);
- one of its `Resources[].ResourceName` is an id of a resource tagged `wg-admin=vpn` (the run's tagged-resource list, from the
  existing `taggedArns`, 1 call, only when there are new events to check).

Stored per event (`aws_activity`, key = `EventId`): `at` (EventTime), `operation` (EventName, e.g. `AuthorizeSecurityGroupIngress`),
`status` ("Succeeded", or "Failed" when the event's JSON has `errorCode`), `caller` (IAM user name / role session name / service),
`caller_kind` (`wgadmin` as above; `aws` when `userIdentity.type` is `AWSService` or the event has `invokedBy` ending
`amazonaws.com`; otherwise `person`), `resource_type` (plain label, §4.3.1), `resource_name` (the resource id). The panel's note:
"AWS shows changes 5–15 minutes after they happen."

#### 4.3.1 Resource kinds

`shared/azureMetrics.ts` gains `AWS_RESOURCE_KINDS`, using the **same `value` keys** as `AZURE_RESOURCE_KINDS` so the widget's
Types setting works on both clouds: `vm` "EC2 instance" (`AWS::EC2::Instance`), `nsg` "Security group" (`AWS::EC2::SecurityGroup`),
`pip` "Elastic IP" (`AWS::EC2::EIP`), `nic` "Network interface" (`AWS::EC2::NetworkInterface`), `disk` "EBS volume"
(`AWS::EC2::Volume`), `vnet` "VPC" (`AWS::EC2::VPC`, `AWS::EC2::Subnet`, `AWS::EC2::RouteTable`, `AWS::EC2::InternetGateway`),
`rg` none, `other` "Other". The web's Types filter matches a row's label against both lists.

### 4.4 Service health (`aws.serviceHealth`)

Two RSS fetches per run (no auth; `ctx.fetch`). Each `<item>` becomes one `aws_service_events` row: `tracking_id` = guid,
`title`, `summary` = description (tags stripped, ≤ 2 KB), `services` = ["EC2"] or ["VPC"], `regions` = [the region display
name, e.g. "London"], `starts_at` = pubDate, `updated_at` = pubDate, `type` "ServiceIssue" (or "PlannedMaintenance" when the
title starts "Informational message" and mentions maintenance), `status` "Active" when the item is the newest in its feed, is
under 24 hours old and its title does not start with "[RESOLVED]" or contain "operating normally"; otherwise "Resolved".
A feed that answers non-200 or unparsable XML records `error` for the feed and leaves stored rows alone.

### 4.5 Capacity (`aws.capacity`)

For the AWS region and the sizes cloudlabs deploys (`config.aws.instanceType`, and the test VM size `t4g.nano`):
`available` from `DescribeInstanceTypeOfferings` (`LocationType=region`); vCPUs from `DescribeInstanceTypes`; the limit from
Service Quotas `GetServiceQuota` (ServiceCode `ec2`, QuotaCode `L-1216C47A`, "Running On-Demand Standard instances" vCPUs);
`used` = vCPUs of pending/running instances in the region (`DescribeInstances`, `cpuOptions` core × threads). Stored in
`aws_capacity` as a `CapacityDoc`. Served as a `CapacityCheck` (same type, `family.name` "Standard (T family)") in
`OverviewResponse.awsCapacity`; the deploy form shows the warning when AWS is picked and `ok === false`, as it does for Azure.

### 4.6 Prices (`aws.prices`)

`GetProducts` (JSON 1.1, target `AWSPriceListService.GetProducts`, host `api.pricing.us-east-1.amazonaws.com`, region
`us-east-1`), `ServiceCode=AmazonEC2`, filters `TERM_MATCH`:
1. the instance: `instanceType`, `regionCode`, `operatingSystem=Linux`, `tenancy=Shared`, `preInstalledSw=NA`,
   `capacitystatus=Used` → OnDemand USD per hour;
2. gp3 storage: `productFamily=Storage`, `volumeApiName=gp3`, `regionCode` → USD per GB-month (× 8 GB ÷ 730 = per hour);
3. the public IPv4: `productFamily=IP Address`, `regionCode`, `group=VPCPublicIPv4Address` (in-use) → USD per hour.
Converted with `config.aws.usdToGbp` and stored in `aws_prices` (`item` = the instance type, `disk:gp3`, `ip:v4`).
Served as `PriceInfo` with `source: "aws"` (the union gains `"aws"`) in `SettingsResponse.awsPrice`; Settings shows
"AWS list price £x/h running, £y/h stopped" beside the fixed AWS rates, and says how old it is.

### 4.7 Boot log (`aws.bootLog`)

`GetConsoleOutput` with `Latest=true` for the headend; base64 → text; the last 64 KB; redacted with the existing
`insights/redact.ts`; stored as a `BootLogDoc`. Due after each start (the instance's launch time differs from the stored one) and
on `POST /api/v1/azure/bootlog` (one a minute, as on Azure). With no log yet the reason reads "AWS has no console output for this
server yet." Never fetched while AWS is not configured.

## 5. Data model (migration `0024_aws_insights.sql`)

All `WITHOUT ROWID`, ISO UTC times, integer binds `CAST`, none in the R2 backup, wiped by the dev seeder, added to the demo
schema (`worker/src/demo/schema.gen.ts`, regenerated), listed in a new `AWS_TABLES` constant.

- `hist_aws_vm (res, t, cpu_avg, cpu_max, net_in, net_out, disk_read, disk_write, disk_rops, disk_wops, credits_min,
  credits_used, status_failed, pkts_in, pkts_out, PRIMARY KEY (res, t))`
- `aws_feed` — same columns as `az_feed`
- `aws_latest` — same columns as `az_latest`
- `aws_activity (id PK, at, operation, status, caller, caller_kind, resource_type, resource_name)` + index on `at`
- `aws_service_events` — same columns as `az_service_events`
- `aws_capacity` — same columns as `az_capacity`
- `aws_prices` — same columns as `az_prices` (`meter` holds AWS's `usagetype`)

Housekeeping prunes them with Azure's retention (metrics 30 days, activity 90 days, service events 90 days).

## 6. Read layer and API

`read.ts` gains a cloud switch: `readSummary`, `readMetrics`, `readChanges`, `feedStatuses`, the service-health, capacity,
price and bootlog readers take the cloud (from `cloudOf(snap)`; a destroyed server uses the cloud last deployed, falling back
to "azure") and read the matching tables. Response changes in `shared/api.ts` (all additive):

- `AzureSummaryResponse.cloud`, `AzureMetricsResponse.cloud`, `AzureChangesResponse.cloud`, `AzureServiceHealthResponse.cloud`,
  `AzureDiagnosticsResponse.cloud`: `"azure" | "aws"`.
- `AzureSummaryResponse.configured` means "the current cloud's login is configured".
- `AzureSummaryResponse.region.name`: AWS regions read "London" (eu-west-2) etc. via a small `awsRegionName`.
- `latest.memFreeBytes`, `vipAvailPct`, `underDdos` are null on AWS.
- `PriceInfo.source` gains `"aws"`; `SettingsResponse.awsPrice: PriceInfo | null`; `OverviewResponse.awsCapacity: CapacityCheck | null`.
- `GET /api/v1/azure/capacity` and `/price` take an AWS region and size too (`eu-west-2`, `t4g.micro`) and answer from the AWS
  tables.
- `AzureDiagnosticsResponse.feeds` lists the current cloud's feeds.

## 7. Web

- Remove `AWS_SOON_TEXT` and every "AWS insights are coming soon" empty state.
- Panel titles neutral per §2.7. Footers say the source per §1 (`AzureFoot` takes a source label from the feed's cloud).
- Small print metric names come from `AWS_METRICS` on AWS.
- VM performance on AWS hides the Azure-only figures (memory free, availability, disk IOPS/bandwidth %); Health shows the two AWS
  status checks; Public IP shows packets/bytes and the one-line DDoS note; Change log shows the 5–15 minute delay note.
- Not-connected text on AWS: "AWS isn't connected. Add the Worker's AWS keys." Waiting text: "Waiting for the first reading
  from AWS."
- Verdict wording (`shared/verdict.ts`) says "AWS" or "Azure" from `cloud`; the Service Health pill reads "AWS issue in London".
- Deploy form: the capacity warning shows for AWS when `awsCapacity.ok === false`.
- Settings → Deployment: the AWS list price line (§4.6).
- The dev seeder's `insights` story gains an AWS variant (`npm run seed -- insights-aws`) that fills the `aws_*` tables and sets
  the snapshot cloud to aws, so the panels can be checked filled locally.

## 8. IAM (`infra/aws-bootstrap/main.tf`, Worker user policy)

A new statement `Insights`, read-only:
- `cloudwatch:GetMetricData`, `ec2:DescribeInstanceStatus`, `ec2:DescribeInstanceTypeOfferings`, `ec2:DescribeInstanceTypes`,
  `cloudtrail:LookupEvents`, `servicequotas:GetServiceQuota` — `Resource "*"`, condition `aws:RequestedRegion = var.region`;
- `pricing:GetProducts` — `Resource "*"` (us-east-1 only service; no region condition);
- statement `ConsoleOfOurServer`: `ec2:GetConsoleOutput` on `instance/*` with `aws:ResourceTag/wg-admin = vpn`.
Nothing that creates, changes or deletes. Applied with `scripts/aws-bootstrap.mjs` (local admin keys), as in #122.

## 9. Failure isolation

Each AWS feed runs in its own try/catch under the shared budget and the run's soft deadline, as Azure's do.
- `AccessDenied`/`UnauthorizedOperation` → `error`: "AWS refused <Action>: the Worker's AWS user needs <permission>."
- `Throttling`/`RequestLimitExceeded` → `skipped` (still due; next run tries again).
- Network failure or non-200 → `error` with plain words; never a signed URL or key.
- Pages never call AWS, except `POST bootlog` and a capacity cache miss (each its own budget of 2 calls).

## 10. Issue #129 (folded in)

1. `worker/src/budget.ts` (~line 449): when the AWS cost days can't be read, use the AWS **estimate** for the month instead of £0,
   and write the watchman log line "AWS actual cost unreadable (<reason>); using the estimate."
2. `worker/src/api/cost.ts` (~line 307): the AWS "last pulled" date gets a 36-hour expiry wherever it is stored, so the
   Cost page's "as of" date cannot stick to an old pull.
3. Web cost labels (`Tiles.tsx`, `Panels.tsx`): "Azure actual" → "Actual" with the cloud named in the sub-line when only one
   cloud has figures; AWS's date never shows under an Azure label.

## 11. Testing

- Worker unit tests per AWS feed with saved AWS answers (fixtures under `worker/test/fixtures/aws-insights/`, byte-stable by
  `.gitattributes`): metrics XML, DescribeInstanceStatus XML (ok, impaired, stopped, with events), LookupEvents JSON (ours,
  someone else's, AWS service, failed), both RSS feeds (empty, active, resolved), capacity (offered/not, quota near full),
  GetProducts JSON (price parse), console output (base64, secret redacted).
- Runner tests: AWS server → Azure server feeds skipped and AWS server feeds run; Azure server → AWS cloud-wide feeds still run;
  AWS not configured → every AWS feed `not_configured`, no fetch; budget exhaustion; AccessDenied wording; throttling → skipped.
- Read/route tests: every `/azure/*` route on an AWS snapshot answers the AWS tables with `cloud: "aws"`; on an Azure snapshot is
  unchanged (existing tests stay green).
- IAM pin test in `scripts/test/aws-infra.test.mjs`: the new actions are present, `GetConsoleOutput` is tag-scoped, no
  Delete/Create/Modify in the new statements.
- Web tests: the "coming soon" tests become AWS-filled tests for each panel; titles; footers; the deploy-form AWS capacity
  warning; Settings AWS price line; verdict/pill wording.
- #129 tests: cost unreadable → estimate used and log line; last-pulled TTL set; labels.
- **Live test (within the £3 ceiling):** apply the IAM change; deploy on AWS with the test VM off; within 20 minutes every AWS
  panel is filled (health, metrics, change log shows the deploy, service health ok, capacity, price, boot log fetch now); destroy;
  confirm "AWS clean".

## 12. Out of scope

The AWS Health API and Business support; Shield Advanced; per-ENI flow logs; AWS cost Explorer changes beyond #129; AWS labs
(project 3); using the AWS list price for estimates.
