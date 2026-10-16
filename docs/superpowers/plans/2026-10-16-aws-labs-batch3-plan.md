# AWS labs batch 3 (labs 11–19) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The SAA-C03 labs `saa-11-three-tier`, `saa-12-serverless-api`, `saa-13-decoupling`, `saa-14-storage`, `saa-15-data-security`, `saa-16-dr-pilot-light`, `saa-17-data-pipeline`, `saa-18-cost-compute` and `saa-19-eks` run in cloudlabs as batches 1 and 2's do and pass a real-AWS release test with `clean: true`, together with the engine parts they first need: Ireland as the secondary region (lab 16), EKS (lab 19), Spot (lab 18), the data pipeline (lab 17), and API Gateway, Cognito, DynamoDB (with a global table), SQS/SNS/EventBridge/Step Functions, EFS, ElastiCache, Kinesis/Firehose/Glue/Athena, each with its IAM, scope rules, clean-up, Worker reads and diagram kinds.

**Architecture:** Batches 1 and 2's engine is unchanged in shape: lists, rules and handlers grow. The ABAC generator learns three things the real reference forced (API Gateway's HTTP verbs, DynamoDB replicas created without request tags, AMI copies tagged after the call), the role may hold up to 20 managed policies, and a narrow exception lets Unblock delete a load balancer Kubernetes made. `lab-scope-aws.mjs` gains batch 3's types and the rules that keep each new kind of reference (event targets, subscriptions, workflows, private zones, health checks, Lambda sources, endpoint policies, EKS) inside the lab. The safety net and Verify clean gain a handler and a real-state read per new type, find DynamoDB tables, AMIs and Glue databases by name too, and remove a global table's replicas first. Lab 16 is the first two-region lab: an aliased `aws.secondary` provider (eu-west-1), which every pipeline step already iterates; it also lists Route 53 in us-east-1 (`AWS_DNS_LABS`). Each lab is a folder, a learning file, a planned topology, a plan fixture and a test file, in batch 2's lab-task shape.

**Tech Stack:** Terraform 1.14.6 with `hashicorp/aws ~> 6.0` (6.69.0 in the fixtures), `random`, `time`, `archive`; Python 3.13 on arm64 Lambda (labs 12, 13, 17, runs in AWS only); AWS CLI v2 + jq + bash (pipeline scripts); node:test (`scripts/test`); Cloudflare Worker (TypeScript, vitest).

**Spec:** `docs/superpowers/specs/2026-10-15-aws-labs-design.md` (binding, rulings A1–A82; §3–§8, §12.2 rows 11–19, §14 item 3, §15). Section numbers below (§n) are that spec's. Batch 2's plan (`docs/superpowers/plans/2026-10-15-aws-labs-batch2-plan.md`) is the model for each task's shape; its code is on `main` (58b974e).

## Global Constraints

- Steven's standing go (memory `aws-labs-autonomy.md`): plan, build, merge, deploy, bootstrap re-apply, quota requests and real-AWS release tests without stops. STOP only for: a surprise; AWS test spend that would pass **£15 for the whole AWS labs project** (about £0.19 spent so far; batch 3 aims at **≤ £3**); or **any change to the VPN server**: `infra/aws/**`, `infra/main.tf`, `infra/cloud-init.yaml.tftpl`, `.github/workflows/wg.yml`, `.github/workflows/wg-aws.yml`, or the `wg-admin-deploy` role (its policy in `infra/aws-bootstrap/main.tf`). No task in this plan touches any of them; a fix that seems to need one is a STOP, designed around, never made.
- Labs run in **eu-west-2** (London). **eu-west-1** (Ireland) only as lab 16's secondary region (`regions.secondary`, provider alias `secondary`). **us-east-1** only for global APIs (A65): Route 53, signed there by the default provider; lab 16 lists its Route 53 items there (P5). No us-west-2 in batch 3.
- Azure behaviour and batches 1–2's AWS behaviour do not change except where a task names the change. Every existing test stays green unchanged except those this plan names. No existing AWS lab's folder changes, so no soa-* version bump and no soa-* retest.
- An AWS lab owns: everything tagged `cloudlabs-lab = <id>`; IAM roles, instance profiles and customer policies at path `/cloudlabs-lab/` named `lab-<id>-*`; S3 buckets `cloudlabs-<name_prefix>-*`; untaggable types named `lab-<id>-*` (A4); log groups `/cloudlabs/<id>/...` (A56); and, new in batch 3, DynamoDB tables and AMIs named `lab-<id>-*` and Glue databases named `lab_<id with _ for ->` (P3, P4, P15).
- Every `aws` provider block is exactly §4's (the default one in the template's `versions.tf`; lab 16's `secondary` one in `ireland.tf`). Instances as batches 1–2 (AL2023 arm64 from the SSM parameter, IMDSv2, `volume_tags`, no public IPv4, `labadmin` with the session password, console SSH through an Instance Connect Endpoint, a free S3 gateway endpoint). IAM documents with `jsonencode()` only (A42).
- Every batch 3 lab is designed to pass first time under A47–A82: tags at create (A49) and the provider sending them in the create call (checked in the provider source for every new type, 2026-10-16); create-needs-tag ABAC with the exemptions A54, A55 and this plan's P4 only; delete/update verbs never creates (A59); log groups by name with Lambda `logging_config` (A56) and no service-made log groups (P15, P7); service-linked roles made ahead (A57, P10); a 20-second wait before the first tag-checked change on a service not yet proven (A73, P11); AWS authorising an action on resources other than the one named (A82: P3's replicas, P8's load balancers); CloudFormation not used; the scope check failing closed on unknown values without references; a null optional attribute counting as unset.
- Never read or print `.env`. Subagents copy `.env.example` (never the real `.env`) and never use the AWS admin keys; only the controller runs `scripts/aws-bootstrap.mjs`, `npm run labs-verify -- --aws-prices`, read-only AWS checks and real-AWS release tests. Kill processes only by PID. Do not use `python3` on this Windows machine (tests needing Python+PyYAML, bash, jq or terraform skip with a reason when missing; CI has them all).
- Files start with the house header comment (`// path/file` then a `// Plain English: …` paragraph; `#` for shell, HCL, YAML and Python). Match the surrounding comment density and naming.
- Tests while building: only the targeted files (`node --test scripts/test/<file>`, `npx vitest run <files>`), plus `npm run typecheck` when TypeScript changes. The full gate runs once, in Task 16.
- No D1 migration in batch 3.
- Work on branch `feat/aws-labs-batch3` (this plan's branch, from `main` at 58b974e). Commit after each task. Commit messages end with `Claude-Session: https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D`; PR bodies end with `https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D`.

## Plan rulings (copied into spec §17 as A83–A103 in Task 16)

- **P1 (A83). The role may hold 20 managed policies, packed with headroom.** IAM's "Managed policies per role" quota (`L-0DA4ABF3`) is already 20 in this account (read 2026-10-15, batch 2 ledger), so `ROLE_POLICIES_MAX = 20`. Batch 2 left the role at 10 of 10 with several policies within 40 characters of `POLICY_MAX` (6,000; AWS's cap is 6,144 without whitespace), so one more action reshuffled every policy. The packer now fills each policy only to `POLICY_PACK = 5,600` characters (`POLICY_MAX` stays the hard assertion), leaving every policy room for a later statement to grow in place. A test asserts the role holds at most 20 and leaves at least 4 spare. The re-pack changes every role policy's content once (Task 17 reads that plan before applying).
- **P2 (A84). API Gateway's HTTP-verb actions.** The reference names API Gateway's actions `GET`, `POST`, `PUT`, `PATCH` and `DELETE`, each taking the request tag, so batch 2's lists made all four writes creates: any delete or update was refused, and a route (POST on `/apis/<id>/routes`, which carries no tags) could never be made. `abacLists` now treats them by rule (`HTTP_VERB_RULES`): `POST` is a create only on the top-level collections that take tags (`/apis`, `/restapis`, `/vpclinks`, `/domainnames`), refused there without the lab tag; `PUT`, `PATCH` and `DELETE` are changes, refused without `aws:ResourceTag/cloudlabs-lab` (a route, integration or stage is judged by its API's tags, which the reference gives every child type: V, lab 12's release test). So `PATCH /account` (API Gateway's account-wide CloudWatch role) is always refused, and `apigateway:DELETE` joins `KeepLabTag` (it is also the untag call). `GET` is a read. Closes A59's deferral.
- **P3 (A85). DynamoDB tables are the lab's by name as well as by tag.** Adding a global table replica needs `dynamodb:CreateTable`, `CreateTableReplica` and the item writes on the replica table's ARN in the replica region, where the request carries no tags (AWS docs, "DynamoDB global tables security", read 2026-10-16), so `CreateNeedsLabTag` and `ChangeNeedsLabTag` would refuse lab 16's replica. `NAMED_TABLES` (`table/lab-*` and its indexes and streams) joins `TAG_LAG_NAMED` for the change list and a new `NAMED_CREATES` for the create list: dynamodb's create and change actions are refused only outside those names, and there without the tag. The scope check holds every lab table to `lab-<id>-*`; the safety net and Verify clean find tables by that name in each lab region as well as by tag.
- **P4 (A86). AMI copies are exempt from the create-tag rule and owned by name.** The aws provider's `aws_ami_copy` calls `CopyImage` with no `TagSpecifications` and tags the image afterwards (provider source, `ec2_ami_copy.go`, read 2026-10-16), which `CreateNeedsLabTag` refuses on the image and snapshot ARNs. `ec2:CopyImage` joins `CREATE_TAG_EXEMPT` (as A54, A55). A lab's copies are named `lab-<id>-*` (scope rule `untaggable`) and their source is AWS's own AMI from the public SSM parameter (rule `gateway`); the safety net and Verify clean list `ec2 describe-images --owners self` by that name, and deleting an image deletes the snapshots it names (a copy's snapshots carry no tags). Deregistering and deleting snapshots were never tag-checked (`AWS_OWNED_TYPES`), so nothing else changes.
- **P5 (A87). Lab 16 is the first two-region lab, and lists Route 53 in us-east-1.** The secondary provider keeps the spec §4 alias `secondary` (the brief's "aws.ireland" is that alias); `AWS_LAB_REGIONS` already holds eu-west-1, so Parse payload's `LAB_REGIONS`, the ready check, Unblock, the safety net, Verify clean, the Worker's resources panel and live diagram already iterate Ireland. A lab with `regions.secondary` cannot add variable validation (the template's `variables.tf` is copied as written), so the scope check's provider rule (no `secondary` provider unless the plan's `secondary_region` is set and differs) is the guard. Route 53's zones and health checks are listed by the tagging API in us-east-1 only, so a new contract list `AWS_DNS_LABS = ["saa-16-dr-pilot-light"]` adds us-east-1 (never us-west-2) to that lab's `LAB_REGIONS` and to the Worker's reads (`readsUsEast1(id)` = global or DNS lab); lab 16 has no us-east-1 provider and is not a global lab. `AWS_TOPOLOGY_CALLS_MAX` rises 14 → 15 (10 London, 4 Ireland, 1 us-east-1).
- **P6 (A88). Private zones and CloudWatch-alarm health checks stay inside the lab.** A private hosted zone (one with `vpc` blocks) is named `*.internal`, and every `vpc` block names one of the lab's own VPCs by reference in a lab region; a health check of type `CLOUDWATCH_METRIC` names the lab's own alarm by reference in a lab region. Private zones can only fail over on CloudWatch-metric health checks (V, lab 16's release test and Things to try).
- **P7 (A89). Lab 19's EKS.** The cluster uses `authentication_mode = "API"` with `bootstrap_cluster_creator_admin_permissions = false` (the pipeline's role never holds Kubernetes admin), `upgrade_policy { support_type = "STANDARD" }` (extended support bills $0.60 an hour), no control-plane log types (they make an untagged group outside `/cloudlabs/`), a private and a public endpoint (the public one is IAM-authenticated: public by nature, §7.4 gains it); its node group launches from a lab launch template that tags instance, volume and interface at launch, one `t4g.medium` (max 2). The cluster role carries the lab policy `lab-<id>-no-lb` denying `elasticloadbalancing:CreateLoadBalancer` and `ec2:CreateSecurityGroup`, so a Kubernetes `LoadBalancer` service can never make an untagged load balancer (§15); the readme uses port-forward. Terraform has no Kubernetes provider (§4), so Steven gives himself an access entry from CloudShell (the first Connect line: access entries replace `aws-auth`, a Thing to try) and applies the sample deployment with `kubectl` there.
- **P8 (A90). Unblock deletes load balancers Kubernetes made; IAM allows exactly that.** As §15 asks, Unblock deletes every load balancer (ELBv2 and classic) in the lab regions tagged `kubernetes.io/cluster/lab-<id>` while the lab's EKS cluster is tagged for it. `elasticloadbalancing:DeleteLoadBalancer` leaves the change list (`CHANGE_TAG_EXEMPT`) and a fixed deny, `ElbDeleteLabOrEks`, refuses it unless the load balancer carries `cloudlabs-lab` or `kubernetes.io/cluster/lab-saa-19-eks` (both null: refused). The VPN server has no load balancer and `DenyVpnServer` still holds.
- **P9 (A91). Lab 18's Spot.** A mixed-instances Auto Scaling group: one On-Demand `t4g.micro` as base, Spot above it (`on_demand_percentage_above_base_capacity = 0`, `price-capacity-optimized`, capacity rebalancing), from `t4g.micro`, `t4g.small` and an x86 `t3.micro` through a second launch template (AL2023 x86_64 from the public SSM parameter). `wait_for_capacity_timeout = "0"`: a Spot shortfall never fails the apply. The ready check already counts an interrupted (shutting-down or terminated) instance as gone, never failed (a test pins it); Spot requests are never tagged (the launch templates tag instance, volume and interface only), so nothing new is listed. The `spot.amazonaws.com` service-linked role is made ahead (P10). The capacity warning counts all four of lab 18's `instance_types` against the On-Demand quota (it over-warns, never under); reading the Spot quota `L-34B43A08` is carried forward (the AWS feeds' call budget is full).
- **P10 (A92). Batch 3's service-linked roles are made ahead.** `SERVICE_LINKED` gains `spot.amazonaws.com` (lab 18), `replication.dynamodb.amazonaws.com` (lab 16's global table) and `elasticfilesystem.amazonaws.com` (lab 14); EKS's (`eks`, `eks-nodegroup`) and ElastiCache's are already there.
- **P11 (A93). Batch 3's tag waits.** A 20-second `time_sleep` sits between a create and its first tag-checked change on each service not yet proven: Cognito (user pool → client and user), EFS (file system → mount targets), SQS and SNS (queues and topic → queue policies and subscriptions), Lambda (function → `AddPermission`), and the Firehose role (attachment → delivery stream, as lab 04's replication role). No new `CREATE_TAG_EXEMPT` entry for them. If a release test still fails with `AccessDenied` on such a change, Task 17's fallback adds the service to `TAG_LAG_NAMED` with its `lab-*` name pattern (every such batch 3 item is named `lab-<id>-*`).
- **P12 (A94). Lab 12's serverless API.** An HTTP API with a JWT authoriser on the lab's Cognito user pool (issuer and audience by reference), a Lambda integration and three routes (`GET /health` open, `GET /items` and `POST /items` signed in), a `$default` stage throttled to at most 20 burst and 10 per second (rule `size`); a Cognito pool on the free Lite tier (`user_pool_tier = "LITE"`, PLUS refused), deletion protection off, admin-created users only, no hosted domain (none needed: CloudShell signs in with `USER_PASSWORD_AUTH`), one user `labuser` with the session password; DynamoDB on demand (`PAY_PER_REQUEST`; provisioned refused).
- **P13 (A95). A Lambda permission names its source.** `aws_lambda_permission` must carry a `source_arn` built from the lab's own API, rule, topic, bucket or secret by reference (closes batch 2's deferred M-6 for Lambda); lab 07's rotation permission already does.
- **P14 (A96). Event, subscription, workflow and pipeline targets are the lab's own.** An EventBridge target's `arn` names the lab's own topic, queue, function, state machine or stream by reference; an SNS subscription's protocol is `sqs` or `lambda` and its endpoint the lab's own by reference; a Step Functions definition is known at plan and uses only `arn:aws:states:::lambda:invoke`, `sns:publish` and `sqs:sendMessage` on items named `lab-<id>-*` (no `aws-sdk:` integrations); a Firehose source stream, role and bucket, a Glue crawler's S3 path and an Athena workgroup's output location are the lab's own (by reference, or `s3://cloudlabs-<name_prefix>-`). Each role passed (state machine, event target, Firehose, crawler, EKS cluster and nodes, replication) is the lab's own by reference (rule `iam`).
- **P15 (A97). Lab 17's data pipeline.** Glue database `lab_<id with _>` (Glue and Athena take no hyphens), crawler `lab-<id>-events` with no schedule (each run is billed, about 5p: a Thing to try), and a crawler role with no CloudWatch Logs rights, so Glue cannot make its shared, untagged `/aws-glue/crawlers` group (V: the crawler still runs, Task 17); the Athena workgroup `force_destroy = true`, results enforced into the lab's bucket and a 10 MB scan cut-off (rule `size`: set and at most 1 GiB); Firehose error logging off (no service-made log group); one provisioned Kinesis shard (rule `size`, batch 1), `enforce_consumer_deletion = true` (rule `lingering`).
- **P16 (A98). A database is never public.** `aws_db_instance.publicly_accessible = true` is refused (rule `public`; batch 1 Task 2's deferred item).
- **P17 (A99). ElastiCache in lab 11.** One Valkey node (`aws_elasticache_replication_group`, `num_cache_clusters = 1`, `cache.t4g.micro`, encrypted at rest; at most 2 nodes and one node group by rule `size`), no final snapshot (rule `lingering`). The ready check fails at once on `create-failed`, `incompatible-network` or `restore-failed` (batch 1 Task 4's deferred item).
- **P18 (A100). Endpoint policies.** `aws_vpc_endpoint_policy` (lab 15) must be known at plan, name one of the lab's endpoints by reference, and allow (with `Principal "*"`, as endpoint policies do) only the lab's own buckets (`arn:aws:s3:::cloudlabs-<name_prefix>-*`) and Amazon Linux's package repositories (`arn:aws:s3:::al2023-repos-<region>-*`). A bucket policy's condition on the endpoint id cannot be known at plan (P10, A68), so restricting the bucket to the endpoint is lab 15's Thing to try.
- **P19 (A101). Lab 16's pilot light.** London runs the app; Ireland holds data (S3 cross-region replication, a DynamoDB global table replica), an AMI copied from London, a launch template and a standby address, and runs nothing. A private zone answers `app.` with London's address while a CloudWatch-alarm health check is healthy and the standby address otherwise. The DR instance is launched by hand from the Ireland launch template (Things to try); one left running makes the destroy stop on its subnet and the safety net finishes the clean-up (success with fallback, as batch 1's soa-08 did before A82).
- **P20 (A102). Batch 3's diagram kinds.** API Gateway, Cognito, EFS, Glue, Athena and AMIs are `generic` cards (no sprite icon in the AWS pack's subset; adding icons is carried forward); an EventBridge bus is `messaging`; an EKS node group is `aks` beside its cluster; a launch template folds into its Auto Scaling group or EKS node group; a global table's Ireland replica folds into its London table on the live diagram (same name), as A77 folds a stack's items.
- **P21 (A103). New clean-up states.** Verify clean counts a DynamoDB table or a state machine `DELETING` as clean (nothing can stop it, and both finish within minutes), and an EFS file system only when `deleted` or not found; an EKS cluster or node group, a Kinesis or Firehose stream and an ElastiCache group are waited for until not found by the safety net. A Glue crawler that is running is stopped before its delete; a Cognito pool's domain goes first and its deletion protection is turned off by Unblock; a global table's replicas are removed (`update-table --replica-updates Delete`) and waited for before the table.

## Review Focus

1. **A name-owned exception never reaches beyond the lab**: DynamoDB creates and changes without a tag only on `table/lab-*`, `CopyImage` only for a `lab-<id>-*` copy of AWS's own AMI, and a load balancer delete only with `cloudlabs-lab` or lab 19's Kubernetes tag. Tests: Task 2 "Review Focus 1: a replica table named lab-* is allowed untagged in Ireland; another table is refused; P8's load balancers", and Task 3 "Review Focus 1: a DynamoDB table or an AMI copy not named lab-<id>-*, a copy of anything but the public parameter, a misnamed Glue database are refused".
2. **API Gateway can be made, changed and removed by the lab, and nothing else**: a tagged API and its routes are allowed, an untagged API's delete and `PATCH /account` are refused, and removing the lab tag through `DELETE` is refused. Test: Task 2 "ruling P2: API Gateway's verbs: POST is a create on /apis only; PUT, PATCH and DELETE need the lab tag; /account is refused".
3. **Lab 19 can never leave a load balancer or Kubernetes admin behind**: the cluster role's deny, `bootstrap_cluster_creator_admin_permissions = false` enforced at plan, and Unblock deleting `kubernetes.io/cluster/lab-<id>` load balancers (ELBv2 and classic) while never touching another. Tests: Task 3 "Review Focus 3: EKS: refuses creator admin, extended support, control-plane logs, another node size and a node group over 2", Task 4 "Review Focus 3 / P8: Unblock deletes only the load balancers Kubernetes made for this lab's cluster, …", Task 15 "Review Focus 3: saa-19's cluster role cannot make a load balancer, …".
4. **Tear-down of every new type with no Terraform state, in two regions**: a global table's Ireland replica removed before the table, EFS mount targets before the file system, node groups before the cluster, a running crawler stopped, a Cognito domain before its pool, an AMI's snapshots after it. Tests: Task 4 "Review Focus 4 / P21: a global table's replicas go first, then the table; …", "Review Focus 4: EKS node groups, then the cluster, …", "Review Focus 4: EFS mount targets, then the file system; …", "ruling P4: an AMI found by name is deregistered and its snapshots deleted after it" and "batch 3's workloads go by their own handlers: …" (the crawler and the Cognito domain).
5. **Nothing a batch 3 resource points at leaves the lab**: event targets, subscriptions, Step Functions integrations, Lambda sources, private-zone VPCs, health-check alarms, Firehose and crawler paths, endpoint policies and public databases are refused when they name anything not the lab's own. Tests: Task 3 "Review Focus 5 / P14: refuses a target, subscription, workflow, stream or path outside the lab", "ruling P6: refuses a private zone on another VPC or with a real name, and a health check on another alarm", "rulings P16 and P13: refuses a public database and a Lambda permission with no own source; …", "ruling P18: refuses an endpoint policy allowing another bucket; …".

---

## File map

| Path | Status | Task |
|---|---|---|
| `scripts/lib/labs.mjs`, `shared/labs.ts`, `infra/ci/lab-parse.sh`, `infra/ci/lab-scope-aws.mjs` (contract copy only) | modify | 1 |
| `scripts/test/{labs-aws-contract,lab-aws-pipeline,lab-scope-aws}.test.mjs`, `worker/test/labs-shared.test.ts` | modify | 1 |
| `scripts/lib/aws-lab-policies.mjs`, `scripts/lib/aws-bootstrap-labs.mjs`, `infra/aws-bootstrap/{lab-abac,lab-policies}.json` (generated), `scripts/test/aws-labs-iam.test.mjs` | modify | 2 |
| `infra/ci/lab-scope-aws.mjs`, `infra/ci/lab-lint.mjs` | modify | 3 |
| `scripts/test/fixtures/labs/plans/{extract-computed.mjs,computed.json,schema-facts.json}` (regenerated), `scripts/test/{lab-scope-aws,lab-lint}.test.mjs` | modify | 3 |
| `infra/ci/lab-aws-safety-net.sh`, `infra/ci/lab-unblock-aws.sh`, `infra/ci/lab-ready-aws.sh`, `scripts/test/{lab-aws-cleanup,lab-aws-pipeline,aws-labs-iam}.test.mjs` | modify | 4 |
| `worker/src/labs/{awsReads,resources,awsTopology}.ts`, `worker/test/{labs-aws-reads,topology-aws}.test.ts` | modify | 5 |
| `shared/topology/rules/awsPlanned.ts`, `shared/topology/{kinds,awsLive}.ts`, `worker/test/topology-aws.test.ts` | modify | 6 |
| `labs/saa-11-three-tier/**`, `labs/_learning/saa-11-three-tier.yaml`, `shared/topology/planned/saa-11-three-tier.json`, `shared/guides/saa-11-three-tier/**`, `scripts/test/fixtures/labs/plans/labs/saa-11-three-tier.mjs`, `scripts/test/labs-aws-saa-11.test.mjs` | create | 7 |
| the same seven paths for `saa-12-serverless-api` | create | 8 |
| the same seven paths for `saa-13-decoupling` | create | 9 |
| the same seven paths for `saa-14-storage` | create | 10 |
| the same seven paths for `saa-15-data-security` | create | 11 |
| the same seven paths for `saa-16-dr-pilot-light` | create | 12 |
| `scripts/test/fixtures/labs/plans/realistic.mjs` (`providerKey`), `scripts/test/lab-plans.test.mjs` | modify | 12 |
| the same seven paths for `saa-17-data-pipeline` | create | 13 |
| the same seven paths for `saa-18-cost-compute` | create | 14 |
| the same seven paths for `saa-19-eks` | create | 15 |
| `shared/guides/{index,placement}.json`, `worker/test/topology-golden.test.ts`, `worker/test/fixtures/topology/round-trip.ts` | modify | 7–15 |
| `docs/superpowers/specs/2026-10-15-aws-labs-design.md` (§17 A83–A103; §7.4 public-by-nature list gains the EKS API endpoint) | modify | 16 |
| `docs/labs/release-tests.md`, `scripts/test/fixtures/labs/plans/shapes/saa-*.json`, the labs' plan fixtures | modify | 17 |

## Order and dependencies

Tasks run one at a time, in number order. Engine tasks (1–6) come before the labs that need them (7–15).

| Task | Title | Depends on |
|---|---|---|
| 1 | Contract: `AWS_DNS_LABS`, us-east-1 in a DNS lab's regions | – |
| 2 | ABAC and IAM: 20 policies with headroom, API Gateway's verbs, DynamoDB by name, AMI copies, EKS load balancers, service-linked roles, simulator and evaluator cases | – |
| 3 | Lint and scope: batch 3's types and rules | 1 |
| 4 | Unblock, safety net, Verify clean and ready check for batch 3's types | 2 |
| 5 | Worker: API Gateway ARNs, us-east-1 reads for DNS labs, a two-region diagram's budget | 1 |
| 6 | Topology: batch 3's types on the planned and live diagrams | – |
| 7 | Lab saa-11-three-tier | 3, 4, 6 |
| 8 | Lab saa-12-serverless-api | 2, 3, 4, 5, 6 |
| 9 | Lab saa-13-decoupling | 3, 4, 6 |
| 10 | Lab saa-14-storage | 2, 3, 4, 6 |
| 11 | Lab saa-15-data-security | 3, 6 |
| 12 | Lab saa-16-dr-pilot-light | 1, 2, 3, 4, 5, 6 |
| 13 | Lab saa-17-data-pipeline | 3, 4, 6 |
| 14 | Lab saa-18-cost-compute | 2, 3, 4, 6 |
| 15 | Lab saa-19-eks | 2, 3, 4, 6 |
| 16 | Full gate, price and link checks, V answers, spec rulings, PR and whole-branch review (controller) | 1–15 |
| 17 | Ship: spend check, bootstrap preview then apply, merge, deploy, release tests 11–19, record, recalibrate (controller) | 16 |

---
### Task 1: Contract: `AWS_DNS_LABS`, us-east-1 in a DNS lab's regions

Spec: §3.2 (regions), §5 step 1 (Parse payload), §6 (contract, its copies), §8.2 (the regions the safety net lists); ruling P5.

**Files:**
- Modify: `scripts/lib/labs.mjs` and `shared/labs.ts` (`AWS_DNS_LABS`, `readsUsEast1`), `infra/ci/lab-parse.sh` (`AWS_DNS_LABS` tuple; `LAB_REGIONS`), `infra/ci/lab-scope-aws.mjs` (the contract copy of `AWS_DNS_LABS` only; Task 3 uses it)
- Test: `scripts/test/labs-aws-contract.test.mjs`, `scripts/test/lab-aws-pipeline.test.mjs`, `scripts/test/lab-scope-aws.test.mjs` (the constants test), `worker/test/labs-shared.test.ts`

**Interfaces:**
- Produces: `AWS_DNS_LABS: readonly string[]` and `readsUsEast1(id: string): boolean` in `shared/labs.ts` and `scripts/lib/labs.mjs` (Task 5 calls `readsUsEast1`); `LAB_REGIONS` for `saa-16-dr-pilot-light` is `eu-west-2 eu-west-1 us-east-1` (Tasks 4 and 12 rely on it).

**`scripts/lib/labs.mjs`**, after `AWS_GLOBAL_LABS`:
```js
/**
 * Ruling P5: labs outside AWS_GLOBAL_LABS with Route 53 zones or health checks. The tagging API lists Route 53 items
 * in us-east-1 only, so Parse payload adds us-east-1 (never us-west-2) to their LAB_REGIONS and the Worker reads it.
 */
export const AWS_DNS_LABS = ["saa-16-dr-pilot-light"];
/** Whether an AWS lab has items the tagging API lists only in us-east-1 (a global lab's, or a DNS lab's Route 53). */
export const readsUsEast1 = (id) => AWS_GLOBAL_LABS.includes(id) || AWS_DNS_LABS.includes(id);
```
**`shared/labs.ts`**, after `AWS_GLOBAL_LABS` (same comments):
```ts
export const AWS_DNS_LABS: readonly string[] = ["saa-16-dr-pilot-light"];
export const readsUsEast1 = (id: string): boolean => AWS_GLOBAL_LABS.includes(id) || AWS_DNS_LABS.includes(id);
```
**`infra/ci/lab-scope-aws.mjs`**, after its `AWS_GLOBAL_LABS` copy:
```js
/** Ruling P5: labs with Route 53 items listed in us-east-1 that are not global labs (a copy of the contract's). */
export const AWS_DNS_LABS = ["saa-16-dr-pilot-light"];
```
**`infra/ci/lab-parse.sh`**: below `AWS_GLOBAL_LABS = (...)`:
```python
AWS_DNS_LABS = ("saa-16-dr-pilot-light",)
```
and the `LAB_REGIONS` line becomes (the comment above it gains "a DNS lab's Route 53 in us-east-1 (ruling P5)"):
```python
        "LAB_REGIONS": " ".join(["eu-west-2", "eu-west-1"] + (["us-east-1", "us-west-2"] if lab_id in AWS_GLOBAL_LABS else ["us-east-1"] if lab_id in AWS_DNS_LABS else [])),
```

- [ ] **Step 1: Write the failing tests.**

`scripts/test/labs-aws-contract.test.mjs` (import `AWS_DNS_LABS` and `readsUsEast1` with the other `labs.mjs` names):
```js
test("lab-parse.sh's AWS_DNS_LABS equals the contract's (ruling P5)", () => {
  const sh = readFileSync(new URL("../../infra/ci/lab-parse.sh", import.meta.url), "utf8");
  const m = /^AWS_DNS_LABS = \(([^)]*)\)$/m.exec(sh);
  assert.ok(m, "lab-parse.sh has an AWS_DNS_LABS tuple");
  assert.deepEqual([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]), AWS_DNS_LABS);
});

test("ruling P5: a global or DNS lab reads us-east-1; no other lab does", () => {
  assert.deepEqual(["soa-09-route53-cloudfront", "saa-16-dr-pilot-light", "soa-05-rds", "saa-19-eks"].map(readsUsEast1), [true, true, false, false]);
  assert.ok(!AWS_DNS_LABS.some((id) => AWS_GLOBAL_LABS.includes(id)), "a DNS lab is never also a global lab");
});
```
`scripts/test/lab-aws-pipeline.test.mjs`, beside the global-lab test:
```js
test("ruling P5: a DNS lab's regions add us-east-1 only (Route 53 is listed there); its secondary is Ireland", () => {
  const d = { ...LAB, id: "saa-16-dr-pilot-light", version: 1 };
  const r = parseRun("aws", { ...PAYLOAD, lab_id: d.id, version: 1, name_prefix: "a16k3x9q", secondary_region: "eu-west-1" }, d);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.env.LAB_REGIONS, "eu-west-2 eu-west-1 us-east-1");
  assert.equal(r.env.TF_VAR_secondary_region, "eu-west-1");
});
```
`scripts/test/lab-scope-aws.test.mjs`, "the constants equal the contract's copies": import `AWS_DNS_LABS` from `../lib/labs.mjs` and add `[scope.AWS_DNS_LABS, AWS_DNS_LABS]` to the pairs.
`worker/test/labs-shared.test.ts`: import `AWS_DNS_LABS` and add `expect([...scripts.AWS_DNS_LABS]).toEqual([...AWS_DNS_LABS]);` after the `AWS_GLOBAL_LABS` line.

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test scripts/test/labs-aws-contract.test.mjs scripts/test/lab-aws-pipeline.test.mjs scripts/test/lab-scope-aws.test.mjs` and `npx vitest run worker/test/labs-shared.test.ts`
Expected: FAIL (no `AWS_DNS_LABS`; `LAB_REGIONS` is `eu-west-2 eu-west-1` for lab 16). The pipeline tests skip without bash/Python (CI runs them).

- [ ] **Step 3: Write the changes** above.

- [ ] **Step 4: Run the targeted tests**

Run: the Step 2 commands, then `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/labs.mjs shared/labs.ts infra/ci/lab-parse.sh infra/ci/lab-scope-aws.mjs scripts/test/labs-aws-contract.test.mjs scripts/test/lab-aws-pipeline.test.mjs scripts/test/lab-scope-aws.test.mjs worker/test/labs-shared.test.ts
git commit -m "feat(aws labs): AWS_DNS_LABS: a lab with Route 53 items lists us-east-1 too

Claude-Session: https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D"
```

---

### Task 2: ABAC and IAM: 20 policies with headroom, API Gateway's verbs, DynamoDB by name, AMI copies, EKS load balancers, service-linked roles, simulator and evaluator cases

Spec: §7.1 (create and change lists, `ServiceLinkedRoles`, `KeepLabTag`), §15 (ABAC gaps, EKS-made resources), rulings A19, A29, A46, A54, A56, A57, A59, A71, A82, P1–P4, P8, P10.

**Files:**
- Modify: `scripts/lib/aws-lab-policies.mjs` (`ROLE_POLICIES_MAX`, `POLICY_PACK`, `HTTP_VERB_RULES` in `abacLists`, `NAMED_TABLES`, `TAG_LAG_NAMED.dynamodb`, `NAMED_CREATES` in `roleItems`, `CREATE_TAG_EXEMPT`, `CHANGE_TAG_EXEMPT`, `EKS_LB_TAG` and the fixed deny `ElbDeleteLabOrEks`, `SERVICE_LINKED`; header)
- Modify: `scripts/lib/aws-bootstrap-labs.mjs` (eleven simulator cases)
- Regenerate: `infra/aws-bootstrap/lab-abac.json` (`node scripts/aws-labs-abac.mjs`, network, no credentials), `infra/aws-bootstrap/lab-policies.json` (`--render`)
- Test: `scripts/test/aws-labs-iam.test.mjs`

**Interfaces:**
- Produces (aws-lab-policies.mjs): `export const POLICY_PACK = 5600`, `export const HTTP_VERB_RULES`, `export const NAMED_TABLES`, `export const NAMED_CREATES`, `export const EKS_LB_TAG = "kubernetes.io/cluster/lab-saa-19-eks"`; `ROLE_POLICIES_MAX` is 20. Task 4's clean-up calls rely on the regenerated policies (the CLI-coverage test proves it); Tasks 8, 12, 15 rely on P2, P3/P4 and P8.

**`scripts/lib/aws-lab-policies.mjs`.** The header's size paragraph gains: "Each policy is filled only to POLICY_PACK (5,600), so a statement can grow without moving the others, and the role may hold 20 (ruling P1: IAM's L-0DA4ABF3 is 20 in this account)." The ABAC paragraph gains: "API Gateway's HTTP-verb actions are judged by HTTP_VERB_RULES (ruling P2); DynamoDB's creates and changes are refused only outside the lab's own table names (ruling P3)."

```js
export const ROLE_POLICIES_MAX = 20;
/** Ruling P1: how full the packer makes each policy (POLICY_MAX is still the hard check): room for a statement to grow. */
export const POLICY_PACK = 5600;
```
and `fits` becomes `const fits = (statements) => policySize(docOf(statements), PACK_FILL) < POLICY_PACK;`.

```js
/**
 * Ruling P2 (A84): API Gateway names its write actions after HTTP verbs, each taking the request tag. POST is a create
 * only on the top-level collections that take tags (refused there without the lab tag); a route, integration or stage
 * POST carries no tags and is judged by nothing. PUT, PATCH and DELETE are changes (the reference gives every child
 * type its API's aws:ResourceTag), so PATCH /account, API Gateway's account-wide setting, is always refused. DELETE is
 * also how a tag is removed, so it joins the untag list (KeepLabTag). GET is a read.
 */
export const HTTP_VERB_RULES = {
  apigateway: { postCreatesOn: ["/apis", "/restapis", "/vpclinks", "/domainnames"].map((p) => `arn:aws:apigateway:*::${p}`), changes: ["PUT", "PATCH", "DELETE"], untag: "DELETE" },
};
/**
 * Ruling P3 (A85): DynamoDB tables a lab owns by name. A global table's replica is made in its region by the caller's
 * CreateTable and CreateTableReplica on the replica's ARN, with no request tag, and its item writes follow before its
 * tags arrive (AWS docs, read 2026-10-16). The VPN server has no tables.
 */
export const NAMED_TABLES = ["arn:aws:dynamodb:*:*:table/lab-*", "arn:aws:dynamodb:*:*:table/lab-*/*"];
/** Ruling P3: services whose create-list actions are refused only outside these names, and there without the tag. */
export const NAMED_CREATES = { dynamodb: NAMED_TABLES };
```
`TAG_LAG_NAMED` becomes `{ logs: ["arn:aws:logs:*:*:log-group:/cloudlabs/*"], dynamodb: NAMED_TABLES }` (its comment gains "and DynamoDB, whose replicas are made untagged (ruling P3)").

```js
// Ruling P4 (A86): the provider's aws_ami_copy calls CopyImage with no TagSpecifications and tags the image after; a
// lab's copies are named lab-<id>-* (lab-scope-aws.mjs) and found by that name.
export const CREATE_TAG_EXEMPT = ["ec2:CreateNetworkInterface", "ssm:CreateAssociation", "ssm:CreateAssociationBatch", "ec2:CopyImage"];
// Ruling P8 (A90): a load balancer Kubernetes made carries its cluster's tag, not the lab's; ElbDeleteLabOrEks judges it.
export const CHANGE_TAG_EXEMPT = ["ec2:ReplaceNetworkAclAssociation", "elasticloadbalancing:DeleteLoadBalancer"];
/** Ruling P8: the tag Kubernetes gives what lab 19's cluster makes (its cluster is lab-<id>, ruling P7). */
export const EKS_LB_TAG = "kubernetes.io/cluster/lab-saa-19-eks";
```
`SERVICE_LINKED` gains, at the end, `"spot", "replication.dynamodb", "elasticfilesystem"` (ruling P10).

In `abacLists`, inside the action loop, directly after the `CREATE_TAG_EXEMPT`/`CHANGE_TAG_EXEMPT` `continue` and before `isAccountSetting`:
```js
      // Ruling P2: HTTP-verb actions by rule, never by their keys.
      const verbs = HTTP_VERB_RULES[service];
      if (verbs && /^(GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE)$/.test(a.Name)) {
        if (a.Name === "POST") {
          createOn[name] = verbs.postCreatesOn;
          create.push(name);
        } else if (verbs.changes.includes(a.Name)) changes.push(name);
        if (a.Name === verbs.untag) untags.push(name);
        continue;
      }
```
(`create.push` bypasses `foldWildcards`, as `ec2:RunInstances` does; an all-capital name never folds.)

In `roleItems`, the "requested on the action" block becomes:
```js
  // Requested on the action: refused on any resource; for NAMED_CREATES' services (ruling P3), outside their names.
  const named = (a) => Object.hasOwn(NAMED_CREATES, a.split(":")[0]);
  const anywhere = abac.create.filter((a) => !createOn[a] && !named(a));
  items.push({ list: anywhere, ...creates, make: (Action, Sid) => deny(Sid, Action, "*", noRequestTag) });
  for (const [service, names] of Object.entries(NAMED_CREATES)) {
    const list = abac.create.filter((a) => a.split(":")[0] === service && !createOn[a]);
    if (list.length) items.push({ list, ...creates, make: (Action, Sid) => ({ Sid, Effect: "Deny", Action, NotResource: names, Condition: noRequestTag }) });
  }
```
In `fixedStatements`, after `...VPC_FABRIC_GUARDS,`:
```js
    // Ruling P8: a load balancer is deleted only when it carries the lab tag or lab 19's Kubernetes cluster tag.
    deny("ElbDeleteLabOrEks", "elasticloadbalancing:DeleteLoadBalancer", "*", { Null: { [`aws:ResourceTag/${LAB_TAG}`]: "true", [`aws:ResourceTag/${EKS_LB_TAG}`]: "true" } }),
```

**`scripts/lib/aws-bootstrap-labs.mjs`**, `simulatorCases`, after the batch 2 cases and before `...defaultVpcCase(...)`:
```js
    // Batch 3 (labs 11–19).
    { name: "a global table's replica in Ireland", action: "dynamodb:CreateTable", resource: `arn:aws:dynamodb:eu-west-1:${account}:table/lab-saa-16-dr-pilot-light-orders`, context: [ctx("aws:RequestedRegion", ["eu-west-1"])], want: "allowed" },
    { name: "an untagged table not named for a lab", action: "dynamodb:CreateTable", resource: `arn:aws:dynamodb:eu-west-2:${account}:table/orders`, context: [region], want: "denied" },
    { name: "copy an AMI to Ireland", action: "ec2:CopyImage", resource: "arn:aws:ec2:eu-west-1::image/*", context: [ctx("aws:RequestedRegion", ["eu-west-1"])], want: "allowed" },
    { name: "a tagged HTTP API", action: "apigateway:POST", resource: "arn:aws:apigateway:eu-west-2::/apis", context: [region, ...labTag], want: "allowed" },
    { name: "an untagged HTTP API", action: "apigateway:POST", resource: "arn:aws:apigateway:eu-west-2::/apis", context: [region], want: "denied" },
    { name: "a route on a lab API", action: "apigateway:POST", resource: "arn:aws:apigateway:eu-west-2::/apis/a1b2c3d4e5/routes", context: [region], want: "allowed" },
    { name: "delete an untagged API", action: "apigateway:DELETE", resource: "arn:aws:apigateway:eu-west-2::/apis/a1b2c3d4e5", context: [region], want: "denied" },
    { name: "API Gateway's account settings", action: "apigateway:PATCH", resource: "arn:aws:apigateway:eu-west-2::/account", context: [region], want: "denied" },
    { name: "delete a load balancer Kubernetes made for lab 19", action: "elasticloadbalancing:DeleteLoadBalancer", resource: `arn:aws:elasticloadbalancing:eu-west-2:${account}:loadbalancer/a1b2c3d4e5f6`, context: [region, ctx("aws:ResourceTag/kubernetes.io/cluster/lab-saa-19-eks", ["owned"])], want: "allowed" },
    { name: "delete an untagged load balancer", action: "elasticloadbalancing:DeleteLoadBalancer", resource: `arn:aws:elasticloadbalancing:eu-west-2:${account}:loadbalancer/app/other/0123456789abcdef`, context: [region], want: "denied" },
    { name: "the Spot service-linked role", action: "iam:CreateServiceLinkedRole", resource: `arn:aws:iam::${account}:role/aws-service-role/spot.amazonaws.com/AWSServiceRoleForEC2Spot`, context: [ctx("iam:AWSServiceName", ["spot.amazonaws.com"])], want: "allowed" },
```

- [ ] **Step 1: Write the failing tests** in `scripts/test/aws-labs-iam.test.mjs`. Import `POLICY_PACK`, `HTTP_VERB_RULES`, `NAMED_TABLES`, `EKS_LB_TAG` and `CREATE_TAG_EXEMPT` with the other `aws-lab-policies.mjs` names. Add:

```js
test("ruling P2: API Gateway's verbs: POST is a create on /apis only; PUT, PATCH and DELETE need the lab tag; /account is refused", () => {
  const verb = (Name) => ({ Name, ActionConditionKeys: ["aws:RequestTag/${TagKey}", "aws:TagKeys"], Resources: [{ Name: "Api" }, { Name: "Apis" }, { Name: "Account" }], Annotations: { Properties: { IsWrite: Name !== "GET" } } });
  const sar = {
    apigateway: {
      Name: "apigateway",
      Resources: [
        { Name: "Api", ARNFormats: ["arn:${Partition}:apigateway:${Region}::/apis/${ApiId}"], ConditionKeys: ["aws:ResourceTag/${TagKey}"] },
        { Name: "Apis", ARNFormats: ["arn:${Partition}:apigateway:${Region}::/apis"], ConditionKeys: ["aws:ResourceTag/${TagKey}"] },
        { Name: "Account", ARNFormats: ["arn:${Partition}:apigateway:${Region}::/account"], ConditionKeys: [] },
      ],
      Actions: ["GET", "POST", "PUT", "PATCH", "DELETE"].map(verb),
    },
  };
  const { create, change, createOn, untag } = abacLists(sar);
  assert.deepEqual(create, ["apigateway:POST"]);
  assert.deepEqual(createOn["apigateway:POST"], HTTP_VERB_RULES.apigateway.postCreatesOn);
  assert.deepEqual(change, ["apigateway:DELETE", "apigateway:PATCH", "apigateway:PUT"]);
  assert.ok(untag.includes("apigateway:DELETE"));
  const { role } = renderLabPolicies({ services: ["apigateway"], create, change, createOn, untag });
  const d = (action, resource, ctx) => decide(role, { action, resource, ctx });
  const R = { "aws:RequestedRegion": "eu-west-2" };
  assert.equal(d("apigateway:POST", "arn:aws:apigateway:eu-west-2::/apis", { ...R, "aws:RequestTag/cloudlabs-lab": "saa-12-x" }), "allowed");
  assert.equal(d("apigateway:POST", "arn:aws:apigateway:eu-west-2::/apis", R), "explicitDeny");
  assert.equal(d("apigateway:POST", "arn:aws:apigateway:eu-west-2::/apis/a1/routes", R), "allowed");
  assert.equal(d("apigateway:DELETE", "arn:aws:apigateway:eu-west-2::/apis/a1", { ...R, "aws:ResourceTag/cloudlabs-lab": "saa-12-x" }), "allowed");
  assert.equal(d("apigateway:DELETE", "arn:aws:apigateway:eu-west-2::/apis/a1", R), "explicitDeny");
  assert.equal(d("apigateway:PATCH", "arn:aws:apigateway:eu-west-2::/account", R), "explicitDeny");
  assert.equal(d("apigateway:DELETE", "arn:aws:apigateway:eu-west-2::/tags/x", { ...R, "aws:ResourceTag/cloudlabs-lab": "saa-12-x", "aws:TagKeys": ["cloudlabs-lab"] }), "explicitDeny", "never untag the lab tag");
});

test("rulings P3 and P4: DynamoDB is refused only outside table/lab-*; CopyImage is exempt; both lists say so", { skip }, () => {
  const { ABAC, POLICIES } = files();
  assert.ok(!ABAC.create.some((a) => /^ec2:Copy(Image|\*)/.test(a)), "CopyImage is in no create list (ruling P4)");
  assert.ok(ABAC.create.includes("dynamodb:CreateTable"));
  const st = POLICIES.role.flatMap((d) => d.Statement);
  const dyn = st.filter((s) => s.Effect === "Deny" && [].concat(s.Action ?? []).some((a) => a.startsWith("dynamodb:")) && /NeedsLabTag/.test(s.Sid));
  assert.ok(dyn.length >= 2 && dyn.every((s) => JSON.stringify(s.NotResource) === JSON.stringify(NAMED_TABLES)), JSON.stringify(dyn.map((s) => s.Sid)));
  assert.ok(CREATE_TAG_EXEMPT.includes("ec2:CopyImage"));
});

test("Review Focus 1: a replica table named lab-* is allowed untagged in Ireland; another table is refused; P8's load balancers", { skip }, () => {
  const { POLICIES } = files();
  const d = (action, resource, ctx) => decide(POLICIES.role, { action, resource, ctx });
  const IE = { "aws:RequestedRegion": "eu-west-1" };
  for (const a of ["dynamodb:CreateTable", "dynamodb:CreateTableReplica", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem"]) assert.equal(d(a, `arn:aws:dynamodb:eu-west-1:${A}:table/lab-saa-16-dr-pilot-light-orders`, IE), "allowed", a);
  assert.notEqual(d("dynamodb:CreateTable", `arn:aws:dynamodb:eu-west-1:${A}:table/orders`, IE), "allowed");
  assert.notEqual(d("dynamodb:DeleteTable", `arn:aws:dynamodb:eu-west-2:${A}:table/orders`, { "aws:RequestedRegion": "eu-west-2" }), "allowed");
  assert.equal(d("dynamodb:CreateTable", `arn:aws:dynamodb:eu-west-2:${A}:table/orders`, NEW), "allowed", "a tagged table of any name");
  assert.equal(d("ec2:CopyImage", "arn:aws:ec2:eu-west-1::image/*", IE), "allowed");
  assert.equal(d("ec2:CopyImage", "arn:aws:ec2:us-east-2::image/*", { "aws:RequestedRegion": "us-east-2" }), "explicitDeny", "never a third region");
  const lb = `arn:aws:elasticloadbalancing:eu-west-2:${A}:loadbalancer/a1b2c3`;
  const R = { "aws:RequestedRegion": "eu-west-2" };
  assert.equal(d("elasticloadbalancing:DeleteLoadBalancer", lb, { ...R, [`aws:ResourceTag/${EKS_LB_TAG}`]: "owned" }), "allowed");
  assert.equal(d("elasticloadbalancing:DeleteLoadBalancer", lb, LAB), "allowed");
  assert.equal(d("elasticloadbalancing:DeleteLoadBalancer", lb, { ...R, "aws:ResourceTag/kubernetes.io/cluster/someone-else": "owned" }), "explicitDeny");
  assert.equal(d("elasticloadbalancing:DeleteLoadBalancer", lb, R), "explicitDeny");
  assert.equal(d("elasticloadbalancing:DeleteLoadBalancer", lb, { ...R, "aws:ResourceTag/wg-admin": "vpn", [`aws:ResourceTag/${EKS_LB_TAG}`]: "owned" }), "explicitDeny", "never the VPN server's");
});

test("ruling P1: 20 policies at most, at least 4 spare, each packed under POLICY_PACK", { skip }, () => {
  const { POLICIES } = files();
  assert.equal(ROLE_POLICIES_MAX, 20);
  assert.ok(POLICIES.role.length <= ROLE_POLICIES_MAX - 4, `${POLICIES.role.length} role policies`);
  for (const [i, d] of POLICIES.role.entries()) assert.ok(policySize(d, FILL) < POLICY_PACK, `role policy ${i + 1}: ${policySize(d, FILL)}`);
});

test("what labs 11–19 do is allowed: tagged creates, their changes, the roles they pass, the service-linked roles they need", { skip }, () => {
  const { POLICIES } = files();
  const allowed = (action, resource, ctx) => assert.equal(decide(POLICIES.role, { action, resource, ctx }), "allowed", `${action} on ${resource}`);
  const arn = (svc, rest, region = "eu-west-2") => `arn:aws:${svc}:${region}:${A}:${rest}`;
  const pass = (name, svc) => allowed("iam:PassRole", `arn:aws:iam::${A}:role/cloudlabs-lab/${name}`, { "iam:PassedToService": `${svc}.amazonaws.com` });
  // Lab 11: ElastiCache.
  allowed("elasticache:CreateReplicationGroup", arn("elasticache", "replicationgroup:ca11k3x9q"), NEW);
  allowed("elasticache:CreateCacheSubnetGroup", arn("elasticache", "subnetgroup:lab-saa-11-three-tier-cache"), NEW);
  allowed("elasticache:DeleteReplicationGroup", arn("elasticache", "replicationgroup:ca11k3x9q"), LAB);
  // Lab 12: Cognito, DynamoDB, the API's integration permission.
  allowed("cognito-idp:CreateUserPool", "*", NEW);
  for (const a of ["cognito-idp:CreateUserPoolClient", "cognito-idp:AdminCreateUser", "cognito-idp:AdminSetUserPassword", "cognito-idp:DeleteUserPool"]) allowed(a, arn("cognito-idp", "userpool/eu-west-2_AbCdEf"), LAB);
  allowed("dynamodb:CreateTable", arn("dynamodb", "table/lab-saa-12-serverless-api-items"), NEW);
  // Lab 13: queues, topic, bus, state machine, the roles they pass.
  for (const [a, r] of [["sqs:CreateQueue", "lab-saa-13-decoupling-billing"], ["sns:CreateTopic", "lab-saa-13-decoupling-orders"], ["events:CreateEventBus", "event-bus/lab-saa-13-decoupling-bus"], ["states:CreateStateMachine", "stateMachine:lab-saa-13-decoupling-orders"]]) allowed(a, arn(a.split(":")[0], r), NEW);
  for (const [a, r] of [["sqs:SetQueueAttributes", "lab-saa-13-decoupling-billing"], ["sns:Subscribe", "lab-saa-13-decoupling-orders"], ["events:PutTargets", "rule/lab-saa-13-decoupling-bus/lab-saa-13-decoupling-placed"], ["states:DeleteStateMachine", "stateMachine:lab-saa-13-decoupling-orders"]]) allowed(a, arn(a.split(":")[0], r), LAB);
  pass("lab-saa-13-decoupling-sfn", "states");
  pass("lab-saa-13-decoupling-events", "events");
  // Lab 14: EFS and its mount targets; the service-linked role.
  allowed("elasticfilesystem:CreateFileSystem", arn("elasticfilesystem", "file-system/*"), NEW);
  allowed("elasticfilesystem:CreateMountTarget", arn("elasticfilesystem", "file-system/fs-0abc"), LAB);
  allowed("iam:CreateServiceLinkedRole", `arn:aws:iam::${A}:role/aws-service-role/elasticfilesystem.amazonaws.com/AWSServiceRoleForAmazonElasticFileSystem`, { "iam:AWSServiceName": "elasticfilesystem.amazonaws.com" });
  // Lab 16: Ireland, the replication role, the DynamoDB replication service-linked role, Route 53 in us-east-1.
  allowed("ec2:CreateVpc", arn("ec2", "vpc/*", "eu-west-1"), { ...NEW, "aws:RequestedRegion": "eu-west-1" });
  pass("lab-saa-16-dr-pilot-light-replication", "s3");
  allowed("iam:CreateServiceLinkedRole", `arn:aws:iam::${A}:role/aws-service-role/replication.dynamodb.amazonaws.com/AWSServiceRoleForDynamoDBReplication`, { "iam:AWSServiceName": "replication.dynamodb.amazonaws.com" });
  for (const a of ["route53:CreateHostedZone", "route53:AssociateVPCWithHostedZone", "route53:CreateHealthCheck"]) allowed(a, "*", { "aws:RequestedRegion": "us-east-1" });
  // Lab 17: Kinesis, Firehose, Glue, Athena.
  for (const [a, r] of [["kinesis:CreateStream", "stream/lab-saa-17-data-pipeline-events"], ["firehose:CreateDeliveryStream", "deliverystream/lab-saa-17-data-pipeline-to-s3"], ["glue:CreateDatabase", "database/lab_saa_17_data_pipeline"], ["glue:CreateCrawler", "crawler/lab-saa-17-data-pipeline-events"], ["athena:CreateWorkGroup", "workgroup/lab-saa-17-data-pipeline-wg"]]) allowed(a, arn(a.split(":")[0], r), NEW);
  for (const [a, r] of [["kinesis:DeleteStream", "stream/lab-saa-17-data-pipeline-events"], ["glue:DeleteCrawler", "crawler/lab-saa-17-data-pipeline-events"], ["athena:DeleteWorkGroup", "workgroup/lab-saa-17-data-pipeline-wg"]]) allowed(a, arn(a.split(":")[0], r), LAB);
  allowed("glue:DeleteDatabase", arn("glue", "database/lab_saa_17_data_pipeline"), { "aws:RequestedRegion": "eu-west-2" });
  pass("lab-saa-17-data-pipeline-firehose", "firehose");
  pass("lab-saa-17-data-pipeline-crawler", "glue");
  // Lab 18: the Spot service-linked role. Lab 19: EKS, its roles.
  allowed("iam:CreateServiceLinkedRole", `arn:aws:iam::${A}:role/aws-service-role/spot.amazonaws.com/AWSServiceRoleForEC2Spot`, { "iam:AWSServiceName": "spot.amazonaws.com" });
  allowed("eks:CreateCluster", arn("eks", "cluster/lab-saa-19-eks"), NEW);
  allowed("eks:CreateNodegroup", arn("eks", "nodegroup/lab-saa-19-eks/lab-saa-19-eks-ng/*"), NEW);
  for (const [a, r] of [["eks:DeleteNodegroup", "nodegroup/lab-saa-19-eks/lab-saa-19-eks-ng/0abc"], ["eks:DeleteCluster", "cluster/lab-saa-19-eks"]]) allowed(a, arn("eks", r), LAB);
  pass("lab-saa-19-eks-cluster", "eks");
  pass("lab-saa-19-eks-node", "ec2");
  allowed("iam:AttachRolePolicy", `arn:aws:iam::${A}:role/cloudlabs-lab/lab-saa-19-eks-cluster`, { ...BOUNDED, "iam:PolicyARN": "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy" });
});
```

Change the existing tests:
- "every role policy and the boundary fit (A29), and the role holds at most 10": rename "… and the role holds at most ROLE_POLICIES_MAX" and replace its comment with `// Ruling P1: up to 20 (IAM's L-0DA4ABF3 is 20 in this account).`
- "the simulator cases are A19's, fix round 1's and batch 2's …": the expected list gains, after `["an ECS cluster in us-east-1", "denied"]` and before `["a subnet in the default VPC", "denied"]`: `["a global table's replica in Ireland", "allowed"], ["an untagged table not named for a lab", "denied"], ["copy an AMI to Ireland", "allowed"], ["a tagged HTTP API", "allowed"], ["an untagged HTTP API", "denied"], ["a route on a lab API", "allowed"], ["delete an untagged API", "denied"], ["API Gateway's account settings", "denied"], ["delete a load balancer Kubernetes made for lab 19", "allowed"], ["delete an untagged load balancer", "denied"], ["the Spot service-linked role", "allowed"]`; rename it "… batch 2's and batch 3's …".
- "--labs: every simulator case …": `sims.length` 41 → 52.
- "each §7.1 statement says what it must": the Sid list gains `"ElbDeleteLabOrEks"`.
- "A29's fall-back: lists too long for 10 policies …": "for 10" → "for ROLE_POLICIES_MAX" (the 4,000 actions still need more than 20).
- "lab-abac.json is the generator's …": the pinned hash is replaced by the regenerated lists' hash (the first run after Step 4 prints both; the reviewer reads the lists' diff first: P2's API Gateway moves, CopyImage and DeleteLoadBalancer gone, whatever AWS added to the reference since 2026-10-15).

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test scripts/test/aws-labs-iam.test.mjs`
Expected: FAIL (no `POLICY_PACK`/`HTTP_VERB_RULES`; DELETE/PATCH are creates; 41 cases; no `ElbDeleteLabOrEks`).

- [ ] **Step 3: Change `aws-lab-policies.mjs` and `aws-bootstrap-labs.mjs`** as above.

- [ ] **Step 4: Regenerate the lists and the policies**

Run: `node scripts/aws-labs-abac.mjs && node scripts/aws-labs-abac.mjs --render && node scripts/aws-labs-abac.mjs --check`
Expected: `lab-abac.json` rewritten (fetched 2026-10-1x); `--render` prints "role: N of at most 20 policies" with N ≤ 16 and every size under 5,600, and no A29 fall-back. If the reference does not answer from this machine, say so in the task report and leave both files for the controller (Task 16 Step 1).

- [ ] **Step 5: Run the targeted tests**

Run: `node --test scripts/test/aws-labs-iam.test.mjs`
Expected: PASS (after the hash pin is updated as Step 1 says).

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/aws-lab-policies.mjs scripts/lib/aws-bootstrap-labs.mjs infra/aws-bootstrap/lab-abac.json infra/aws-bootstrap/lab-policies.json scripts/test/aws-labs-iam.test.mjs
git commit -m "feat(aws labs): 20 role policies with headroom; API Gateway verbs by rule; DynamoDB tables and AMI copies by name; EKS-made load balancers deletable; batch 3 service-linked roles

Claude-Session: https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D"
```

---
### Task 3: Lint and scope: batch 3's types and rules

Spec: §7.3 (lint; scope rules 1, 4–13), §7.4, §7.5, §12.2 rows 11–19, rulings A4, A42, A56, A65, A68, P3–P7, P12–P18.

**Files:**
- Modify: `infra/ci/lab-scope-aws.mjs` (`AWS_TYPES` gains batch 3's; `workflowProblem` and `endpointPolicyProblem` exported; `glueName`; the rule-1 region checks; `batch3Problems` called per resource; the `iam` role list; the `tag`, `lingering` and `size` cases; the health-check `fqdn` condition; header comment's rule table names the batch 3 clauses)
- Modify: `infra/ci/lab-lint.mjs` (AWS text rules: `ami-` joins the known-id pattern; `arn:aws:states:::aws-sdk:` refused, rule `gateway`; header)
- Modify: `scripts/test/fixtures/labs/plans/extract-computed.mjs` (`TYPES` gains batch 3's), regenerate `computed.json` and `schema-facts.json`
- Test: `scripts/test/lab-scope-aws.test.mjs`, `scripts/test/lab-lint.test.mjs`

**Interfaces:**
- Produces (lab-scope-aws.mjs): `export function workflowProblem(doc: object, labId: string): string | null`, `export function endpointPolicyProblem(doc: object, namePrefix: string, region: string): string | null`. Tasks 9 and 11's lab tests call them on their own documents. Every later lab's plan fixture relies on the regenerated `computed.json`.

**`AWS_TYPES`** gains (before the closing `]);`):
```js
  // Batch 3 (labs 11–19).
  ...["aws_elasticache_subnet_group", "aws_elasticache_replication_group"].map((t) => [t, "lab 11's cache: one Valkey node in the lab's own subnets (rules size, lingering; ruling P17)"]),
  ...["aws_apigatewayv2_api", "aws_apigatewayv2_authorizer", "aws_apigatewayv2_integration", "aws_apigatewayv2_route", "aws_apigatewayv2_stage"].map((t) => [t, "lab 12's HTTP API: public by nature (§7.4), throttled, invoking only the lab's own function, trusting only the lab's own user pool (ruling P12)"]),
  ...["aws_cognito_user_pool", "aws_cognito_user_pool_client", "aws_cognito_user"].map((t) => [t, "lab 12's sign-in: a Lite-tier pool of the lab's own users, no hosted domain (ruling P12)"]),
  ["aws_dynamodb_table", "a lab table named lab-<id>-*, on demand; a replica only in the session's secondary region (rulings P3, P12)"],
  ...["aws_sqs_queue", "aws_sqs_queue_policy", "aws_sns_topic_subscription"].map((t) => [t, "lab 13's queues and its topic's subscriptions to them (ruling P14)"]),
  ["aws_cloudwatch_event_bus", "lab 13's own event bus"],
  ["aws_sfn_state_machine", "lab 13's workflow, calling only the lab's own function, topic and queues (ruling P14)"],
  ...["aws_efs_file_system", "aws_efs_mount_target"].map((t) => [t, "lab 14's file system, mounted in the lab's own subnets"]),
  ...["aws_s3_bucket_intelligent_tiering_configuration", "aws_s3_bucket_server_side_encryption_configuration"].map((t) => [t, "lab buckets named cloudlabs-<name_prefix>-*"]),
  ["aws_vpc_endpoint_policy", "a policy on the lab's own endpoint allowing only the lab's buckets and Amazon Linux's repositories (ruling P18)"],
  ["aws_ami_copy", "a copy of AWS's own AMI, named lab-<id>-* (ruling P4)"],
  ...["aws_kinesis_stream", "aws_kinesis_firehose_delivery_stream"].map((t) => [t, "lab 17's stream (one shard) and its delivery to the lab's own bucket (ruling P15)"]),
  ...["aws_glue_catalog_database", "aws_glue_crawler"].map((t) => [t, "lab 17's catalogue, lab_<id>, crawled by hand from the lab's own bucket (ruling P15)"]),
  ["aws_athena_workgroup", "lab 17's workgroup: results in the lab's own bucket, a scan cut-off (ruling P15)"],
  ...["aws_eks_cluster", "aws_eks_node_group"].map((t) => [t, "lab 19's cluster and its one-node group (ruling P7)"]),
```

**In `scopeProblemsAws`**, beside `prefix`:
```js
  /** Ruling P15: a lab's Glue database name (Glue and Athena take no hyphens). */
  const glueName = `lab_${labId.replace(/-/g, "_")}`;
```

Rule 1 (provider), after the `multi_region` line:
```js
    // Ruling P3: a table's replica only in the session's secondary region; P4, P6: a region a resource names is a lab one.
    const labRegion = (x) => typeof x === "string" && knownRegions.has(x) && !GLOBAL_REGIONS.includes(x);
    if (plan && isManaged && type === "aws_dynamodb_table") list(v.replica).forEach((rep, i) => {
      if (isObj(rep) && !(secondaryOk && rep.region_name === variables.secondary_region)) refuse("provider", `replica.${i}: a table's replica lives only in the session's secondary region (ruling P3)`);
    });
    for (const [t, attr] of [["aws_ami_copy", "source_ami_region"], ["aws_route53_health_check", "cloudwatch_alarm_region"]]) {
      if (plan && isManaged && type === t && v[attr] != null && !labRegion(v[attr])) refuse("provider", `${attr}: only the session's region or its secondary`);
    }
    if (plan && isManaged && type === "aws_route53_zone") list(v.vpc).forEach((z, i) => {
      if (isObj(z) && !labRegion(z.vpc_region)) refuse("provider", `vpc.${i}.vpc_region: only the session's region or its secondary, written in the configuration (ruling P6)`);
    });
```

Rule 7 (untaggable), after the log-group line:
```js
    // Rulings P3, P4, P15: what the safety net also finds by name.
    if (isManaged && (type === "aws_dynamodb_table" || type === "aws_ami_copy") && !startsKnown(v.name, prefix)) refuse("untaggable", `${type}'s name must start ${prefix}: the safety net also finds it by name (rulings P3, P4)`);
    if (isManaged && type === "aws_glue_catalog_database" && !startsKnown(v.name, glueName)) refuse("untaggable", `a Glue database is named ${glueName}... (Glue takes no hyphens; ruling P15)`);
```

Rule 8 (iam): the role loop's list becomes:
```js
      for (const [t, attr] of [["aws_lambda_function", "role"], ["aws_ecs_task_definition", "execution_role_arn"], ["aws_ecs_task_definition", "task_role_arn"], ["aws_sfn_state_machine", "role_arn"], ["aws_cloudwatch_event_target", "role_arn"], ["aws_glue_crawler", "role"], ["aws_eks_cluster", "role_arn"], ["aws_eks_node_group", "node_role_arn"], ["aws_s3_bucket_replication_configuration", "role"]]) {
```
(soa-01's event target has no role, so it is skipped as an unset attribute; soa-04's replication role is its own by reference.)

The health-check line in rule 9 becomes `else if (v.type !== "CALCULATED" && v.type !== "CLOUDWATCH_METRIC" && !ownRef("fqdn", ["aws_cloudfront_distribution", "aws_lb"])) …` (ruling P6: a CloudWatch-metric check names its alarm instead; `batch3Problems` reads it).

After rule 14 (description), for every managed resource: `if (isManaged) batch3Problems(r, v);` and, among the rules' details:
```js
    /** Batch 3's reference and value rules (rulings P6, P7, P12–P18), one switch by type. */
    function batch3Problems(res, val) {
      /** The lab's own item of `types`, by reference (an Unknown's own references; a mocked plan has none to read). */
      const own = (x, types, attr) => {
        if (!(x instanceof Unknown)) return false;
        const refs = x.refs?.length ? x.refs : refsOf(x, res, attr);
        return (mode === "mock" && !refs.length) || ownRefs(refs, types);
      };
      const first = (x) => list(x).find(isObj) ?? {};
      const ownBucket = (s) => typeof s === "string" && nonEmpty(variables.name_prefix) && s.startsWith(`s3://cloudlabs-${variables.name_prefix}-`);
      const needOwn = (attr, types, rule, why) => {
        if (plan && !own(val[attr], types, attr)) refuse(rule, `${attr} must be ${why}, by reference`);
      };
      switch (type) {
        case "aws_db_instance":
          if (val.publicly_accessible === true) refuse("public", "publicly_accessible: a lab database is reached from the lab's own instances or the VPN, never the internet (ruling P16)");
          break;
        case "aws_lambda_permission":
          needOwn("source_arn", ["aws_apigatewayv2_api", "aws_cloudwatch_event_rule", "aws_sns_topic", "aws_s3_bucket", "aws_secretsmanager_secret"], "public", "built from the lab's own API, rule, topic, bucket or secret (ruling P13)");
          break;
        case "aws_cloudwatch_event_target":
          needOwn("arn", ["aws_sns_topic", "aws_sqs_queue", "aws_lambda_function", "aws_sfn_state_machine", "aws_kinesis_stream", "aws_cloudwatch_log_group"], "gateway", "the lab's own topic, queue, function, state machine, stream or log group (ruling P14)");
          break;
        case "aws_sns_topic_subscription":
          if (!["sqs", "lambda"].includes(val.protocol)) refuse("gateway", `protocol ${JSON.stringify(val.protocol ?? null)}: a subscription delivers only to the lab's own queue or function (ruling P14)`);
          needOwn("endpoint", ["aws_sqs_queue", "aws_lambda_function"], "gateway", "the lab's own queue or function (ruling P14)");
          needOwn("topic_arn", ["aws_sns_topic"], "gateway", "the lab's own topic");
          break;
        case "aws_sfn_state_machine": {
          const j = jsonDoc(val.definition);
          if (j.unknown) {
            if (plan) refuse("gateway", "definition must be known at plan, so what it calls can be read (ruling P14)");
          } else if (j.bad) refuse("gateway", `definition is not JSON this check can read${j.why ? ` (${j.why})` : ""}`);
          else {
            const why = workflowProblem(j.doc, labId);
            if (why) refuse("gateway", `definition: ${why} (ruling P14)`);
          }
          break;
        }
        case "aws_kinesis_firehose_delivery_stream": {
          if (val.destination !== "extended_s3") refuse("gateway", `destination ${JSON.stringify(val.destination ?? null)}: only extended_s3, the lab's own bucket (ruling P14)`);
          const src = first(val.kinesis_source_configuration);
          const s3 = first(val.extended_s3_configuration);
          if (plan && !(own(src.kinesis_stream_arn, ["aws_kinesis_stream"], "kinesis_source_configuration") && own(s3.bucket_arn, ["aws_s3_bucket"], "extended_s3_configuration"))) refuse("gateway", "the source stream and the destination bucket must be the lab's own, by reference (ruling P14)");
          for (const [blk, b] of [["kinesis_source_configuration", src], ["extended_s3_configuration", s3]]) if (plan && !own(b.role_arn, ["aws_iam_role"], blk)) refuse("iam", `${blk}.role_arn must be one of the lab's own roles, by reference`);
          if (first(s3.cloudwatch_logging_options).enabled === true) refuse("lingering", "cloudwatch_logging_options.enabled: Firehose would make its own log group outside /cloudlabs/ (ruling P15)");
          break;
        }
        case "aws_glue_crawler": {
          for (const t of ["jdbc_target", "dynamodb_target", "catalog_target", "mongodb_target", "delta_target", "iceberg_target", "hudi_target"]) if (list(val[t]).some(isObj)) refuse("gateway", `${t}: a lab's crawler reads only the lab's own bucket (ruling P14)`);
          const paths = list(val.s3_target).map((t) => (isObj(t) ? t.path : undefined));
          if (plan && !(paths.length > 0 && paths.every(ownBucket))) refuse("gateway", `every s3_target path must start s3://cloudlabs-${variables.name_prefix ?? "<name_prefix>"}- (ruling P14)`);
          if (nonEmpty(val.schedule)) refuse("size", "schedule: every crawler run is billed; a lab's crawler runs by hand (ruling P15)");
          if (!startsKnown(val.database_name, glueName) && !(plan && own(val.database_name, ["aws_glue_catalog_database"], "database_name"))) refuse("gateway", `database_name must be the lab's own database (${glueName})`);
          break;
        }
        case "aws_athena_workgroup": {
          const cfg = first(val.configuration);
          if (plan && !ownBucket(first(cfg.result_configuration).output_location)) refuse("gateway", "configuration.result_configuration.output_location must be in the lab's own bucket (ruling P14)");
          const cut = cfg.bytes_scanned_cutoff_per_query;
          if (!(typeof cut === "number" && cut <= 1073741824)) refuse("size", "configuration.bytes_scanned_cutoff_per_query must be set, at most 1 GiB (ruling P15)");
          if (cfg.enforce_workgroup_configuration !== true) refuse("size", "configuration.enforce_workgroup_configuration must be true, so no query skips the cut-off (ruling P15)");
          break;
        }
        case "aws_route53_zone":
          if (list(val.vpc).some(isObj)) {
            if (typeof val.name === "string" && !/\.internal\.?$/.test(val.name)) refuse("gateway", `a private zone is named *.internal, never a real domain (it is ${JSON.stringify(val.name)}; ruling P6)`);
            list(val.vpc).forEach((z, i) => {
              if (plan && isObj(z) && !own(z.vpc_id, ["aws_vpc"], "vpc")) refuse("gateway", `vpc.${i}.vpc_id must be one of the lab's own VPCs, by reference (ruling P6)`);
            });
          }
          break;
        case "aws_route53_health_check":
          if (val.type === "CLOUDWATCH_METRIC") {
            const a = val.cloudwatch_alarm_name;
            if (!(typeof a === "string" ? a.startsWith(prefix) : !plan || own(a, ["aws_cloudwatch_metric_alarm"], "cloudwatch_alarm_name"))) refuse("gateway", `cloudwatch_alarm_name must be the lab's own alarm, named ${prefix}* (ruling P6)`);
          }
          break;
        case "aws_vpc_endpoint_policy": {
          needOwn("vpc_endpoint_id", ["aws_vpc_endpoint"], "gateway", "one of the lab's own endpoints (ruling P18)");
          const j = jsonDoc(val.policy);
          if (j.unknown) {
            if (plan) refuse("public", "policy must be known at plan (ruling P18)");
          } else if (j.bad) refuse("public", `policy is not a document this check can read${j.why ? ` (${j.why})` : ""}`);
          else {
            const why = endpointPolicyProblem(j.doc, variables.name_prefix, variables.region);
            if (why) refuse("public", `policy: ${why} (ruling P18)`);
          }
          break;
        }
        case "aws_ami_copy": {
          const src = val.source_ami_id;
          const fromParam = typeof src === "string" ? dataStrings.has(src) : refsOf(src, res, "source_ami_id").some((x) => x.startsWith("data.aws_ssm_parameter."));
          if (!fromParam && !(!plan && src instanceof Unknown)) refuse("gateway", "source_ami_id must be AWS's own AMI from the public SSM parameter (data.aws_ssm_parameter under /aws/service/; ruling P4)");
          break;
        }
        case "aws_dynamodb_table":
          if (val.billing_mode !== "PAY_PER_REQUEST") refuse("size", `billing_mode ${JSON.stringify(val.billing_mode ?? "PROVISIONED")}: only PAY_PER_REQUEST (ruling P12)`);
          break;
        case "aws_s3_bucket_server_side_encryption_configuration":
          for (const ru of list(val.rule)) for (const d of list(isObj(ru) ? ru.apply_server_side_encryption_by_default : [])) {
            if (isObj(d) && d.kms_master_key_id != null && plan && !own(d.kms_master_key_id, ["aws_kms_key"], "rule")) refuse("gateway", "kms_master_key_id must be the lab's own key, by reference");
          }
          break;
        case "aws_apigatewayv2_api":
          for (const k of ["body", "target", "route_key", "credentials_arn"]) if (res.configured?.has(k) || nonEmpty(val[k])) refuse("gateway", `${k}: a lab's API is built from its own routes and integrations, never imported or quick-created (ruling P12)`);
          break;
        case "aws_apigatewayv2_integration":
          if (val.integration_type !== "AWS_PROXY") refuse("gateway", `integration_type ${JSON.stringify(val.integration_type ?? null)}: only AWS_PROXY to the lab's own function (an HTTP proxy relays to anywhere; ruling P12)`);
          else needOwn("integration_uri", ["aws_lambda_function"], "gateway", "the lab's own function (ruling P12)");
          needOwn("api_id", ["aws_apigatewayv2_api"], "gateway", "the lab's own API");
          break;
        case "aws_apigatewayv2_authorizer": {
          const jwt = first(val.jwt_configuration);
          const aud = list(jwt.audience);
          if (val.authorizer_type === "JWT" && plan && !(own(jwt.issuer, ["aws_cognito_user_pool"], "jwt_configuration") && aud.length > 0 && aud.every((x) => own(x, ["aws_cognito_user_pool_client"], "jwt_configuration")))) refuse("gateway", "a JWT authoriser trusts only the lab's own user pool and app client, by reference (ruling P12)");
          if (val.authorizer_type === "REQUEST") needOwn("authorizer_uri", ["aws_lambda_function"], "gateway", "the lab's own function");
          needOwn("api_id", ["aws_apigatewayv2_api"], "gateway", "the lab's own API");
          break;
        }
        case "aws_apigatewayv2_route":
          needOwn("api_id", ["aws_apigatewayv2_api"], "gateway", "the lab's own API");
          if (val.target != null) needOwn("target", ["aws_apigatewayv2_integration"], "gateway", "the lab's own integration");
          break;
        case "aws_apigatewayv2_stage": {
          needOwn("api_id", ["aws_apigatewayv2_api"], "gateway", "the lab's own API");
          const s = first(val.default_route_settings);
          if (!(typeof s.throttling_burst_limit === "number" && s.throttling_burst_limit <= 20 && typeof s.throttling_rate_limit === "number" && s.throttling_rate_limit <= 10)) refuse("size", "default_route_settings must throttle the API to at most 20 burst and 10 requests a second (ruling P12)");
          break;
        }
        case "aws_cognito_user_pool":
          if (val.user_pool_tier === "PLUS") refuse("size", "user_pool_tier PLUS is billed per user: LITE (ruling P12)");
          if (val.deletion_protection === "ACTIVE") refuse("lingering", "deletion_protection must be INACTIVE so tear-down can delete the pool");
          break;
        case "aws_cognito_user_pool_client":
        case "aws_cognito_user":
          needOwn("user_pool_id", ["aws_cognito_user_pool"], "gateway", "the lab's own user pool");
          break;
        case "aws_efs_file_system":
          if (val.throughput_mode === "provisioned") refuse("size", "provisioned throughput bills by the hour: bursting or elastic");
          break;
        case "aws_efs_mount_target":
          needOwn("file_system_id", ["aws_efs_file_system"], "gateway", "the lab's own file system");
          break;
        case "aws_elasticache_replication_group":
          if (typeof val.num_cache_clusters === "number" && val.num_cache_clusters > 2) refuse("size", `num_cache_clusters ${val.num_cache_clusters} is over 2 (ruling P17)`);
          if (typeof val.num_node_groups === "number" && val.num_node_groups > 1) refuse("size", "num_node_groups: one node group (ruling P17)");
          if (nonEmpty(val.final_snapshot_identifier)) refuse("lingering", "final_snapshot_identifier keeps a snapshot after tear-down (ruling P17)");
          break;
        case "aws_eks_cluster": {
          const ac = first(val.access_config);
          if (ac.bootstrap_cluster_creator_admin_permissions !== false || ac.authentication_mode !== "API") refuse("iam", "access_config: authentication_mode = API and bootstrap_cluster_creator_admin_permissions = false: the pipeline's role never holds Kubernetes admin (ruling P7)");
          if (list(val.enabled_cluster_log_types).length) refuse("lingering", "enabled_cluster_log_types: EKS would make /aws/eks/<cluster>/cluster, untagged and outside /cloudlabs/ (ruling P7)");
          if (first(val.upgrade_policy).support_type !== "STANDARD") refuse("size", "upgrade_policy.support_type must be STANDARD: extended support bills $0.60 an hour (ruling P7)");
          if (list(val.compute_config).some((x) => isObj(x) && x.enabled === true)) refuse("size", "compute_config: EKS Auto Mode bills per instance on top (ruling P7)");
          if (list(val.remote_network_config).some(isObj)) refuse("gateway", "remote_network_config reaches networks outside the lab");
          if (plan && !own(first(val.vpc_config).subnet_ids, ["aws_subnet"], "vpc_config")) refuse("gateway", "vpc_config.subnet_ids must be the lab's own subnets, by reference");
          break;
        }
        case "aws_eks_node_group":
          if (list(val.remote_access).some(isObj)) refuse("public", "remote_access opens SSH to the nodes; reach them through the cluster (ruling P7)");
          if (!(val.cluster_name === `lab-${labId}` || (plan && own(val.cluster_name, ["aws_eks_cluster"], "cluster_name")))) refuse("gateway", `cluster_name must be the lab's own cluster, lab-${labId}`);
          break;
        default:
      }
    }
```

`lingeringProblems` gains:
```js
        case "aws_athena_workgroup":
          must("force_destroy", true, false);
          break;
        case "aws_kinesis_stream":
          must("enforce_consumer_deletion", true, false);
          break;
```
`sizeProblems` gains `if (type === "aws_eks_node_group") list(val.instance_types).forEach((t) => instanceType(t, "instance_types"));` (beside the existing node-group `max_size` cap).
`tagProblems` gains:
```js
    case "aws_dynamodb_table":
      if (list(v.replica).some((x) => isObj(x) && x.propagate_tags !== true)) refuse("tag", "every replica must have propagate_tags = true, so it carries the lab tag (ruling P3)");
      break;
```

Below `trustProblem`:
```js
/** Ruling P14: why a Step Functions definition reaches outside the lab, or null. */
export function workflowProblem(doc, labId) {
  const integrations = new Set(["arn:aws:states:::lambda:invoke", "arn:aws:states:::sns:publish", "arn:aws:states:::sqs:sendMessage"]);
  const own = new RegExp(String.raw`[:/]lab-${escapeRe(labId)}-[A-Za-z0-9_.-]+$`);
  let why = null;
  walk(doc, [], (kind, path, s) => {
    if (why) return;
    const key = path[path.length - 1];
    if (kind === "key") {
      if (["Resource.$", "FunctionName.$", "TopicArn.$", "QueueUrl.$"].includes(s)) why = `${path.join(".")}: a target chosen at run time could be anything`;
      return;
    }
    if (key === "Resource" && !integrations.has(s) && !(s.startsWith("arn:aws:lambda:") && own.test(s))) why = `${path.join(".")}: ${s} is neither the lab's own function nor a lambda:invoke, sns:publish or sqs:sendMessage integration (no aws-sdk:)`;
    else if (["FunctionName", "TopicArn", "QueueUrl"].includes(key) && !own.test(s)) why = `${path.join(".")}: ${key} must be one of the lab's own, named lab-${labId}-*`;
  });
  return why;
}

/** Ruling P18: why an endpoint policy lets the endpoint reach more than the lab's buckets and Amazon Linux's repositories, or null. */
export function endpointPolicyProblem(doc, namePrefix, region) {
  const okArn = (a) => typeof a === "string" && ((nonEmpty(namePrefix) && a.startsWith(`arn:aws:s3:::cloudlabs-${namePrefix}-`)) || (nonEmpty(region) && a.startsWith(`arn:aws:s3:::al2023-repos-${region}-`)));
  for (const s of list(doc.Statement)) {
    if (!isObj(s)) return "it has a statement this check cannot read";
    if (s.Effect === "Deny") continue;
    if ("NotResource" in s || "NotAction" in s) return "an Allow with NotResource or NotAction reaches everything else";
    const res = list(s.Resource);
    const bad = res.find((a) => !okArn(a));
    if (!res.length || bad !== undefined) return `it allows ${JSON.stringify(bad ?? "no resource")}: only the lab's own buckets (cloudlabs-<name_prefix>-*) and Amazon Linux's repositories (al2023-repos-<region>-*)`;
  }
  return null;
}
```

**`infra/ci/lab-lint.mjs`**: the known-id pattern becomes `/\b(?:i|vol|snap|eni|sg|subnet|vpc|rtb|acl|ami)-[0-9a-f]{8,17}\b/g` (ruling P4's backstop: a copy's source is the public parameter), and `AWS_TEXT_RULES` gains, after the known-id rules:
```js
  // Ruling P14: a workflow's SDK integrations can call any API with the state machine's role.
  { rule: "gateway", re: /arn:aws:states:::aws-sdk:[\w:.-]*/g, message: (m) => `${m}: a lab's workflow uses only lambda:invoke, sns:publish and sqs:sendMessage` },
```

**`extract-computed.mjs`**: `TYPES` gains, after the batch 2 AWS types: `"aws_elasticache_subnet_group", "aws_elasticache_replication_group", "aws_apigatewayv2_api", "aws_apigatewayv2_authorizer", "aws_apigatewayv2_integration", "aws_apigatewayv2_route", "aws_apigatewayv2_stage", "aws_cognito_user_pool", "aws_cognito_user_pool_client", "aws_cognito_user", "aws_dynamodb_table", "aws_sqs_queue", "aws_sns_topic_subscription", "aws_cloudwatch_event_bus", "aws_sfn_state_machine", "aws_efs_file_system", "aws_efs_mount_target", "aws_s3_bucket_intelligent_tiering_configuration", "aws_s3_bucket_server_side_encryption_configuration", "aws_vpc_endpoint_policy", "aws_ami_copy", "aws_kinesis_stream", "aws_kinesis_firehose_delivery_stream", "aws_glue_catalog_database", "aws_glue_crawler", "aws_athena_workgroup", "aws_eks_cluster", "aws_eks_node_group", "aws_lambda_permission"` (the last only if not already there; `aws_eks_cluster` is already, keep one).

- [ ] **Step 1: Write the failing tests** in `scripts/test/lab-scope-aws.test.mjs` (same helpers as the file's other tests; `workflowProblem` and `endpointPolicyProblem` imported through `scope`):

```js
const c11 = ctxAws("saa-11-three-tier", "11");
const c12 = ctxAws("saa-12-serverless-api", "12");
const c13 = ctxAws("saa-13-decoupling", "13");
const c15 = ctxAws("saa-15-data-security", "15");
const c16b = ctxAws("saa-16-dr-pilot-light", "16");
const c16 = { ...c16b, variables: { ...c16b.variables, secondary_region: "eu-west-1" } };
const c17 = ctxAws("saa-17-data-pipeline", "17");
const c19 = ctxAws("saa-19-eks", "19");
const T = (cx, address, values, more = {}) => ({ address, values: tagged(cx, values), refs: {}, ...more });
const U = (address, values, more = {}) => ({ address, values, refs: {}, ...more });
const rulesFor = (cx, extra, base) => rules(realisticPlan({ resources: [...(base ?? templateMainResources(cx)), ...extra], data: awsData(), providers: ["aws"], providerConfig: AWS_PROVIDER_CONFIG, variables: cx.variables }), cx.id);
const DB = { identifier: "db-a11k3x9q", engine: "mysql", instance_class: "db.t4g.micro", allocated_storage: 20, skip_final_snapshot: true, deletion_protection: false, delete_automated_backups: true, copy_tags_to_snapshot: true };

test("rulings P16 and P13: refuses a public database and a Lambda permission with no own source; an own rule passes", () => {
  assert.deepEqual(rulesFor(c11, [T(c11, "aws_db_instance.app", { ...DB, publicly_accessible: true })], templateResources(c11)), ["public: aws_db_instance.app"]);
  assert.deepEqual(rulesFor(c11, [T(c11, "aws_db_instance.app", { ...DB, publicly_accessible: false })], templateResources(c11)), []);
  const rule = T(c17, "aws_cloudwatch_event_rule.tick", { name: "lab-saa-17-data-pipeline-tick", schedule_expression: "rate(1 minute)" });
  const perm = (over) => U("aws_lambda_permission.tick", { statement_id: "events", action: "lambda:InvokeFunction", function_name: "lab-saa-17-data-pipeline-producer", principal: "events.amazonaws.com", ...over.values }, over.more ?? {});
  assert.deepEqual(rulesFor(c17, [rule, perm({ values: {} })]), ["public: aws_lambda_permission.tick"]);
  assert.deepEqual(rulesFor(c17, [rule, perm({ values: {}, more: { unknown: ["source_arn"], refs: { source_arn: ref("aws_cloudwatch_event_rule.tick", "arn") } } })]), []);
});

test("Review Focus 5 / P14: refuses a target, subscription, workflow, stream or path outside the lab", () => {
  const other = "arn:aws:sqs:eu-west-2:999999999999:theirs";
  assert.deepEqual(rulesFor(c13, [U("aws_cloudwatch_event_target.x", { rule: "lab-saa-13-decoupling-placed", target_id: "x", arn: other })]), ["gateway: aws_cloudwatch_event_target.x"]);
  assert.deepEqual(rulesFor(c13, [U("aws_sns_topic_subscription.x", { protocol: "https", endpoint: "https://example.com/hook" }, { unknown: ["topic_arn"], refs: { topic_arn: ref("aws_sns_topic.orders", "arn") } }), T(c13, "aws_sns_topic.orders", { name: "lab-saa-13-decoupling-orders" })]), ["gateway: aws_sns_topic_subscription.x"]);
  const wf = (Resource) => JSON.stringify({ StartAt: "A", States: { A: { Type: "Task", Resource, End: true } } });
  const sm = (def) => T(c13, "aws_sfn_state_machine.orders", { name: "lab-saa-13-decoupling-orders", type: "STANDARD", definition: def }, { unknown: ["role_arn"], refs: { role_arn: ref("aws_iam_role.sfn", "arn") } });
  const sfnRole = { ...role({ name: "lab-saa-13-decoupling-sfn", assume_role_policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "states.amazonaws.com" }, Action: "sts:AssumeRole" }] }) }), address: "aws_iam_role.sfn", values: tagged(c13, { name: "lab-saa-13-decoupling-sfn", path: "/cloudlabs-lab/", permissions_boundary: BOUNDARY, assume_role_policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "states.amazonaws.com" }, Action: "sts:AssumeRole" }] }) }) };
  assert.deepEqual(rulesFor(c13, [sfnRole, sm(wf("arn:aws:states:::aws-sdk:iam:createUser"))]), ["gateway: aws_sfn_state_machine.orders"]);
  assert.deepEqual(rulesFor(c13, [sfnRole, sm(wf(`arn:aws:lambda:eu-west-2:${ACCOUNT}:function:lab-saa-13-decoupling-validate`))]), []);
  assert.equal(scope.workflowProblem({ States: { A: { Type: "Task", Resource: "arn:aws:states:::sns:publish", Parameters: { TopicArn: "arn:aws:sns:eu-west-2:1:someone" } } } }, "saa-13-decoupling") !== null, true);
  const svcRole = (cx, key, name, svc) => ({ address: `aws_iam_role.${key}`, values: tagged(cx, { name, path: "/cloudlabs-lab/", permissions_boundary: BOUNDARY, assume_role_policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: `${svc}.amazonaws.com` }, Action: "sts:AssumeRole" }] }) }), refs: {} });
  const crawlerRole = svcRole(c17, "crawler", "lab-saa-17-data-pipeline-crawler", "glue");
  const crawler = (path) => T(c17, "aws_glue_crawler.events", { name: "lab-saa-17-data-pipeline-events", database_name: "lab_saa_17_data_pipeline", s3_target: [{ path }] }, { unknown: ["role"], refs: { role: ref("aws_iam_role.crawler", "arn") } });
  assert.deepEqual(rulesFor(c17, [crawlerRole, crawler("s3://cloudlabs-a17k3x9q-lake/events/")]), []);
  assert.deepEqual(rulesFor(c17, [crawlerRole, crawler("s3://someone-else/events/")]), ["gateway: aws_glue_crawler.events"]);
  assert.deepEqual(rulesFor(c17, [T(c17, "aws_athena_workgroup.wg", { name: "lab-saa-17-data-pipeline-wg", force_destroy: true, configuration: [{ enforce_workgroup_configuration: true, bytes_scanned_cutoff_per_query: 10485760, result_configuration: [{ output_location: "s3://someone-else/results/" }] }] })]), ["gateway: aws_athena_workgroup.wg"]);
  const fhRole = svcRole(c17, "firehose", "lab-saa-17-data-pipeline-firehose", "firehose");
  const fhRefs = { unknown: ["kinesis_source_configuration.0.role_arn", "extended_s3_configuration.0.role_arn"], refs: { "kinesis_source_configuration.0.role_arn": ref("aws_iam_role.firehose", "arn"), "extended_s3_configuration.0.role_arn": ref("aws_iam_role.firehose", "arn") } };
  assert.deepEqual(rulesFor(c17, [fhRole, T(c17, "aws_kinesis_firehose_delivery_stream.x", { name: "lab-saa-17-data-pipeline-to-s3", destination: "extended_s3", kinesis_source_configuration: [{ kinesis_stream_arn: "arn:aws:kinesis:eu-west-2:999999999999:stream/theirs" }], extended_s3_configuration: [{ bucket_arn: "arn:aws:s3:::someone-else" }] }, fhRefs)]), ["gateway: aws_kinesis_firehose_delivery_stream.x"]);
});

test("ruling P6: refuses a private zone on another VPC or with a real name, and a health check on another alarm", () => {
  const zone = (over, more = {}) => T(c16, "aws_route53_zone.dr", { name: "dr.a16k3x9q.internal", force_destroy: true, vpc: [{ vpc_region: "eu-west-2" }], ...over }, { unknown: ["vpc.0.vpc_id"], refs: { "vpc.0.vpc_id": ref("aws_vpc.lab", "id") }, ...more });
  assert.deepEqual(rulesFor(c16, [zone({})], templateResources(c16)), []);
  assert.deepEqual(rulesFor(c16, [zone({ name: "corp.example.com" })], templateResources(c16)), ["gateway: aws_route53_zone.dr"]);
  assert.deepEqual(rulesFor(c16, [zone({ vpc: [{ vpc_id: "vpc-0123456789abcdef0", vpc_region: "eu-west-2" }] }, { unknown: [], refs: {} })], templateResources(c16)), ["gateway: aws_route53_zone.dr"]);
  assert.deepEqual(rulesFor(c16, [zone({ vpc: [{ vpc_region: "us-east-2" }] })], templateResources(c16)), ["provider: aws_route53_zone.dr"]);
  const hc = (name) => T(c16, "aws_route53_health_check.app", { type: "CLOUDWATCH_METRIC", cloudwatch_alarm_name: name, cloudwatch_alarm_region: "eu-west-2", insufficient_data_health_status: "Healthy" });
  assert.deepEqual(rulesFor(c16, [hc("lab-saa-16-dr-pilot-light-app-down")]), []);
  assert.deepEqual(rulesFor(c16, [hc("someone-elses-alarm")]), ["gateway: aws_route53_health_check.app"]);
});

test("ruling P18: refuses an endpoint policy allowing another bucket; the lab's buckets and AL2023's repositories pass", () => {
  const pol = (Resource) => JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: "*", Action: "s3:*", Resource }] });
  const ep = (Resource) => U("aws_vpc_endpoint_policy.s3", { policy: pol(Resource) }, { unknown: ["vpc_endpoint_id"], refs: { vpc_endpoint_id: ref("aws_vpc_endpoint.s3", "id") } });
  assert.deepEqual(rulesFor(c15, [ep(["arn:aws:s3:::cloudlabs-a15k3x9q-data", "arn:aws:s3:::cloudlabs-a15k3x9q-data/*", "arn:aws:s3:::al2023-repos-eu-west-2-de612dc2/*"])], templateResources(c15)), []);
  assert.deepEqual(rulesFor(c15, [ep(["arn:aws:s3:::*"])], templateResources(c15)), ["public: aws_vpc_endpoint_policy.s3"]);
  assert.match(scope.endpointPolicyProblem({ Statement: [{ Effect: "Allow", Principal: "*", Action: "s3:*", NotResource: "arn:aws:s3:::x" }] }, "a15k3x9q", "eu-west-2"), /NotResource/);
});

test("Review Focus 1: a DynamoDB table or an AMI copy not named lab-<id>-*, a copy of anything but the public parameter, a misnamed Glue database are refused", () => {
  const table = (name, extra = {}) => T(c16, "aws_dynamodb_table.orders", { name, billing_mode: "PAY_PER_REQUEST", hash_key: "id", deletion_protection_enabled: false, ...extra });
  assert.deepEqual(rulesFor(c16, [table("orders")]), ["untaggable: aws_dynamodb_table.orders"]);
  assert.deepEqual(rulesFor(c16, [table("lab-saa-16-dr-pilot-light-orders", { replica: [{ region_name: "eu-west-1", propagate_tags: true }] })]), []);
  assert.deepEqual(rulesFor(c16, [table("lab-saa-16-dr-pilot-light-orders", { replica: [{ region_name: "us-east-2", propagate_tags: true }] })]), ["provider: aws_dynamodb_table.orders"]);
  assert.deepEqual(rulesFor(c16, [table("lab-saa-16-dr-pilot-light-orders", { replica: [{ region_name: "eu-west-1", propagate_tags: false }] })]), ["tag: aws_dynamodb_table.orders"]);
  assert.deepEqual(rulesFor(c16, [table("lab-saa-16-dr-pilot-light-orders", { billing_mode: "PROVISIONED" })]), ["size: aws_dynamodb_table.orders"]);
  const copy = (name, src) => T(c16, "aws_ami_copy.dr", { name, source_ami_id: src, source_ami_region: "eu-west-2" });
  assert.deepEqual(rulesFor(c16, [copy("lab-saa-16-dr-pilot-light-al2023", AMI)], templateResources(c16)), []);
  assert.deepEqual(rulesFor(c16, [copy("al2023-copy", AMI)], templateResources(c16)), ["untaggable: aws_ami_copy.dr"]);
  assert.deepEqual(rulesFor(c16, [copy("lab-saa-16-dr-pilot-light-al2023", "ami-0fedcba9876543210")], templateResources(c16)), ["gateway: aws_ami_copy.dr"]);
  assert.deepEqual(rulesFor(c17, [T(c17, "aws_glue_catalog_database.lake", { name: "events" })]), ["untaggable: aws_glue_catalog_database.lake"]);
  assert.deepEqual(rulesFor(c17, [T(c17, "aws_glue_catalog_database.lake", { name: "lab_saa_17_data_pipeline" })]), []);
});

test("ruling P12: API Gateway and Cognito: an HTTP proxy, an authoriser on another pool, an unthrottled stage, a PLUS pool are refused", () => {
  const api = T(c12, "aws_apigatewayv2_api.lab", { name: "lab-saa-12-serverless-api", protocol_type: "HTTP" });
  const apiRef = { unknown: ["api_id"], refs: { api_id: ref("aws_apigatewayv2_api.lab", "id") } };
  assert.deepEqual(rulesFor(c12, [api, U("aws_apigatewayv2_integration.x", { integration_type: "HTTP_PROXY", integration_uri: "https://example.com", integration_method: "ANY" }, apiRef)]), ["gateway: aws_apigatewayv2_integration.x"]);
  assert.deepEqual(rulesFor(c12, [api, U("aws_apigatewayv2_authorizer.jwt", { authorizer_type: "JWT", name: "cognito", identity_sources: ["$request.header.Authorization"], jwt_configuration: [{ issuer: "https://cognito-idp.eu-west-2.amazonaws.com/eu-west-2_Theirs", audience: ["their-client"] }] }, apiRef)]), ["gateway: aws_apigatewayv2_authorizer.jwt"]);
  assert.deepEqual(rulesFor(c12, [api, T(c12, "aws_apigatewayv2_stage.default", { name: "$default", auto_deploy: true }, apiRef)]), ["size: aws_apigatewayv2_stage.default"]);
  assert.deepEqual(rulesFor(c12, [api, T(c12, "aws_apigatewayv2_stage.default", { name: "$default", auto_deploy: true, default_route_settings: [{ throttling_burst_limit: 10, throttling_rate_limit: 5 }] }, apiRef)]), []);
  assert.deepEqual(rulesFor(c12, [T(c12, "aws_cognito_user_pool.users", { name: "lab-saa-12-serverless-api-users", user_pool_tier: "PLUS", deletion_protection: "INACTIVE" })]), ["size: aws_cognito_user_pool.users"]);
  assert.deepEqual(rulesFor(c12, [T(c12, "aws_cognito_user_pool.users", { name: "lab-saa-12-serverless-api-users", user_pool_tier: "LITE", deletion_protection: "ACTIVE" })]), ["lingering: aws_cognito_user_pool.users"]);
});

test("Review Focus 3: EKS: refuses creator admin, extended support, control-plane logs, another node size and a node group over 2", () => {
  const cluster = (over = {}) => T(c19, "aws_eks_cluster.lab", { name: "lab-saa-19-eks", access_config: [{ authentication_mode: "API", bootstrap_cluster_creator_admin_permissions: false }], upgrade_policy: [{ support_type: "STANDARD" }], vpc_config: [{ endpoint_private_access: true, endpoint_public_access: true }], ...over }, { unknown: ["role_arn", "vpc_config.0.subnet_ids"], refs: { role_arn: ref("aws_iam_role.cluster", "arn"), "vpc_config.0.subnet_ids": ["aws_subnet.private"] } });
  const crole = { ...role(), address: "aws_iam_role.cluster", values: tagged(c19, { name: "lab-saa-19-eks-cluster", path: "/cloudlabs-lab/", permissions_boundary: BOUNDARY, assume_role_policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "eks.amazonaws.com" }, Action: "sts:AssumeRole" }] }) }) };
  const base = templateResources(c19);
  assert.deepEqual(rulesFor(c19, [crole, cluster()], base), []);
  assert.deepEqual(rulesFor(c19, [crole, cluster({ access_config: [{ authentication_mode: "API", bootstrap_cluster_creator_admin_permissions: true }] })], base), ["iam: aws_eks_cluster.lab"]);
  assert.deepEqual(rulesFor(c19, [crole, cluster({ upgrade_policy: [{ support_type: "EXTENDED" }] })], base), ["size: aws_eks_cluster.lab"]);
  assert.deepEqual(rulesFor(c19, [crole, cluster({ enabled_cluster_log_types: ["api", "audit"] })], base), ["lingering: aws_eks_cluster.lab"]);
  const ng = (over = {}) => T(c19, "aws_eks_node_group.lab", { cluster_name: "lab-saa-19-eks", node_group_name: "lab-saa-19-eks-ng", instance_types: ["t4g.medium"], scaling_config: [{ desired_size: 1, min_size: 1, max_size: 2 }], ...over }, { unknown: ["node_role_arn", "subnet_ids"], refs: { node_role_arn: ref("aws_iam_role.cluster", "arn"), subnet_ids: ["aws_subnet.private"] } });
  assert.deepEqual(rulesFor(c19, [crole, ng()], base), []);
  assert.deepEqual(rulesFor(c19, [crole, ng({ instance_types: ["m5.large"] })], base), ["size: aws_eks_node_group.lab"]);
  assert.deepEqual(rulesFor(c19, [crole, ng({ scaling_config: [{ desired_size: 1, min_size: 1, max_size: 3 }] })], base), ["size: aws_eks_node_group.lab"]);
});

test("lingering: an Athena workgroup without force_destroy, a stream without enforce_consumer_deletion, an ElastiCache final snapshot", () => {
  const wg = (force) => T(c17, "aws_athena_workgroup.wg", { name: "lab-saa-17-data-pipeline-wg", force_destroy: force, configuration: [{ enforce_workgroup_configuration: true, bytes_scanned_cutoff_per_query: 10485760, result_configuration: [{ output_location: "s3://cloudlabs-a17k3x9q-lake/athena/" }] }] });
  assert.deepEqual(rulesFor(c17, [wg(true)]), []);
  assert.deepEqual(rulesFor(c17, [wg(false)]), ["lingering: aws_athena_workgroup.wg"]);
  assert.deepEqual(rulesFor(c17, [T(c17, "aws_kinesis_stream.events", { name: "lab-saa-17-data-pipeline-events", shard_count: 1, retention_period: 24, enforce_consumer_deletion: false, stream_mode_details: [{ stream_mode: "PROVISIONED" }] })]), ["lingering: aws_kinesis_stream.events"]);
  assert.deepEqual(rulesFor(c11, [T(c11, "aws_elasticache_replication_group.app", { replication_group_id: "ca11k3x9q", description: "x", engine: "valkey", node_type: "cache.t4g.micro", num_cache_clusters: 1, final_snapshot_identifier: "keep-me" })]), ["lingering: aws_elasticache_replication_group.app"]);
});

test("ruling P5: a secondary provider needs a plan with secondary_region set", () => {
  const sec = { ...AWS_PROVIDER_CONFIG, "aws.secondary": { name: "aws", full_name: "registry.terraform.io/hashicorp/aws", alias: "secondary", expressions: { alias: { constant_value: "secondary" }, region: { references: ["var.secondary_region"] }, default_tags: [{ tags: { references: ["var.tags"] } }] } } };
  const p16 = (variables) => realisticPlan({ resources: templateMainResources(c16), data: awsData(), providers: ["aws"], providerConfig: sec, variables });
  assert.deepEqual(rules(p16(c16.variables), c16.id), []);
  assert.deepEqual(rules(p16({ ...c16.variables, secondary_region: "" }), c16.id), ["provider: provider.aws.secondary"]);
});
```

In `scripts/test/lab-lint.test.mjs`:
```js
test("rulings P4 and P14 (--cloud aws): a literal AMI id and an aws-sdk: workflow integration are refused", () => {
  const tf = ['locals {', '  a = "ami-0123456789abcdef0"', '  b = "arn:aws:states:::aws-sdk:iam:createUser"', '  c = "ami-dr"', '}', ''].join("\n");
  assert.deepEqual(lintTfText({ "x.tf": tf }, { cloud: "aws" }).map((p) => `${p.rule}: ${p.line}`).sort(), ["gateway: 3", "known-id: 2"]);
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test scripts/test/lab-scope-aws.test.mjs scripts/test/lab-lint.test.mjs`
Expected: FAIL (the new types are not on `AWS_TYPES` and are missing from `computed.json`, so `realisticPlan` throws; the rules do not exist).

- [ ] **Step 3: Regenerate the schema facts** with the batch 3 types added to `TYPES`, exactly as the file's header says (a scratch folder, the pinned provider versions, `terraform providers schema -json`, no cloud calls), then `node scripts/test/fixtures/labs/plans/extract-computed.mjs <schema.json>`. If terraform cannot download providers here, say so in the task report and leave `computed.json`/`schema-facts.json` for the controller (Task 16 Step 1); the tests that need them stay red until then.

- [ ] **Step 4: Write the rules and lists** above; the header's rule table gains, per rule, the batch 3 clauses (provider: replicas, alarm and zone regions; untaggable: tables, copies, Glue names; iam: the roles passed, EKS access; gateway: targets, subscriptions, workflows, pipeline paths, private zones, alarms, API pieces, AMI sources; public: databases, Lambda sources, endpoint policies, node SSH; lingering: workgroups, streams, cache snapshots, EKS logs, Firehose logs, Cognito protection; size: tables, stages, Cognito tier, crawler schedules, workgroup cut-off, cache size, EKS support and Auto Mode, node sizes).

- [ ] **Step 5: Run the targeted tests**

Run: `node --test scripts/test/lab-scope-aws.test.mjs scripts/test/lab-lint.test.mjs scripts/test/lab-plans.test.mjs`
Expected: PASS, every batch 1 and 2 lab's fixture still clean.

- [ ] **Step 6: Commit**

```bash
git add infra/ci/lab-scope-aws.mjs infra/ci/lab-lint.mjs scripts/test/fixtures/labs/plans/extract-computed.mjs scripts/test/fixtures/labs/plans/computed.json scripts/test/fixtures/labs/plans/schema-facts.json scripts/test/lab-scope-aws.test.mjs scripts/test/lab-lint.test.mjs
git commit -m "feat(aws labs): scope and lint for batch 3: tables, copies, APIs, Cognito, workflows, targets, pipelines, private zones, endpoint policies, EKS, ElastiCache; public databases refused

Claude-Session: https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D"
```

---
### Task 4: Unblock, safety net, Verify clean and ready check for batch 3's types

Spec: §5.1, §8.1–§8.3, §15 (slow deletes, EKS-made resources, Lambda VPC interfaces), rulings A36, A53, P3, P4, P8, P9, P17, P21.

**Files:**
- Modify: `infra/ci/lab-aws-safety-net.sh` (`split_arn` reads API Gateway ARNs; `GLUE_DB`; discovery by name of DynamoDB tables, AMIs and Glue databases; `describe`, `judge`; handlers; `HANDLED`; run order; header comment's phase lists and rulings)
- Modify: `infra/ci/lab-unblock-aws.sh` (Cognito deletion protection; load balancers Kubernetes made; header)
- Modify: `infra/ci/lab-ready-aws.sh` (ElastiCache fails fast; the header names Spot tolerance)
- Test: `scripts/test/lab-aws-cleanup.test.mjs`, `scripts/test/lab-aws-pipeline.test.mjs` (ready check), `scripts/test/aws-labs-iam.test.mjs` (the CLI-coverage test's lists)

**Interfaces:**
- Consumes: Task 2's policies (every new CLI call is a `LabServices` read, a tagged change, a `NAMED_*` table action, an image or snapshot call, or P8's load balancer delete; the CLI-coverage test proves it). Produces nothing other tasks call.
- Already there, used unchanged: Ireland in `$LAB_REGIONS`; VPC fabric, NAT, ALB, ASG, instance, RDS, S3, SNS, SQS, Lambda, EventBridge rule, log group, KMS, alarm, Route 53 zone and health check handlers.

**`split_arn`**, first thing after the `IFS=: read` line:
```bash
  # Ruling P2: arn:aws:apigateway:<r>::/apis/<id>[/stages/<name>]: the last collection named is the type.
  if [ "$service" = apigateway ]; then
    rest="${rest#/}"
    case "$rest" in
      apis/*/stages/*) TYPE=apigateway:stages; head="${rest#apis/}"; ID="${head%%/*}/${rest##*/}" ;;
      *) TYPE="apigateway:${rest%%/*}"; ID="${rest#*/}" ;;
    esac
    return
  fi
```
Beside `PREFIX`: `GLUE_DB="lab_${LAB_ID//-/_}"   # ruling P15: Glue takes no hyphens`.

**Discovery**, inside the lab-regions block of `discover()`, after the KMS aliases:
```bash
      # Rulings P3, P4, P15: what the lab also owns by name (a replica before its tags arrive, an AMI copy, a Glue database).
      if json="$(awsq "$r" dynamodb list-tables)"; then
        while IFS= read -r n; do [ -n "$n" ] && add "$r" dynamodb:table "$n" "" "" 0; done < <(jq -r --arg p "$PREFIX" '.TableNames[]? | select(startswith($p))' <<<"$json")
      else
        list_failed "DynamoDB tables in $r"
      fi
      if json="$(awsq "$r" ec2 describe-images --owners self --filters "Name=name,Values=${PREFIX}*")"; then
        while IFS=$'\x1f' read -r x n; do [ -n "$x" ] && add "$r" ec2:image "$x" "" "$n" 0; done < <(jq -r --arg p "$PREFIX" '.Images[]? | select((.Name // "") | startswith($p)) | [.ImageId, .Name] | join("\u001f")' <<<"$json")
      else
        list_failed "AMIs in $r"
      fi
      if json="$(awsq "$r" glue get-databases)"; then
        while IFS= read -r n; do [ -n "$n" ] && add "$r" glue:database "$n" "" "" 0; done < <(jq -r --arg p "$GLUE_DB" '.DatabaseList[]?.Name // empty | select(. == $p or startswith($p + "_"))' <<<"$json")
      else
        list_failed "Glue databases in $r"
      fi
```

**`describe`** gains (before `iam:role)`):
```bash
    apigateway:apis) set -- apigatewayv2 get-api --api-id "$id"; q='.' ;;
    apigateway:stages) set -- apigatewayv2 get-stage --api-id "${id%%/*}" --stage-name "${id#*/}"; q='.' ;;
    cognito-idp:userpool) set -- cognito-idp describe-user-pool --user-pool-id "$id"; q='.UserPool' ;;
    dynamodb:table) set -- dynamodb describe-table --table-name "$id"; q='.Table' ;;
    events:event-bus) set -- events describe-event-bus --name "$id"; q='.' ;;
    states:stateMachine) set -- stepfunctions describe-state-machine --state-machine-arn "$x"; q='.' ;;
    elasticfilesystem:file-system) set -- efs describe-file-systems --file-system-id "$id"; q='.FileSystems[]?' ;;
    elasticache:replicationgroup) set -- elasticache describe-replication-groups --replication-group-id "$id"; q='.ReplicationGroups[]?' ;;
    elasticache:cluster) set -- elasticache describe-cache-clusters --cache-cluster-id "$id"; q='.CacheClusters[]?' ;;
    elasticache:subnetgroup) set -- elasticache describe-cache-subnet-groups --cache-subnet-group-name "$id"; q='.CacheSubnetGroups[]?' ;;
    elasticache:snapshot) set -- elasticache describe-snapshots --snapshot-name "$id"; q='.Snapshots[]?' ;;
    kinesis:stream) set -- kinesis describe-stream-summary --stream-name "$id"; q='.StreamDescriptionSummary' ;;
    firehose:deliverystream) set -- firehose describe-delivery-stream --delivery-stream-name "$id"; q='.DeliveryStreamDescription' ;;
    glue:crawler) set -- glue get-crawler --name "$id"; q='.Crawler' ;;
    glue:database) set -- glue get-database --name "$id"; q='.Database' ;;
    athena:workgroup) set -- athena list-work-groups; q='.WorkGroups[]? | select(.Name == $id)' ;;
    eks:cluster) set -- eks describe-cluster --name "$id"; q='.cluster' ;;
    eks:nodegroup) set -- eks describe-nodegroup --cluster-name "${id%%/*}" --nodegroup-name "$(cut -d/ -f2 <<<"$id")"; q='.nodegroup' ;;
```
(`ec2:image` already has its describe.) **`judge`** gains (ruling P21; everything else of batch 3 is there until AWS no longer has it):
```bash
    dynamodb:table) g='.TableStatus == "DELETING"' ;;
    states:stateMachine) g='.status == "DELETING"' ;;
    elasticfilesystem:file-system) g='.LifeCycleState == "deleted"' ;;
```

**Handlers** (new, beside their phase's; `del_image` replaced):
```bash
# Phase 1, workloads (batch 3). EKS: node groups, then clusters (AWS refuses a cluster that still has node groups),
# each waited for until AWS no longer has it (V: minutes each; Task 17 records them).
del_nodegroup() { wr "$1" "delete $(label "$1")" eks delete-nodegroup --cluster-name "${C_I[$1]%%/*}" --nodegroup-name "$(cut -d/ -f2 <<<"${C_I[$1]}")"; }
del_eks() { wr "$1" "delete $(label "$1")" eks delete-cluster --name "${C_I[$1]}"; }
# An HTTP API takes its stages, routes, integrations and authorisers with it; a stage still listed is only judged.
del_api() { wr "$1" "delete $(label "$1")" apigatewayv2 delete-api --api-id "${C_I[$1]}"; }
del_sfn() { wr "$1" "delete $(label "$1")" stepfunctions delete-state-machine --state-machine-arn "${C_A[$1]}"; }
# A bus's rules go first, by the events:rule handler (bus-qualified); then the bus.
del_bus() { wr "$1" "delete $(label "$1")" events delete-event-bus --name "${C_I[$1]}"; }
del_firehose() { wr "$1" "delete $(label "$1")" firehose delete-delivery-stream --delivery-stream-name "${C_I[$1]}" --allow-force-delete; }
del_stream() { wr "$1" "delete $(label "$1")" kinesis delete-stream --stream-name "${C_I[$1]}" --enforce-consumer-deletion; }
# Ruling P21: a running crawler is stopped and waited for (AWS refuses to delete one that runs).
del_crawler() {
  local i="$1" s k=0
  while :; do
    describe "$i"
    [ $? -eq 1 ] && return 1
    s="$(jq -r '.State // "READY"' <<<"$DJ" 2>/dev/null)"
    [ "$s" = READY ] && break
    [ "$s" = RUNNING ] && [ "$k" -eq 0 ] && wr "$i" "stop $(label "$i")" glue stop-crawler --name "${C_I[$i]}"
    k=$((k + 1))
    if past_until; then
      warn "left behind: $(label "$i") (still $s)"
      return 1
    fi
    echo "safety net: waiting for $(label "$i") to stop"
    sleep "$POLL_S"
  done
  wr "$i" "delete $(label "$i")" glue delete-crawler --name "${C_I[$i]}"
}
# A database takes its tables, the crawler's too, with it.
del_gluedb() { wr "$1" "delete $(label "$1") and its tables" glue delete-database --name "${C_I[$1]}"; }
del_workgroup() { wr "$1" "delete $(label "$1") and its saved queries" athena delete-work-group --work-group "${C_I[$1]}" --recursive-delete-option; }

# Phase 3, network services (batch 3): ElastiCache and EFS hold network interfaces in the lab's subnets.
del_cache_group() { wr "$1" "delete $(label "$1")" elasticache delete-replication-group --replication-group-id "${C_I[$1]}" --no-retain-primary-cluster; }
# A cluster in a replication group goes with it; only a cluster of its own is deleted here.
del_cache_cluster() {
  local i="$1"
  describe "$i"
  [ $? -eq 1 ] && return 1
  [ -n "$(jq -r '.ReplicationGroupId // empty' <<<"$DJ" 2>/dev/null)" ] && return 1
  wr "$i" "delete $(label "$i")" elasticache delete-cache-cluster --cache-cluster-id "${C_I[$i]}"
}
del_cache_subnets() { wr "$1" "delete $(label "$1")" elasticache delete-cache-subnet-group --cache-subnet-group-name "${C_I[$1]}"; }
del_cache_snapshot() { wr "$1" "delete $(label "$1")" elasticache delete-snapshot --snapshot-name "${C_I[$1]}"; }
# EFS: every mount target, waited for, then the file system.
del_efs() {
  local i="$1" fs="${C_I[$1]}" json m left
  if ! json="$(awsq "${C_R[$i]}" efs describe-mount-targets --file-system-id "$fs")"; then
    gone_err && return 1
    warn "could not list the mount targets of $(label "$i") ($(code))"
    return 1
  fi
  while IFS= read -r m; do [ -n "$m" ] && wr "$i" "delete mount target $m of $(label "$i")" efs delete-mount-target --mount-target-id "$m"; done < <(jq -r '.MountTargets[]?.MountTargetId // empty' <<<"$json")
  while :; do
    json="$(awsq "${C_R[$i]}" efs describe-mount-targets --file-system-id "$fs")" || break
    left="$(jq '.MountTargets // [] | length' <<<"$json" 2>/dev/null)"
    [ "${left:-0}" -eq 0 ] && break
    if past_until; then
      warn "left behind: $(label "$i") ($left mount target(s) still being deleted)"
      return 1
    fi
    echo "safety net: waiting for $left mount target(s) of $(label "$i")"
    sleep "$POLL_S"
  done
  wr "$i" "delete $(label "$i")" efs delete-file-system --file-system-id "$fs"
}

# Phase 5, data and the rest (batch 3). Ruling P21: a global table's replicas in other regions are removed and waited
# for, then the table.
del_table() {
  local i="$1" t="${C_I[$1]}" r="${C_R[$1]}" rep n
  describe "$i"
  [ $? -eq 1 ] && return 1
  [ "$(jq -r '.TableStatus // ""' <<<"$DJ" 2>/dev/null)" = DELETING ] && return 1
  while IFS= read -r rep; do
    [ -n "$rep" ] && wr "$i" "remove the $rep replica of $(label "$i")" dynamodb update-table --table-name "$t" --replica-updates "Delete={RegionName=$rep}"
  done < <(jq -r --arg r "$r" '.Replicas[]?.RegionName // empty | select(. != $r)' <<<"$DJ" 2>/dev/null)
  while :; do
    describe "$i"
    [ $? -eq 1 ] && return 1
    n="$(jq -r --arg r "$r" '[.Replicas[]? | select(.RegionName != $r)] | length' <<<"$DJ" 2>/dev/null)"
    [ "${n:-0}" -eq 0 ] && break
    if past_until; then
      warn "left behind: $(label "$i") ($n replica(s) still being removed)"
      return 1
    fi
    echo "safety net: waiting for $n replica(s) of $(label "$i") to go"
    sleep "$POLL_S"
  done
  wr "$i" "delete $(label "$i")" dynamodb delete-table --table-name "$t"
}
# A pool's domains first (AWS refuses a pool that still has one); deletion protection off if Unblock could not.
del_userpool() {
  local i="$1" d
  describe "$i"
  [ $? -eq 1 ] && return 1
  for d in $(jq -r '.Domain // empty, .CustomDomain // empty' <<<"$DJ" 2>/dev/null); do
    wr "$i" "delete the domain $d of $(label "$i")" cognito-idp delete-user-pool-domain --domain "$d" --user-pool-id "${C_I[$i]}"
  done
  [ "$(jq -r '.DeletionProtection // ""' <<<"$DJ" 2>/dev/null)" = ACTIVE ] && wr "$i" "turn off deletion protection on $(label "$i")" cognito-idp update-user-pool --user-pool-id "${C_I[$i]}" --deletion-protection INACTIVE
  wr "$i" "delete $(label "$i")" cognito-idp delete-user-pool --user-pool-id "${C_I[$i]}"
}
# Ruling P4: an AMI copy's snapshots carry no tags, so they are read from the image and deleted after it.
del_image() {
  local i="$1" snaps s
  describe "$i"
  [ $? -eq 1 ] && return 1
  snaps="$(jq -r '.BlockDeviceMappings[]?.Ebs.SnapshotId // empty' <<<"$DJ" 2>/dev/null)"
  wr "$i" "deregister $(label "$i")" ec2 deregister-image --image-id "${C_I[$i]}" || return 1
  for s in $snaps; do wr "$i" "delete snapshot $s of $(label "$i")" ec2 delete-snapshot --snapshot-id "$s"; done
}
```
`HANDLED` gains `eks:nodegroup eks:cluster apigateway:apis apigateway:stages states:stateMachine events:event-bus firehose:deliverystream kinesis:stream glue:crawler glue:database athena:workgroup elasticache:replicationgroup elasticache:cluster elasticache:subnetgroup elasticache:snapshot elasticfilesystem:file-system dynamodb:table cognito-idp:userpool` (a stage goes with its API: handled, only judged).

**Run order** (new lines in their phase; existing ones unchanged):
```bash
# 1 workloads
stacks
run eks:nodegroup poll del_nodegroup
run eks:cluster poll del_eks
…(ECS, task definitions: unchanged)…
run lambda:function - del_lambda
run apigateway:apis - del_api
run states:stateMachine - del_sfn
run autoscaling:autoScalingGroup poll del_asg
run events:rule - del_rule
run events:event-bus - del_bus
run firehose:deliverystream poll del_firehose
run kinesis:stream poll del_stream
run glue:crawler - del_crawler
run glue:database - del_gluedb
run athena:workgroup - del_workgroup
…(Config: unchanged)…
# 3 network services
…(load balancers … RDS snapshots: unchanged)…
run elasticache:replicationgroup poll del_cache_group
run elasticache:cluster poll del_cache_cluster
run elasticache:subnetgroup - del_cache_subnets
run elasticache:snapshot - del_cache_snapshot
run elasticfilesystem:file-system poll del_efs
…(instances … flow logs: unchanged)…
# 5 data and the rest
…(buckets … access analyzers: unchanged)…
run dynamodb:table poll del_table
run cognito-idp:userpool - del_userpool
run ec2:image - del_image
…(snapshots, resource groups, IAM: unchanged)…
```

**`infra/ci/lab-unblock-aws.sh`**: the header gains "Cognito user pools: deletion protection off; EKS clusters: every load balancer in the region Kubernetes made for the cluster (tagged kubernetes.io/cluster/<cluster>, ELBv2 and classic) deleted (ruling P8: a Kubernetes LoadBalancer service is refused by the cluster role's policy, so this only ever finds one a person made through Kubernetes some other way)". Inside the region loop, `clusters=()` beside `vaults=()`, and the `case` gains:
```bash
      cognito-idp:userpool)
        if pj="$(awsq "$r" cognito-idp describe-user-pool --user-pool-id "$id")" && [ "$(jq -r '.UserPool.DeletionProtection // ""' <<<"$pj" 2>/dev/null)" = ACTIVE ]; then
          do_write "$r" "turn off deletion protection on user pool $id" cognito-idp update-user-pool --user-pool-id "$id" --deletion-protection INACTIVE
        fi ;;
      eks:cluster) clusters+=("$id") ;;
```
after the Lambda loop: `for c in "${clusters[@]}"; do k8s_lbs "$r" "$c"; done`, and above the region loop:
```bash
# k8s_lbs <region> <cluster>: delete the load balancers Kubernetes made for the cluster (ruling P8).
k8s_lbs() {
  local r="$1" key="kubernetes.io/cluster/$2" json tj a n
  if json="$(awsq "$r" elbv2 describe-load-balancers)"; then
    while IFS= read -r a; do
      [ -z "$a" ] && continue
      if tj="$(awsq "$r" elbv2 describe-tags --resource-arns "$a")" && jq -e --arg k "$key" 'any(.TagDescriptions[]?.Tags[]?; .Key == $k)' <<<"$tj" >/dev/null 2>&1; then
        do_write "$r" "delete load balancer ${a##*:loadbalancer/} that Kubernetes made for $2" elbv2 delete-load-balancer --load-balancer-arn "$a"
      fi
    done < <(jq -r '.LoadBalancers[]?.LoadBalancerArn // empty' <<<"$json")
  else
    warn "could not list the load balancers in $r ($(code))"
  fi
  if json="$(awsq "$r" elb describe-load-balancers)"; then
    while IFS= read -r n; do
      [ -z "$n" ] && continue
      if tj="$(awsq "$r" elb describe-tags --load-balancer-names "$n")" && jq -e --arg k "$key" 'any(.TagDescriptions[]?.Tags[]?; .Key == $k)' <<<"$tj" >/dev/null 2>&1; then
        do_write "$r" "delete classic load balancer $n that Kubernetes made for $2" elb delete-load-balancer --load-balancer-name "$n"
      fi
    done < <(jq -r '.LoadBalancerDescriptions[]?.LoadBalancerName // empty' <<<"$json")
  else
    warn "could not list the classic load balancers in $r ($(code))"
  fi
}
```

**`infra/ci/lab-ready-aws.sh`**: the `elasticache:cluster)` case becomes (ruling P17):
```bash
    elasticache:cluster)
      json="$(awsq elasticache describe-cache-clusters --cache-cluster-id "$id" --region "$region")" || { unanswered; return; }
      s="$(jq -r '.CacheClusters[0].CacheClusterStatus // ""' <<<"$json")"
      # Ruling P17: these never recover by waiting.
      case "$s" in incompatible-network | restore-failed) KIND=failed; STATE="$s"; return ;; esac
      judge "$s" available create-failed ;;
```
and the header's list gains "ElastiCache fails at once on create-failed, incompatible-network or restore-failed (ruling P17)" and "a Spot instance AWS takes back mid-check (shutting-down, terminated) is gone, never failed (ruling P9)".

- [ ] **Step 1: Write the failing tests** in `scripts/test/lab-aws-cleanup.test.mjs` (same harness, `world`, `ENV`, `EMPTY_IAM`; `ARNOF` as batch 2's):

```js
const ARN3 = (svc, rest) => `arn:aws:${svc}:eu-west-2:123456789012:${rest}`;
const calls3 = (w, re) => w.calls().filter((c) => re.test(c));
const idx = (list, re) => list.findIndex((c) => re.test(c));

test("Review Focus 4 / P21: a global table's replicas go first, then the table; a table found only by name goes too", { skip }, () => {
  const t = "lab-saa-16-dr-pilot-light-orders";
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(ARN3("dynamodb", `table/${t}`)) },
    { cmd: "aws", match: "^dynamodb list-tables", out: JSON.stringify({ TableNames: [t, "lab-saa-16-dr-pilot-light-stray", "someone-elses"] }) },
    { cmd: "aws", match: `^dynamodb describe-table --table-name ${t} `, out: [JSON.stringify({ Table: { TableStatus: "ACTIVE", Replicas: [{ RegionName: "eu-west-1" }] } }), JSON.stringify({ Table: { TableStatus: "ACTIVE", Replicas: [] } })] },
    { cmd: "aws", match: "^dynamodb describe-table --table-name lab-saa-16-dr-pilot-light-stray ", out: [JSON.stringify({ Table: { TableStatus: "ACTIVE" } })] },
    ...EMPTY_IAM,
  ]);
  assert.equal(w.run("infra/ci/lab-aws-safety-net.sh", ["saa-16-dr-pilot-light"], ENV).status, 0);
  const ws = calls3(w, /^aws dynamodb (update-table|delete-table)/);
  assert.match(ws[0], /^aws dynamodb update-table --table-name lab-saa-16-dr-pilot-light-orders --replica-updates Delete=\{RegionName=eu-west-1\} --region eu-west-2$/);
  assert.ok(idx(ws, /^aws dynamodb update-table/) < idx(ws, new RegExp(`^aws dynamodb delete-table --table-name ${t} `)), ws.join("\n"));
  assert.ok(ws.some((c) => c.startsWith("aws dynamodb delete-table --table-name lab-saa-16-dr-pilot-light-stray ")), "found by name (ruling P3)");
  assert.ok(!ws.some((c) => c.includes("someone-elses")));
  w.cleanup();
});

test("Review Focus 4: EKS node groups, then the cluster, each waited for until AWS no longer has it", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(ARN3("eks", "cluster/lab-saa-19-eks"), ARN3("eks", "nodegroup/lab-saa-19-eks/lab-saa-19-eks-ng/0abc")) },
    { cmd: "aws", match: "^eks describe-nodegroup", out: ['{"nodegroup":{"status":"DELETING"}}', "{}"] },
    { cmd: "aws", match: "^eks describe-cluster", out: ['{"cluster":{"status":"DELETING"}}', "{}"] },
    ...EMPTY_IAM,
  ]);
  assert.equal(w.run("infra/ci/lab-aws-safety-net.sh", ["saa-19-eks"], ENV).status, 0);
  const ws = calls3(w, /^aws eks /);
  const ng = idx(ws, /^aws eks delete-nodegroup --cluster-name lab-saa-19-eks --nodegroup-name lab-saa-19-eks-ng --region eu-west-2$/);
  const cl = idx(ws, /^aws eks delete-cluster --name lab-saa-19-eks --region eu-west-2$/);
  assert.ok(ng >= 0 && cl > ng, ws.join("\n"));
  assert.ok(ws.slice(ng, cl).filter((c) => c.startsWith("aws eks describe-nodegroup")).length >= 2, "the node group was waited for until gone");
  w.cleanup();
});

test("Review Focus 4: EFS mount targets, then the file system; ElastiCache's group, never its member cluster, then the subnet group", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(ARN3("elasticfilesystem", "file-system/fs-0abc"), ARN3("elasticache", "replicationgroup:ca11k3x9q"), ARN3("elasticache", "cluster:ca11k3x9q-001"), ARN3("elasticache", "subnetgroup:lab-saa-11-three-tier-cache")) },
    { cmd: "aws", match: "^efs describe-mount-targets", out: ['{"MountTargets":[{"MountTargetId":"fsmt-1"},{"MountTargetId":"fsmt-2"}]}', '{"MountTargets":[]}'] },
    { cmd: "aws", match: "^efs describe-file-systems", out: ['{"FileSystems":[{"LifeCycleState":"deleting"}]}', '{"FileSystems":[]}'] },
    { cmd: "aws", match: "^elasticache describe-replication-groups", out: ['{"ReplicationGroups":[{"Status":"deleting"}]}', '{"ReplicationGroups":[]}'] },
    { cmd: "aws", match: "^elasticache describe-cache-clusters", out: '{"CacheClusters":[{"CacheClusterId":"ca11k3x9q-001","ReplicationGroupId":"ca11k3x9q"}]}' },
    ...EMPTY_IAM,
  ]);
  assert.equal(w.run("infra/ci/lab-aws-safety-net.sh", ["saa-11-three-tier"], ENV).status, 0);
  const efs = calls3(w, /^aws efs delete-/);
  assert.deepEqual(efs.map((c) => c.split(" --region")[0]), ["aws efs delete-mount-target --mount-target-id fsmt-1", "aws efs delete-mount-target --mount-target-id fsmt-2", "aws efs delete-file-system --file-system-id fs-0abc"]);
  const ec = calls3(w, /^aws elasticache delete-/);
  assert.deepEqual(ec.map((c) => c.split(" --region")[0]), ["aws elasticache delete-replication-group --replication-group-id ca11k3x9q --no-retain-primary-cluster", "aws elasticache delete-cache-subnet-group --cache-subnet-group-name lab-saa-11-three-tier-cache"]);
  w.cleanup();
});

test("ruling P4: an AMI found by name is deregistered and its snapshots deleted after it", { skip }, () => {
  const img = JSON.stringify({ Images: [{ ImageId: "ami-0aaa1111bbbb2222c", Name: "lab-saa-16-dr-pilot-light-al2023-a16k3x9q", State: "available", BlockDeviceMappings: [{ DeviceName: "/dev/xvda", Ebs: { SnapshotId: "snap-0ddd3333eeee4444f" } }] }] });
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged() },
    { cmd: "aws", match: "^ec2 describe-images --owners self", out: img },
    { cmd: "aws", match: "^ec2 describe-images --image-ids", out: img },
    ...EMPTY_IAM,
  ]);
  assert.equal(w.run("infra/ci/lab-aws-safety-net.sh", ["saa-16-dr-pilot-light"], ENV).status, 0);
  assert.ok(w.calls().some((c) => c.startsWith("aws ec2 describe-images --owners self --filters Name=name,Values=lab-saa-16-dr-pilot-light-* ")));
  const ws = calls3(w, /^aws ec2 (deregister-image|delete-snapshot)/).map((c) => c.split(" --region")[0]);
  assert.deepEqual(ws, ["aws ec2 deregister-image --image-id ami-0aaa1111bbbb2222c", "aws ec2 delete-snapshot --snapshot-id snap-0ddd3333eeee4444f"]);
  w.cleanup();
});

test("batch 3's workloads go by their own handlers: API, pool (domain first), workflow, bus after its rule, Firehose before its stream, a running crawler stopped, workgroup", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged("arn:aws:apigateway:eu-west-2::/apis/a1b2c3", "arn:aws:apigateway:eu-west-2::/apis/a1b2c3/stages/$default", ARN3("cognito-idp", "userpool/eu-west-2_AbC"), ARN3("states", "stateMachine:lab-x-orders"), ARN3("events", "event-bus/lab-x-bus"), ARN3("events", "rule/lab-x-bus/lab-x-placed"), ARN3("kinesis", "stream/lab-x-events"), ARN3("firehose", "deliverystream/lab-x-to-s3"), ARN3("glue", "crawler/lab-x-events"), ARN3("athena", "workgroup/lab-x-wg")) },
    { cmd: "aws", match: "^cognito-idp describe-user-pool", out: '{"UserPool":{"Id":"eu-west-2_AbC","Domain":"lab-x-auth","DeletionProtection":"INACTIVE"}}' },
    { cmd: "aws", match: "^glue get-crawler", out: ['{"Crawler":{"State":"RUNNING"}}', '{"Crawler":{"State":"READY"}}'] },
    { cmd: "aws", match: "^kinesis describe-stream-summary", out: ['{"StreamDescriptionSummary":{"StreamStatus":"DELETING"}}', "{}"] },
    { cmd: "aws", match: "^firehose describe-delivery-stream", out: ['{"DeliveryStreamDescription":{"DeliveryStreamStatus":"DELETING"}}', "{}"] },
    { cmd: "aws", match: "^events list-targets-by-rule", out: '{"Targets":[{"Id":"sfn"}]}' },
    ...EMPTY_IAM,
  ]);
  assert.equal(w.run("infra/ci/lab-aws-safety-net.sh", ["saa-13-decoupling"], ENV).status, 0);
  const ws = calls3(w, /^aws \S+ (delete|stop|remove|update)/).map((c) => c.split(" --region")[0]);
  for (const c of ["aws apigatewayv2 delete-api --api-id a1b2c3", "aws stepfunctions delete-state-machine --state-machine-arn arn:aws:states:eu-west-2:123456789012:stateMachine:lab-x-orders", "aws athena delete-work-group --work-group lab-x-wg --recursive-delete-option", "aws events delete-event-bus --name lab-x-bus"]) assert.ok(ws.includes(c), c);
  assert.ok(!ws.some((c) => /delete-stage/.test(c)), "a stage goes with its API");
  assert.ok(idx(ws, /^aws cognito-idp delete-user-pool-domain --domain lab-x-auth --user-pool-id eu-west-2_AbC$/) < idx(ws, /^aws cognito-idp delete-user-pool --user-pool-id eu-west-2_AbC$/));
  assert.ok(idx(ws, /^aws events delete-rule --name lab-x-placed --event-bus-name lab-x-bus$/) < idx(ws, /^aws events delete-event-bus/));
  assert.ok(idx(ws, /^aws firehose delete-delivery-stream --delivery-stream-name lab-x-to-s3 --allow-force-delete$/) < idx(ws, /^aws kinesis delete-stream --stream-name lab-x-events --enforce-consumer-deletion$/));
  assert.ok(idx(ws, /^aws glue stop-crawler --name lab-x-events$/) < idx(ws, /^aws glue delete-crawler --name lab-x-events$/));
  w.cleanup();
});

test("ruling P21: Verify clean judges batch 3's types: a table or workflow DELETING is clean; an EFS or stream being deleted is not", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(ARN3("dynamodb", "table/t1"), ARN3("states", "stateMachine:s1"), ARN3("elasticfilesystem", "file-system/fs-1"), ARN3("kinesis", "stream/k1"), ARN3("athena", "workgroup/w1"), ARN3("glue", "database/lab_saa_17_data_pipeline")) },
    { cmd: "aws", match: "^dynamodb describe-table", out: '{"Table":{"TableStatus":"DELETING"}}' },
    { cmd: "aws", match: "^stepfunctions describe-state-machine", out: '{"status":"DELETING"}' },
    { cmd: "aws", match: "^efs describe-file-systems", out: '{"FileSystems":[{"LifeCycleState":"deleting"}]}' },
    { cmd: "aws", match: "^kinesis describe-stream-summary", out: '{"StreamDescriptionSummary":{"StreamStatus":"DELETING"}}' },
    { cmd: "aws", match: "^athena list-work-groups", out: '{"WorkGroups":[{"Name":"someone-else"}]}' },
    { cmd: "aws", match: "^glue get-database --name", out: "", code: 254, err: "An error occurred (EntityNotFoundException) when calling the GetDatabase operation: x" },
    ...EMPTY_IAM,
  ]);
  const out = join(w.dir, "gh-output");
  writeFileSync(out, "");
  assert.equal(w.run("infra/ci/lab-aws-safety-net.sh", ["--verify", "saa-17-data-pipeline"], { ...ENV, GITHUB_OUTPUT: fwd(out) }).status, 1);
  const left = JSON.parse(/^leftovers=(.*)$/m.exec(readFileSync(out, "utf8"))[1]);
  assert.deepEqual(left.sort(), ["elasticfilesystem:file-system fs-1", "kinesis:stream k1"]);
  w.cleanup();
});

test("Review Focus 3 / P8: Unblock deletes only the load balancers Kubernetes made for this lab's cluster, and turns off a pool's protection", { skip }, () => {
  const k8s = '{"TagDescriptions":[{"Tags":[{"Key":"kubernetes.io/cluster/lab-saa-19-eks","Value":"owned"}]}]}';
  const other = '{"TagDescriptions":[{"Tags":[{"Key":"kubernetes.io/cluster/someone","Value":"owned"}]}]}';
  const lb = (n) => `arn:aws:elasticloadbalancing:eu-west-2:123456789012:loadbalancer/net/${n}/0abc`;
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(ARN3("eks", "cluster/lab-saa-19-eks"), ARN3("cognito-idp", "userpool/eu-west-2_AbC")) },
    { cmd: "aws", match: "^elbv2 describe-load-balancers", out: JSON.stringify({ LoadBalancers: [{ LoadBalancerArn: lb("k8s") }, { LoadBalancerArn: lb("other") }] }) },
    { cmd: "aws", match: `^elbv2 describe-tags --resource-arns ${lb("k8s")}`, out: k8s },
    { cmd: "aws", match: `^elbv2 describe-tags --resource-arns ${lb("other")}`, out: other },
    { cmd: "aws", match: "^elb describe-load-balancers", out: '{"LoadBalancerDescriptions":[{"LoadBalancerName":"a1b2c3"},{"LoadBalancerName":"web"}]}' },
    { cmd: "aws", match: "^elb describe-tags --load-balancer-names a1b2c3", out: k8s },
    { cmd: "aws", match: "^elb describe-tags --load-balancer-names web", out: '{"TagDescriptions":[{"Tags":[]}]}' },
    { cmd: "aws", match: "^cognito-idp describe-user-pool", out: '{"UserPool":{"DeletionProtection":"ACTIVE"}}' },
  ]);
  assert.equal(w.run("infra/ci/lab-unblock-aws.sh", ["saa-19-eks"], ENV).status, 0);
  const ws = calls3(w, /^aws (elbv2|elb|cognito-idp) (delete|update)/).map((c) => c.split(" --region")[0]);
  assert.deepEqual(ws.sort(), ["aws cognito-idp update-user-pool --user-pool-id eu-west-2_AbC --deletion-protection INACTIVE", `aws elbv2 delete-load-balancer --load-balancer-arn ${lb("k8s")}`, "aws elb delete-load-balancer --load-balancer-name a1b2c3"].sort());
  w.cleanup();
});
```

In `scripts/test/lab-aws-pipeline.test.mjs`, beside the ready-check tests:
```js
test("ruling P17: the ready check fails at once on an ElastiCache cluster in incompatible-network", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: JSON.stringify({ ResourceTagMappingList: [{ ResourceARN: "arn:aws:elasticache:eu-west-2:123456789012:cluster:ca11k3x9q-001" }] }) },
    { cmd: "aws", match: "^elasticache describe-cache-clusters", out: '{"CacheClusters":[{"CacheClusterStatus":"incompatible-network"}]}' },
  ]);
  const r = w.run("infra/ci/lab-ready-aws.sh", ["saa-11-three-tier", "20"], { LAB_REGIONS: "eu-west-2", LAB_READY_POLL_SECONDS: "0" });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /not ready: elasticache:cluster ca11k3x9q-001 \(incompatible-network\)/);
  assert.equal(w.calls().filter((c) => c.startsWith("aws elasticache describe-cache-clusters")).length, 1, "no waiting");
  w.cleanup();
});

test("ruling P9: a Spot instance AWS took back mid-check is gone, never failed; the rest ready means ready", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: JSON.stringify({ ResourceTagMappingList: [{ ResourceARN: "arn:aws:ec2:eu-west-2:123456789012:instance/i-0spot" }, { ResourceARN: "arn:aws:ec2:eu-west-2:123456789012:instance/i-0base" }] }) },
    { cmd: "aws", match: "^ec2 describe-instance-status --instance-ids i-0spot", out: '{"InstanceStatuses":[{"InstanceState":{"Name":"terminated"}}]}' },
    { cmd: "aws", match: "^ec2 describe-instance-status --instance-ids i-0base", out: '{"InstanceStatuses":[{"InstanceState":{"Name":"running"},"InstanceStatus":{"Status":"ok"},"SystemStatus":{"Status":"ok"}}]}' },
  ]);
  const r = w.run("infra/ci/lab-ready-aws.sh", ["saa-18-cost-compute", "5"], { LAB_REGIONS: "eu-west-2", LAB_READY_POLL_SECONDS: "0" });
  assert.equal(r.status, 0, r.out);
  w.cleanup();
});
```

In `scripts/test/aws-labs-iam.test.mjs`'s CLI-coverage test: `SERVICES_RE`'s list gains `elb|apigatewayv2|cognito-idp|stepfunctions|efs|kinesis|firehose|glue|athena` (dynamodb, eks and elasticache are already there); `CLI_SERVICE` gains `elb: "elasticloadbalancing", apigatewayv2: "apigateway", stepfunctions: "states", efs: "elasticfilesystem"`; `CLI_ACTION` gains `"apigatewayv2 get-api": ["apigateway:GET"], "apigatewayv2 get-stage": ["apigateway:GET"], "apigatewayv2 delete-api": ["apigateway:DELETE"]`; in `requestsOf`, a `dynamodb` resource is `arn:aws:dynamodb:${r}:${A}:table/lab-soa-01-x-items` and an `ec2` image or snapshot call (`/image|snapshot/` in the command) carries no tag context (P4: neither is tag-checked); the `must` list gains `"eks delete-nodegroup", "eks delete-cluster", "dynamodb update-table", "dynamodb delete-table", "apigatewayv2 delete-api", "cognito-idp delete-user-pool", "efs delete-mount-target", "elasticache delete-replication-group", "kinesis delete-stream", "firehose delete-delivery-stream", "glue stop-crawler", "glue delete-database", "athena delete-work-group", "stepfunctions delete-state-machine", "elbv2 delete-load-balancer", "elb delete-load-balancer"`; `calls.length > 90` becomes `> 130`.

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test scripts/test/lab-aws-cleanup.test.mjs scripts/test/lab-aws-pipeline.test.mjs scripts/test/aws-labs-iam.test.mjs`
Expected: FAIL (no handlers for the new types; ElastiCache waits; the CLI-coverage test does not find the new calls).

- [ ] **Step 3: Write the scripts' changes** above; `bash -n` all three scripts.

- [ ] **Step 4: Run the targeted tests**

Run: `node --test scripts/test/lab-aws-cleanup.test.mjs scripts/test/lab-aws-pipeline.test.mjs scripts/test/aws-labs-iam.test.mjs`
Expected: PASS (every earlier cleanup, pipeline and IAM test unchanged; the AMI test's `del_image` keeps batch 1's snapshot test green, since a describe that prints nothing gives no snapshots).

- [ ] **Step 5: Commit**

```bash
git add infra/ci/lab-aws-safety-net.sh infra/ci/lab-unblock-aws.sh infra/ci/lab-ready-aws.sh scripts/test/lab-aws-cleanup.test.mjs scripts/test/lab-aws-pipeline.test.mjs scripts/test/aws-labs-iam.test.mjs
git commit -m "feat(aws labs): clean-up for batch 3: EKS, global tables, EFS, ElastiCache, API Gateway, Cognito, Step Functions, buses, streams, Glue, Athena, AMI copies; Unblock removes Kubernetes-made load balancers; ElastiCache fails fast

Claude-Session: https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D"
```

---
### Task 5: Worker: API Gateway ARNs, us-east-1 reads for DNS labs, a two-region diagram's budget

Spec: §6 (catalogue and API: resources from tags; topology at most 14 calls), §10 (resources panel, live diagram), rulings P2, P5.

**Files:**
- Modify: `worker/src/labs/awsReads.ts` (`arnParts` reads API Gateway's path ARNs)
- Modify: `worker/src/labs/resources.ts` (regions: `readsUsEast1`; the us-east-1 group's label)
- Modify: `worker/src/labs/awsTopology.ts` (`readsUsEast1`; `AWS_TOPOLOGY_CALLS_MAX` 14 → 15; header)
- Test: `worker/test/labs-aws-reads.test.ts`, `worker/test/topology-aws.test.ts`

**Interfaces:**
- Consumes: Task 1's `readsUsEast1`. Produces: `arnParts("arn:aws:apigateway:eu-west-2::/apis/<id>")` = `{ service: "apigateway", type: "apis", id }` (and `type: "stages", id: "<api>/<stage>"` for a stage), so a tagged API names as `apigateway:apis <id>` in the resources panel, the orphan sweep and the live diagram (Task 6 maps the type).

**`worker/src/labs/awsReads.ts`**, `arnParts`, after `const resource = …`:
```ts
  // Ruling P2: API Gateway's resource is a path, /apis/<id>[/stages/<name>]: the last collection named is the type.
  if (service === "apigateway" && resource.startsWith("/")) {
    const seg = resource.slice(1).split("/");
    if (seg[0] === "apis" && seg[2] === "stages" && seg[3]) return { service, type: "stages", id: `${seg[1]}/${seg.slice(3).join("/")}` };
    return { service, type: seg[0] ?? "", id: seg.slice(1).join("/") };
  }
```
**`worker/src/labs/resources.ts`**: import `readsUsEast1` (and drop the then-unused `AWS_GLOBAL_LABS` only if nothing else uses it); the regions line becomes `const regions = [AWS_LAB_REGIONS[0], ...(def.regions.secondary ? [def.regions.secondary] : []), ...(readsUsEast1(def.id) ? ["us-east-1"] : [])];` (comment: "A global lab's CloudFront and Route 53 items, and a DNS lab's Route 53 items, are tagged in us-east-1 (rulings P7, P5)."), and the group label `region === "us-east-1" ? \`${labResourceGroupName(def.id)} (global: ${AWS_GLOBAL_LABS.includes(def.id) ? "CloudFront, Route 53" : "Route 53"})\` : …`.
**`worker/src/labs/awsTopology.ts`**: `export const AWS_TOPOLOGY_CALLS_MAX = 15;` with the comment "Calls one live refresh may make: 10 in the lab's region, 4 in its secondary one, 1 in us-east-1 for a global or DNS lab (ruling P5: lab 16 has all three)"; the global block's condition becomes `if (readsUsEast1(labId))` and its comment names rulings P7 and P5.

- [ ] **Step 1: Write the failing tests.** In `worker/test/labs-aws-reads.test.ts` (import `arnParts`, `taggedName` from `../src/labs/awsReads`):
```ts
  it("ruling P2: an API Gateway ARN names its collection as the type", () => {
    expect(arnParts("arn:aws:apigateway:eu-west-2::/apis/a1b2c3")).toEqual({ service: "apigateway", type: "apis", id: "a1b2c3" });
    expect(arnParts("arn:aws:apigateway:eu-west-2::/apis/a1b2c3/stages/$default")).toEqual({ service: "apigateway", type: "stages", id: "a1b2c3/$default" });
    expect(taggedName("arn:aws:apigateway:eu-west-2::/apis/a1b2c3")).toBe("apigateway:apis a1b2c3");
    expect(arnParts("arn:aws:dynamodb:eu-west-1:123456789012:table/lab-saa-16-dr-pilot-light-orders")).toEqual({ service: "dynamodb", type: "table", id: "lab-saa-16-dr-pilot-light-orders" });
  });

  it("ruling P5: a DNS lab's resources come from London, Ireland and us-east-1", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    await runningLab(env, world, "saa-16-dr-pilot-light");
    const tag = (Name: string) => ({ "cloudlabs-lab": "saa-16-dr-pilot-light", Name });
    world.labAws.tagged["eu-west-2"] = [{ arn: "arn:aws:ec2:eu-west-2:123456789012:instance/i-0app", tags: tag("vm-app") }];
    world.labAws.tagged["eu-west-1"] = [{ arn: "arn:aws:dynamodb:eu-west-1:123456789012:table/lab-saa-16-dr-pilot-light-orders", tags: tag("table-orders") }];
    world.labAws.tagged["us-east-1"] = [{ arn: "arn:aws:route53:::hostedzone/Z0LAB", tags: tag("zone-dr") }];
    const r = await api(env, "GET", "/labs/saa-16-dr-pilot-light");
    expect(r.json.resources).toEqual([
      { name: "vm-app", type: "ec2:instance", group: "lab-saa-16-dr-pilot-light (London)", state: null },
      { name: "table-orders", type: "dynamodb:table", group: "lab-saa-16-dr-pilot-light (Ireland)", state: null },
      { name: "zone-dr", type: "route53:hostedzone", group: "lab-saa-16-dr-pilot-light (global: Route 53)", state: null },
    ]);
  });
```
(`withAwsLabs()` already holds a `saa-16-dr-pilot-light` with `regions.secondary = "eu-west-1"`.)
In `worker/test/topology-aws.test.ts`, beside the P7 test:
```ts
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
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run worker/test/labs-aws-reads.test.ts worker/test/topology-aws.test.ts`
Expected: FAIL (`type: ""` for API Gateway; no us-east-1 read for lab 16; the cap is 14).

- [ ] **Step 3: Write the changes** above.

- [ ] **Step 4: Run the targeted tests**

Run: `npx vitest run worker/test/labs-aws-reads.test.ts worker/test/topology-aws.test.ts && npm run typecheck`
Expected: PASS (the P7 test unchanged: a global lab still reads us-east-1, labelled "CloudFront, Route 53").

- [ ] **Step 5: Commit**

```bash
git add worker/src/labs/awsReads.ts worker/src/labs/resources.ts worker/src/labs/awsTopology.ts worker/test/labs-aws-reads.test.ts worker/test/topology-aws.test.ts
git commit -m "feat(aws labs): Worker reads API Gateway ARNs and a DNS lab's us-east-1 tags; a two-region diagram fits 15 calls

Claude-Session: https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D"
```

---

### Task 6: Topology: batch 3's types on the planned and live diagrams

Spec: §10 (topology kinds), rulings A35, A77, P20.

**Files:**
- Modify: `shared/topology/rules/awsPlanned.ts` (batch 3's Terraform types)
- Modify: `shared/topology/kinds.ts` (`messaging` gains `events:event-bus` / `aws_cloudwatch_event_bus`; `aks` gains `eks:nodegroup` / `aws_eks_node_group`)
- Modify: `shared/topology/awsLive.ts` (`AWS_LIVE_SKIP` gains `apigateway:stages` and `elasticache:cluster`; a global table's replica folds into its table)
- Test: `worker/test/topology-aws.test.ts`

**Interfaces:**
- Produces: the kinds and keys Tasks 7–15's planned graphs and readme diagrams use: `apigateway:apis`, `cognito-idp:userpool`, `elasticfilesystem:file-system`, `glue:database`, `glue:crawler`, `athena:workgroup`, `ec2:image` (all `generic`); `events:event-bus` (`messaging`); `eks:nodegroup` (`aks`); `elasticache:replicationgroup` (`cache`); `kinesis:stream`, `firehose:deliverystream` (`stream`).

**`shared/topology/rules/awsPlanned.ts`**: `aws_launch_template` becomes `{ arm: "ec2:launch-template", ...intoReferrer("aws_autoscaling_group", "aws_eks_node_group") }`; `aws_sns_topic_subscription` becomes
```ts
  aws_sns_topic_subscription: {
    fold: ["topic_arn"],
    edges: (i, h) => {
      const topic = h.refs(i, ["topic_arn"])[0];
      return topic ? h.refs(i, ["endpoint"]).filter((t) => t !== topic).map((t) => ({ from: topic, to: t, kind: "dependency" as const, label: "fan-out" })) : [];
    },
  },
```
and, before the Systems Manager block:
```ts
  // ── Batch 3 (labs 11–19; ruling P20) ──
  aws_elasticache_replication_group: { arm: "elasticache:replicationgroup", props: (i) => ({ size: str(i.after.node_type) }) },
  aws_elasticache_subnet_group: intoReferrer("aws_elasticache_replication_group"),
  aws_apigatewayv2_api: { arm: "apigateway:apis" },
  ...each(["aws_apigatewayv2_stage", "aws_apigatewayv2_route", "aws_apigatewayv2_authorizer"], into("api_id")),
  aws_apigatewayv2_integration: {
    fold: ["api_id"],
    edges: (i, h) => {
      const api = h.refs(i, ["api_id"])[0];
      return api ? h.refs(i, ["integration_uri"]).filter((t) => t.type === "aws_lambda_function").map((t) => ({ from: api, to: t, kind: "traffic" as const, label: "HTTPS" })) : [];
    },
  },
  aws_cognito_user_pool: { arm: "cognito-idp:userpool" },
  ...each(["aws_cognito_user_pool_client", "aws_cognito_user"], into("user_pool_id")),
  aws_cloudwatch_event_bus: { arm: "events:event-bus" },
  aws_efs_file_system: { arm: "elasticfilesystem:file-system" },
  aws_efs_mount_target: into("file_system_id"),
  aws_vpc_endpoint_policy: into("vpc_endpoint_id"),
  aws_ami_copy: { arm: "ec2:image" },
  aws_kinesis_stream: { arm: "kinesis:stream" },
  aws_kinesis_firehose_delivery_stream: {
    arm: "firehose:deliverystream",
    edges: (i, h) => [
      ...h.refs(i, ["kinesis_source_configuration"]).filter((t) => t.type === "aws_kinesis_stream").map((t) => ({ from: t, to: i, kind: "dependency" as const, label: "reads" })),
      ...h.refs(i, ["extended_s3_configuration"]).filter((t) => t.type === "aws_s3_bucket").map((t) => ({ from: i, to: t, kind: "dependency" as const, label: "delivers" })),
    ],
  },
  aws_glue_catalog_database: { arm: "glue:database" },
  aws_glue_crawler: { arm: "glue:crawler", edges: (i, h) => h.refs(i, ["database_name"]).filter((t) => t.type === "aws_glue_catalog_database").map((t) => ({ from: i, to: t, kind: "dependency" as const, label: "catalogues" })) },
  aws_athena_workgroup: { arm: "athena:workgroup" },
  aws_eks_cluster: { arm: "eks:cluster" },
  aws_eks_node_group: { arm: "eks:nodegroup", props: (i) => ({ size: str(list(i.after.instance_types)[0]), instances: num(obj(list(i.after.scaling_config)[0]).desired_size) }) },
```
**`shared/topology/kinds.ts`** (the AWS map): `aks: { icon: "eks", types: ["eks:cluster", "eks:nodegroup"], tf: ["aws_eks_cluster", "aws_eks_node_group"] }` and `messaging`'s `types` gain `"events:event-bus"`, its `tf` `"aws_cloudwatch_event_bus"`.
**`shared/topology/awsLive.ts`**: `AWS_LIVE_SKIP` gains `"apigateway:stages"` and `"elasticache:cluster"` (each goes with its API or replication group, which the plan draws); and before `const kept`:
```ts
  // Ruling P20: a global table's replica (the same name, the secondary region) folds into its table, as the plan draws one card.
  const primaryTables = new Set(rows.filter((r) => r.type === "dynamodb:table" && regionKind(r) === "primary").map((r) => r.id));
  const replica = (r: AwsRow) => r.type === "dynamodb:table" && regionKind(r) === "secondary" && primaryTables.has(r.id);
```
with `&& !replica(r)` added to `kept`'s filter.

- [ ] **Step 1: Write the failing tests** in `worker/test/topology-aws.test.ts`:
```ts
describe("batch 3's types on the diagrams", () => {
  const b3 = (labId: string, changes: ReturnType<typeof ch>[], refs: Record<string, Record<string, string[]>>) => plannedGraph({ labId, version: 1, number: labId.slice(4, 6), changes: [ch("aws_resourcegroups_group.lab", { name: `lab-${labId}` }), ...changes], outputs: {}, refs } as never);
  const kindOf = (g: { nodes: { key: string; kind: string }[] }, k: string) => g.nodes.find((n) => n.key === k)?.kind;
  const edge = (g: { nodes: { key: string; id: string }[]; edges: { from: string; to: string; label?: string }[] }, a: string, b: string, label: string) => {
    const nid = (k: string) => g.nodes.find((n) => n.key === k)?.id;
    return g.edges.some((e) => e.from === nid(a) && e.to === nid(b) && e.label === label);
  };

  it("an HTTP API's pieces fold in and its integration draws the API's edge to the function; Cognito's client and user fold into the pool", () => {
    const g = b3("saa-12-serverless-api", [
      ch("aws_apigatewayv2_api.lab", { name: "lab-saa-12-serverless-api", tags: { Name: "api-lab" } }),
      ch("aws_apigatewayv2_stage.default", { name: "$default" }),
      ch("aws_apigatewayv2_route.items_get", { route_key: "GET /items" }),
      ch("aws_apigatewayv2_integration.api", { integration_type: "AWS_PROXY" }),
      ch("aws_lambda_function.api", { function_name: "lab-saa-12-serverless-api-api", tags: { Name: "fn-api" } }),
      ch("aws_cognito_user_pool.users", { name: "lab-saa-12-serverless-api-users", tags: { Name: "pool-users" } }),
      ch("aws_cognito_user_pool_client.cli", { name: "cli" }),
      ch("aws_cognito_user.labuser", { username: "labuser" }),
      ch("aws_dynamodb_table.items", { name: "lab-saa-12-serverless-api-items", tags: { Name: "table-items" } }),
    ], {
      "aws_apigatewayv2_stage.default": { api_id: ["aws_apigatewayv2_api.lab"] },
      "aws_apigatewayv2_route.items_get": { api_id: ["aws_apigatewayv2_api.lab"] },
      "aws_apigatewayv2_integration.api": { api_id: ["aws_apigatewayv2_api.lab"], integration_uri: ["aws_lambda_function.api"] },
      "aws_cognito_user_pool_client.cli": { user_pool_id: ["aws_cognito_user_pool.users"] },
      "aws_cognito_user.labuser": { user_pool_id: ["aws_cognito_user_pool.users"] },
    });
    expect(g.nodes.map((n) => n.key).filter((k) => /^apigateway|^cognito/.test(k)).sort()).toEqual(["apigateway:apis/api-lab", "cognito-idp:userpool/pool-users"]);
    expect([kindOf(g, "apigateway:apis/api-lab"), kindOf(g, "cognito-idp:userpool/pool-users"), kindOf(g, "lambda:function/fn-api"), kindOf(g, "dynamodb:table/table-items")]).toEqual(["generic", "generic", "lambda", "dynamodb"]);
    expect(edge(g, "apigateway:apis/api-lab", "lambda:function/fn-api", "HTTPS")).toBe(true);
  });

  it("a topic fans out to its queues; a bus is messaging; a stream feeds Firehose, which delivers to the bucket; the crawler catalogues its database", () => {
    const g = b3("saa-17-data-pipeline", [
      ch("aws_sns_topic.orders", { name: "lab-x-orders", tags: { Name: "topic-orders" } }),
      ch("aws_sqs_queue.billing", { name: "lab-x-billing", tags: { Name: "queue-billing" } }),
      ch("aws_sns_topic_subscription.billing", { protocol: "sqs" }),
      ch("aws_cloudwatch_event_bus.bus", { name: "lab-x-bus", tags: { Name: "bus-orders" } }),
      ch("aws_kinesis_stream.events", { name: "lab-x-events", tags: { Name: "stream-events" } }),
      ch("aws_kinesis_firehose_delivery_stream.to_s3", { name: "lab-x-to-s3", tags: { Name: "firehose-to-s3" } }),
      ch("aws_s3_bucket.lake", { bucket: "cloudlabs-a17k3x9q-lake", tags: { Name: "lake" } }),
      ch("aws_glue_catalog_database.lake", { name: "lab_x", tags: { Name: "glue-lake" } }),
      ch("aws_glue_crawler.events", { name: "lab-x-events", tags: { Name: "crawler-events" } }),
      ch("aws_athena_workgroup.wg", { name: "lab-x-wg", tags: { Name: "athena-wg" } }),
    ], {
      "aws_sns_topic_subscription.billing": { topic_arn: ["aws_sns_topic.orders"], endpoint: ["aws_sqs_queue.billing"] },
      "aws_kinesis_firehose_delivery_stream.to_s3": { kinesis_source_configuration: ["aws_kinesis_stream.events"], extended_s3_configuration: ["aws_s3_bucket.lake"] },
      "aws_glue_crawler.events": { database_name: ["aws_glue_catalog_database.lake"] },
    });
    expect(edge(g, "sns:topic/topic-orders", "sqs:queue/queue-billing", "fan-out")).toBe(true);
    expect(kindOf(g, "events:event-bus/bus-orders")).toBe("messaging");
    expect([kindOf(g, "kinesis:stream/stream-events"), kindOf(g, "firehose:deliverystream/firehose-to-s3")]).toEqual(["stream", "stream"]);
    expect(edge(g, "kinesis:stream/stream-events", "firehose:deliverystream/firehose-to-s3", "reads") && edge(g, "firehose:deliverystream/firehose-to-s3", "s3:bucket/lake", "delivers")).toBe(true);
    expect(edge(g, "glue:crawler/crawler-events", "glue:database/glue-lake", "catalogues")).toBe(true);
    expect(kindOf(g, "athena:workgroup/athena-wg")).toBe("generic");
  });

  it("EKS: the cluster and its node group are aks and the launch template folds into the node group; ElastiCache is cache; EFS's mount targets fold in", () => {
    const g = b3("saa-19-eks", [
      ch("aws_eks_cluster.lab", { name: "lab-saa-19-eks", tags: { Name: "eks-lab" } }),
      ch("aws_launch_template.node", { name: "lt-a19k3x9q", tags: { Name: "lt-node" } }),
      ch("aws_eks_node_group.lab", { node_group_name: "lab-saa-19-eks-ng", instance_types: ["t4g.medium"], scaling_config: [{ desired_size: 1 }], tags: { Name: "ng-lab" } }),
      ch("aws_elasticache_replication_group.app", { replication_group_id: "ca11k3x9q", node_type: "cache.t4g.micro", tags: { Name: "cache-app" } }),
      ch("aws_elasticache_subnet_group.data", { name: "lab-x-cache", tags: { Name: "cache-subnets" } }),
      ch("aws_efs_file_system.shared", { tags: { Name: "efs-shared" } }),
      ch("aws_efs_mount_target.shared[0]", {}),
    ], {
      "aws_eks_node_group.lab": { cluster_name: ["aws_eks_cluster.lab"], launch_template: ["aws_launch_template.node"] },
      "aws_elasticache_replication_group.app": { subnet_group_name: ["aws_elasticache_subnet_group.data"] },
      "aws_efs_mount_target.shared": { file_system_id: ["aws_efs_file_system.shared"] },
    });
    const keys = g.nodes.map((n) => n.key);
    expect([kindOf(g, "eks:cluster/eks-lab"), kindOf(g, "eks:nodegroup/ng-lab"), kindOf(g, "elasticache:replicationgroup/cache-app"), kindOf(g, "elasticfilesystem:file-system/efs-shared")]).toEqual(["aks", "aks", "cache", "generic"]);
    expect(keys.some((k) => k.includes("launch-template") || k.includes("subnetgroup") || k.includes("mount"))).toBe(false);
    expect(g.nodes.find((n) => n.key === "eks:nodegroup/ng-lab")).toMatchObject({ props: { size: "t4g.medium", instances: 1 } });
  });

  it("ruling P20: live, a global table's Ireland replica folds into its London table; an API's stage and a group's member cluster are left out", () => {
    const row = (type: string, id: string, region: string, tags: Record<string, string> = {}): AwsRow => ({ arn: `arn:aws:${type.split(":")[0]}:${region}:123456789012:${type.split(":")[1]}/${id}`, type, id, region, name: tags.Name ?? null, tags: { "cloudlabs-lab": "saa-16-dr-pilot-light", ...tags }, props: {}, refs: {} });
    const g = awsLiveGraph([
      row("resource-groups:group", "lab-saa-16-dr-pilot-light", "eu-west-2", { Name: "lab-saa-16-dr-pilot-light" }),
      row("resource-groups:group", "lab-saa-16-dr-pilot-light", "eu-west-1", { Name: "lab-saa-16-dr-pilot-light" }),
      row("dynamodb:table", "lab-saa-16-dr-pilot-light-orders", "eu-west-2", { Name: "table-orders" }),
      row("dynamodb:table", "lab-saa-16-dr-pilot-light-orders", "eu-west-1", { Name: "table-orders" }),
      row("apigateway:stages", "a1/$default", "eu-west-2"),
      row("elasticache:cluster", "ca11k3x9q-001", "eu-west-2"),
    ], { labId: "saa-16-dr-pilot-light", version: 1, gatewayVpcIds: [], at: "2026-10-16T00:00:00Z", region: "eu-west-2", secondaryRegion: "eu-west-1" });
    const keys = g.nodes.map((n) => n.key);
    expect(keys.filter((k) => k.startsWith("dynamodb:table"))).toEqual(["dynamodb:table/table-orders"]);
    expect(keys.some((k) => k.startsWith("apigateway:stages") || k.startsWith("elasticache:cluster"))).toBe(false);
    expect(kindOfAws("events:event-bus")).toBe("messaging");
    expect(kindOfAws("eks:nodegroup")).toBe("aks");
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run worker/test/topology-aws.test.ts`
Expected: FAIL (the batch 3 types are generic Terraform-only cards; no fan-out, reads, delivers or catalogues edges; the replica is drawn twice).

- [ ] **Step 3: Write the rules, kinds and live fold** above.

- [ ] **Step 4: Run the targeted tests**

Run: `npx vitest run worker/test/topology-aws.test.ts worker/test/topology-golden.test.ts && npm run typecheck`
Expected: PASS (the golden diagrams of batches 1–2 unchanged: their launch templates still fold into their groups).

- [ ] **Step 5: Commit**

```bash
git add shared/topology/rules/awsPlanned.ts shared/topology/kinds.ts shared/topology/awsLive.ts worker/test/topology-aws.test.ts
git commit -m "feat(aws labs): batch 3's types on the planned and live diagrams

Claude-Session: https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D"
```

---
### Task 7: Lab saa-11-three-tier

Spec: §12.2 row 11 (resilient, performance; associate; explore; £ 0.13; peering optional; 20/15; 2/4; prerequisites 03, 05; ALB, ASG (2), RDS MySQL Multi-AZ, ElastiCache, NAT gateway); §4 (NAT only where a lab needs it); §7.4; rulings A20, A34, A45, P16, P17.

**Files:**
- Create: `labs/saa-11-three-tier/lab.yaml`, `readme.md`
- Create: `labs/saa-11-three-tier/terraform/versions.tf`, `main.tf`, `network.tf` (copied unchanged), `variables.tf` (the template's `lab_id`, `name_prefix`, `region`, `address_space`, `gateway_cidr`, `admin_password`, `tags`), `public.tf` (soa-03's, unchanged in content), `alb.tf` (soa-03's, unchanged in content), `nat.tf` (soa-10's, unchanged in content), `app.tf`, `data.tf`, `outputs.tf`
- Create: `labs/_learning/saa-11-three-tier.yaml`, `scripts/test/fixtures/labs/plans/labs/saa-11-three-tier.mjs`
- Create (generated): `shared/topology/planned/saa-11-three-tier.json`, `shared/guides/saa-11-three-tier/**`
- Modify: `worker/test/topology-golden.test.ts`, `worker/test/fixtures/topology/round-trip.ts`
- Test: `scripts/test/labs-aws-saa-11.test.mjs`

**Interfaces:**
- Consumes: the template network; soa-03's `public.tf` and `alb.tf`, soa-10's `nat.tf` (each copied, its header's first line naming lab 11); Task 3 (ElastiCache, public database rules); Task 4 (ElastiCache handlers, fail-fast); Task 6 (ElastiCache card).

**`labs/saa-11-three-tier/lab.yaml`**
```yaml
# Lab saa-11 (AWS labs batch 3). SAA-C03 ((V) the wording against the current
# exam guide): Design Resilient Architectures (a tier per job, Multi-AZ, an
# Auto Scaling group behind a load balancer); Design High-Performing
# Architectures (a cache in front of the database).
# London list prices × 0.75 (labs-verify --aws-prices); the NAT gateway and the
# ALB bill each started hour whole (V, A20). ElastiCache for Valkey's price
# filter is (V): if labs-verify finds no single product the item becomes
# authored-only (Task 16). RDS and ElastiCache bill by the second.
id: saa-11-three-tier
version: 1
cloud: aws
title: "Three-tier web app across two AZs"
summary: >-
  A web tier behind an internet-facing load balancer, an app tier of two instances in an Auto Scaling group, and a
  data tier of RDS MySQL Multi-AZ and an ElastiCache node, each in its own subnets across two Availability Zones.
exam: SAA-C03
skill_areas: [saa.resilient, saa.performance]
level: associate
type: explore
prerequisites: [soa-03-auto-scaling, soa-05-rds]
cost:
  items:
    - name: "NAT gateway, hourly"
      gbp_h: 0.0375
      whole_hours: true
      aws_price: { service: AmazonEC2, unit: Hrs, filters: { productFamily: "NAT Gateway", usagetype: "{usage}-NatGateway-Hours" } }
    - name: "Application Load Balancer, hourly"
      gbp_h: 0.0199
      whole_hours: true
      aws_price: { service: AWSELB, unit: Hrs, filters: { productFamily: "Load Balancer-Application", usagetype: "{usage}-LoadBalancerUsage" } }
    - { name: "ALB capacity units, light test traffic", gbp_h: 0.0060 }
    - name: "Public IPv4 addresses (the ALB's 2 and the NAT gateway's)"
      gbp_h: 0.0038
      qty: 3
      aws_price: { service: AmazonVPC, unit: Hrs, filters: { group: VPCPublicIPv4Address, usagetype: "{usage}-PublicIPv4:InUseAddress" } }
    - name: "EC2 t4g.micro, Linux (2 running)"
      gbp_h: 0.0071
      qty: 2
      aws_price: { service: AmazonEC2, unit: Hrs, filters: { instanceType: t4g.micro, operatingSystem: Linux, tenancy: Shared, preInstalledSw: NA, capacitystatus: Used } }
    - name: "EBS gp3 root volume, 8 GiB"
      gbp_h: 0.0008
      qty: 2
      aws_price: { service: AmazonEC2, unit: GB-Mo, gb: 8, filters: { productFamily: Storage, volumeApiName: gp3 } }
    - name: "RDS for MySQL db.t4g.micro, Multi-AZ (primary and standby)"
      gbp_h: 0.0270
      aws_price: { service: AmazonRDS, unit: Hrs, filters: { instanceType: db.t4g.micro, databaseEngine: MySQL, deploymentOption: Multi-AZ } }
    - name: "RDS General Purpose (gp2) storage, 20 GiB, Multi-AZ"
      gbp_h: 0.0055
      aws_price: { service: AmazonRDS, unit: GB-Mo, gb: 20, filters: { productFamily: Database Storage, volumeType: General Purpose, databaseEngine: MySQL, deploymentOption: Multi-AZ } }
    - name: "ElastiCache for Valkey cache.t4g.micro, one node"
      gbp_h: 0.0107
      aws_price: { service: AmazonElastiCache, unit: Hrs, filters: { instanceType: cache.t4g.micro, cacheEngine: Valkey } }
    - { name: "EC2 Instance Connect Endpoint", gbp_h: 0 }
  pricey: null
timing: { deploy_min: 20, destroy_min: 15, session_h: 2, max_h: 4 }
capacity: { instance_types: [t4g.micro, t4g.micro, t4g.micro, t4g.micro] }
regions: { secondary: null }
connectivity: { peering: optional, dns_link: false, subnets_used: 1 }
identity:
  creates: []
  roles: []
  governance: false
```

**`public.tf`**, **`alb.tf`**, **`nat.tf`**: soa-03's `public.tf` and `alb.tf` and soa-10's `nat.tf`, with each header's first sentence naming lab 11 (`alb.tf`'s second sentence "the group's instances" stays: lab 11's app tier is the group).

**`labs/saa-11-three-tier/terraform/app.tf`**
```hcl
# app.tf
#
# Plain English: lab 11's web and app tier. A launch template (Amazon Linux
# 2023, t4g.micro, IMDSv2, the lab's tags at launch) and an Auto Scaling group
# of 2 (up to 4) across the two private subnets, registered with the load
# balancer and replaced when it says unhealthy. Each instance installs the
# MariaDB and Valkey/Redis clients (through the S3 endpoint and the NAT
# gateway) and serves a page naming itself, its zone, and the database and
# cache it uses, so the group starts once both exist.

locals {
  app_page = join("\n", [
    "#!/bin/sh",
    "T=$(curl -s -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 300')",
    "md() { curl -s -H \"X-aws-ec2-metadata-token: $T\" http://169.254.169.254/latest/meta-data/$1; }",
    "mkdir -p /srv/www",
    "{ echo \"app instance $(md instance-id) in $(md placement/availability-zone)\"; echo 'database ${aws_db_instance.app.address}'; echo 'cache ${aws_elasticache_replication_group.app.primary_endpoint_address}'; } > /srv/www/index.html",
    "",
  ])
  app_unit = join("\n", [
    "[Unit]",
    "Description=Lab 11 app page on port 80",
    "After=network-online.target",
    "[Service]",
    "ExecStartPre=/usr/local/bin/lab-page",
    "ExecStart=/usr/bin/python3 -m http.server 80 --directory /srv/www",
    "Restart=always",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ])
  app_cloud_init = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [
      { path = "/usr/local/bin/lab-page", permissions = "0755", content = local.app_page },
      { path = "/etc/systemd/system/lab-app.service", permissions = "0644", content = local.app_unit },
    ]
    runcmd = ["systemctl daemon-reload", "systemctl enable --now lab-app.service", "dnf install -y mariadb105 valkey || dnf install -y mariadb105 redis6 || true"]
  }))}"
}

resource "aws_launch_template" "app" {
  name                   = "lt-${var.name_prefix}"
  image_id               = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.micro"
  vpc_security_group_ids = [aws_security_group.vms.id]
  user_data              = base64encode(local.app_cloud_init)
  update_default_version = true

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size           = 8
      volume_type           = "gp3"
      delete_on_termination = true
    }
  }
  tag_specifications {
    resource_type = "instance"
    tags          = merge(var.tags, { Name = "vm-app" })
  }
  tag_specifications {
    resource_type = "volume"
    tags          = merge(var.tags, { Name = "vm-app" })
  }
  tag_specifications {
    resource_type = "network-interface"
    tags          = merge(var.tags, { Name = "vm-app" })
  }
  tags = { Name = "lt-app" }
}

resource "aws_autoscaling_group" "web" {
  name                      = "asg-${var.name_prefix}"
  min_size                  = 2
  max_size                  = 4
  desired_capacity          = 2
  vpc_zone_identifier       = aws_subnet.private[*].id
  target_group_arns         = [aws_lb_target_group.web.arn]
  health_check_type         = "ELB"
  health_check_grace_period = 180
  force_delete              = true
  wait_for_capacity_timeout = "10m"

  launch_template {
    id      = aws_launch_template.app.id
    version = aws_launch_template.app.latest_version
  }
  tag {
    key                 = "cloudlabs-lab"
    value               = var.lab_id
    propagate_at_launch = true
  }
  tag {
    key                 = "cloudlabs-session"
    value               = var.tags["cloudlabs-session"]
    propagate_at_launch = true
  }
  tag {
    key                 = "project"
    value               = var.tags["project"]
    propagate_at_launch = true
  }
  tag {
    key                 = "Name"
    value               = "vm-app"
    propagate_at_launch = true
  }
  depends_on = [aws_vpc_endpoint.s3, aws_lb_listener.http, aws_route.private_nat]
}
```

**`labs/saa-11-three-tier/terraform/data.tf`**
```hcl
# data.tf
#
# Plain English: lab 11's data tier, in two subnets of its own (the slot's
# /24s 2 and 3) with no route to the internet: RDS for MySQL 8.4 on
# db.t4g.micro, Multi-AZ, never publicly accessible (ruling P16), and one
# ElastiCache for Valkey node, encrypted at rest (ruling P17). Each admits
# only the app tier's security group and, once peered, the VPN server's
# range. Nothing lingers: no final snapshot, no deletion protection,
# automated backups deleted with the database.

resource "aws_subnet" "data" {
  count                   = 2
  vpc_id                  = aws_vpc.lab.id
  cidr_block              = cidrsubnet(local.vpc_cidr, 4, 2 + count.index)
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-data-${count.index + 1}" }
}

resource "aws_route_table" "data" {
  vpc_id = aws_vpc.lab.id
  tags   = { Name = "rt-data" }
}

resource "aws_route_table_association" "data" {
  count          = 2
  subnet_id      = aws_subnet.data[count.index].id
  route_table_id = aws_route_table.data.id
}

resource "aws_security_group" "db" {
  name        = "lab-db"
  description = "MySQL from the app tier and, when peered, the gateway"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-db" }
}

resource "aws_vpc_security_group_ingress_rule" "db_from_app" {
  security_group_id            = aws_security_group.db.id
  referenced_security_group_id = aws_security_group.vms.id
  ip_protocol                  = "tcp"
  from_port                    = 3306
  to_port                      = 3306
}

resource "aws_vpc_security_group_ingress_rule" "db_from_gateway" {
  security_group_id = aws_security_group.db.id
  cidr_ipv4         = var.gateway_cidr
  ip_protocol       = "tcp"
  from_port         = 3306
  to_port           = 3306
}

resource "aws_security_group" "cache" {
  name        = "lab-cache"
  description = "Valkey from the app tier and, when peered, the gateway"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-cache" }
}

resource "aws_vpc_security_group_ingress_rule" "cache_from_app" {
  security_group_id            = aws_security_group.cache.id
  referenced_security_group_id = aws_security_group.vms.id
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
}

resource "aws_vpc_security_group_ingress_rule" "cache_from_gateway" {
  security_group_id = aws_security_group.cache.id
  cidr_ipv4         = var.gateway_cidr
  ip_protocol       = "tcp"
  from_port         = 6379
  to_port           = 6379
}

resource "aws_db_subnet_group" "data" {
  name       = "lab-${var.lab_id}-data"
  subnet_ids = aws_subnet.data[*].id
  tags       = { Name = "lab-data" }
}

resource "aws_db_instance" "app" {
  identifier                   = "db-${var.name_prefix}"
  engine                       = "mysql"
  engine_version               = "8.4"
  instance_class               = "db.t4g.micro"
  allocated_storage            = 20
  storage_type                 = "gp2"
  storage_encrypted            = true
  multi_az                     = true
  db_name                      = "appdb"
  username                     = "labadmin"
  password                     = var.admin_password
  db_subnet_group_name         = aws_db_subnet_group.data.name
  vpc_security_group_ids       = [aws_security_group.db.id]
  publicly_accessible          = false
  backup_retention_period      = 1
  skip_final_snapshot          = true
  deletion_protection          = false
  delete_automated_backups     = true
  copy_tags_to_snapshot        = true
  performance_insights_enabled = false
  auto_minor_version_upgrade   = true
  apply_immediately            = true
  tags                         = { Name = "db-app" }
}

resource "aws_elasticache_subnet_group" "data" {
  name       = "lab-${var.lab_id}-cache"
  subnet_ids = aws_subnet.data[*].id
  tags       = { Name = "lab-cache-subnets" }
}

resource "aws_elasticache_replication_group" "app" {
  replication_group_id       = "c${var.name_prefix}"
  description                = "lab ${var.lab_id}: the app tier's cache"
  engine                     = "valkey"
  engine_version             = "8.0"
  node_type                  = "cache.t4g.micro"
  num_cache_clusters         = 1
  port                       = 6379
  subnet_group_name          = aws_elasticache_subnet_group.data.name
  security_group_ids         = [aws_security_group.cache.id]
  at_rest_encryption_enabled = true
  transit_encryption_enabled = false
  automatic_failover_enabled = false
  multi_az_enabled           = false
  snapshot_retention_limit   = 0
  apply_immediately          = true
  tags                       = { Name = "cache-app" }
}
```

**`labs/saa-11-three-tier/terraform/outputs.tf`**
```hcl
# outputs.tf
#
# Plain English: what the dashboard shows once lab 11 is up. The app tier's
# instances come and go, so there are no fixed addresses: the load
# balancer's address, how to find an app instance, and the two data-tier
# commands to run on one (the password is the session's, behind Show).

output "private_ips" {
  value = {}
}

output "connect" {
  value = [
    "curl http://${aws_lb.web.dns_name}",
    "aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names ${aws_autoscaling_group.web.name} --query 'AutoScalingGroups[0].Instances[].InstanceId'",
    "aws ec2-instance-connect ssh --instance-id <an app instance id> --os-user labadmin --connection-type eice",
    "mysql -h ${aws_db_instance.app.address} -u labadmin -p appdb",
    "valkey-cli -h ${aws_elasticache_replication_group.app.primary_endpoint_address} ping",
  ]
}

output "peer_vpc_id" {
  value = aws_vpc.lab.id
}

output "peer_route_table_ids" {
  value = [aws_route_table.private.id, aws_route_table.data.id]
}
```

**`labs/saa-11-three-tier/readme.md`** (exactly):
````markdown
The classic three-tier web application, built the way SAA-C03 expects: a load balancer in public subnets, an app tier of instances in an Auto Scaling group in private subnets, and a data tier of a Multi-AZ MySQL database and a Valkey cache in subnets of their own, each tier across two Availability Zones and each admitting only the tier in front of it. Everything is listed in the lab's resource group, `lab-saa-11-three-tier`, in AWS Resource Groups (London).
From the SAA-C03 outline: design scalable, loosely coupled and highly available architectures, and choose caching and database options for performance.

## What it deploys

- The VPC `vpc-lab` (the slot's first /20) with three pairs of subnets across two zones: public (`snet-public-1/2`) for the load balancer and the NAT gateway `nat-lab`, private (`snet-private-1/2`) for the app tier, and data (`snet-data-1/2`, route table `rt-data` with no way out) for the database and cache
- The load balancer `alb-<name prefix>` (Name `alb-web`): HTTP on port 80 from anywhere, to the app tier
- The app tier: the Auto Scaling group `asg-<name prefix>`, two (up to four) t4g.micro instances `vm-app` that serve a page naming themselves, their zone, the database and the cache
- The database `db-<name prefix>` (Name `db-app`): RDS for MySQL 8.4, db.t4g.micro, Multi-AZ (a standby in the other zone), private, database `appdb`, user `labadmin` with the session's password
- The cache `c<name prefix>` (Name `cache-app`): one ElastiCache for Valkey node, cache.t4g.micro, encrypted at rest
- Security groups that chain the tiers: `sg-alb` to `sg-vms` on port 80, `sg-vms` to `sg-db` on 3306 and to `sg-cache` on 6379

It takes about 20 minutes: the Multi-AZ database is the slow part, and the app tier starts after it so its page can name it.

```text
lab-saa-11-three-tier (London)
  you --HTTP 80--> alb-web (snet-public-1/2) --> asg vm-app x2 (snet-private-1/2) [sg-vms]
  vm-app --3306--> db-app (MySQL Multi-AZ, snet-data-1/2) [sg-db]
  vm-app --6379--> cache-app (Valkey, snet-data-1/2) [sg-cache]
  vm-app --> nat-lab (snet-public-1) --> igw-lab --> packages and updates
  peering (optional, AWS server only) <--> VPN server's VPC <--> WireGuard tunnel <--> you
```

## Things to try

- Load the page a few times with `curl` (the first Connect line) and watch the instance and zone change: the load balancer spreads requests across both zones.
- Connect to an app instance (the third Connect line), run the `mysql` line with the session password, create a table and add a row. Then reboot the database with failover (RDS, the database, Actions, Reboot, "Reboot with failover") and time how long the client cannot write.
- On the same instance run the `valkey-cli` line (or `redis6-cli` if that is the client that installed), then `SET greeting hello EX 60` and `GET greeting`: a cache answers in well under a millisecond, which is why the app tier asks it before the database.
- Terminate one app instance and watch the group replace it in the same zone while the page keeps answering from the other.
- Try to reach the database from your PC without peering: there is no route and no public address. The data tier's route table `rt-data` has no way to the internet at all.

## Learn more

- [Multi-AZ DB instance deployments](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZSingleStandby.html)
- [What is Amazon ElastiCache?](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/WhatIs.html)
- [Use Elastic Load Balancing to distribute traffic across the instances in your Auto Scaling group](https://docs.aws.amazon.com/autoscaling/ec2/userguide/autoscaling-load-balancer.html)
- [NAT gateways](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-nat-gateway.html)
- [Reliability pillar: AWS Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/welcome.html)

Everything this lab builds carries the tag `cloudlabs-lab = saa-11-three-tier` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
````

**`labs/_learning/saa-11-three-tier.yaml`**
```yaml
# Labs catalogue learning content (labs redesign spec §5). Outside the lab folder: editing it never needs a version bump.
objective: Run a three-tier web application across two zones and see what each tier does for resilience and speed.
learn:
  - Separate web, app and data tiers with subnets and chained security groups
  - Fail a Multi-AZ database over while the app tier keeps answering
  - Put a cache in front of a database and compare the two
learning_min: 60
```

**The diagram** must contain: `resourceGroup lab-saa-11-three-tier · London`; `vnet vpc-lab` with `subnet snet-private-1/2`, `snet-public-1/2`, `snet-data-1/2`; `internetGateway igw-lab`; `natGateway nat-lab`; `loadBalancer alb-web` with a `traffic` edge `HTTP 80` to `vmss vm-app`; `sqlServer db-app`; `cache cache-app`; `routeTable rt-private` (a `dependency` edge `0.0.0.0/0` to `nat-lab`), `rt-public`, `rt-data`; `nsg sg-alb`, `sg-vms`, `sg-db`, `sg-cache`, `sg-eice`; `bastion eice-lab`; `privateEndpoint vpce-s3`.

- [ ] **Step 1: Write the failing test** `scripts/test/labs-aws-saa-11.test.mjs`:

```js
// labs-aws-saa-11.test.mjs
//
// Plain English: lab saa-11-three-tier is the lab AWS labs spec §12.2 row 11
// describes: an ALB, an Auto Scaling group of 2, RDS MySQL Multi-AZ and an
// ElastiCache node behind a NAT gateway, each tier in its own subnets
// (rulings P16, P17).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { validateLearning } from "../lib/labs.mjs";

const ID = "saa-11-three-tier";
const body = (p) => readFileSync(fileURLToPath(new URL(`../../labs/${p}`, import.meta.url)), "utf8").replace(/\r\n/g, "\n").split("\n").filter((l) => !l.startsWith("#")).join("\n");

test("saa-11 keeps the AWS lab contract; its public subnets and ALB are soa-03's, its NAT gateway soa-10's", () => {
  assert.deepEqual(commonAwsProblems(ID), []);
  assert.equal(body(`${ID}/terraform/public.tf`), body("soa-03-auto-scaling/terraform/public.tf"));
  assert.equal(body(`${ID}/terraform/alb.tf`), body("soa-03-auto-scaling/terraform/alb.tf"));
  assert.equal(body(`${ID}/terraform/nat.tf`), body("soa-10-containers/terraform/nat.tf"));
});

test("saa-11's lab.yaml: §12.2 row 11, about £0.13/h with the NAT gateway and the ALB billed by the whole hour", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["SAA-C03", "associate", "explore", ["saa.resilient", "saa.performance"], ["soa-03-auto-scaling", "soa-05-rds"]]);
  assert.deepEqual(yaml.timing, { deploy_min: 20, destroy_min: 15, session_h: 2, max_h: 4 });
  assert.deepEqual(yaml.connectivity, { peering: "optional", dns_link: false, subnets_used: 1 });
  assert.deepEqual(yaml.identity, { creates: [], roles: [], governance: false });
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.11 && total < 0.15, `about £0.13/h, got ${total}`);
  for (const n of ["NAT gateway, hourly", "Application Load Balancer, hourly"]) assert.equal(yaml.cost.items.find((i) => i.name === n).whole_hours, true, n);
});

test("saa-11's data tier: private Multi-AZ MySQL, one Valkey node, no route out, each admitting only the app tier", () => {
  const { tf } = awsLab(ID);
  for (const re of [/multi_az\s+= true/, /publicly_accessible\s+= false/, /instance_class\s+= "db\.t4g\.micro"/, /engine\s+= "valkey"/, /node_type\s+= "cache\.t4g\.micro"/, /num_cache_clusters\s+= 1/, /at_rest_encryption_enabled = true/, /snapshot_retention_limit\s+= 0/, /skip_final_snapshot\s+= true/, /cidrsubnet\(local\.vpc_cidr, 4, 2 \+ count\.index\)/]) assert.match(tf, re);
  assert.doesNotMatch(tf, /final_snapshot_identifier/);
  const data = body(`${ID}/terraform/data.tf`);
  assert.doesNotMatch(data, /aws_route"/, "rt-data has no route out");
  assert.equal([...data.matchAll(/referenced_security_group_id = aws_security_group\.vms\.id/g)].length, 2);
});

test("saa-11's app tier: 2 to 4 t4g.micro behind the ALB, started after the data tier and the NAT route", () => {
  const { tf } = awsLab(ID);
  for (const re of [/min_size\s+= 2/, /max_size\s+= 4/, /desired_capacity\s+= 2/, /target_group_arns\s+= \[aws_lb_target_group\.web\.arn\]/, /depends_on = \[aws_vpc_endpoint\.s3, aws_lb_listener\.http, aws_route\.private_nat\]/, /aws_db_instance\.app\.address/, /aws_elasticache_replication_group\.app\.primary_endpoint_address/]) assert.match(tf, re);
  assert.equal([...tf.matchAll(/resource "aws_nat_gateway"/g)].length, 1);
});

test("saa-11's readme names each tier and its learning content is valid", () => {
  const { readme, learning, yaml } = awsLab(ID);
  for (const s of ["snet-data-1/2", "db-app", "cache-app", "alb-web", "Reboot with failover"]) assert.ok(readme.includes(s), s);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test scripts/test/labs-aws-saa-11.test.mjs`
Expected: FAIL (no lab folder).

- [ ] **Step 3: Write the lab**: the files above; copy `versions.tf`, `main.tf`, `network.tf` unchanged, soa-03's `public.tf` and `alb.tf`, soa-10's `nat.tf`; trim `variables.tf` to the seven variables named.

- [ ] **Step 4: Write the plan fixture** `saa-11-three-tier.mjs`: `[...templateResources(c), …]`, soa-03's public subnets, route table, route and associations and ALB pieces (as soa-03's and soa-10's fixtures write them), soa-10's NAT gateway pieces, the launch template and group (as soa-03's fixture, `vm-app`), and the data tier: the data subnets (`cidrsubnet(c.vpcCidr, 4, 2 + i)`), `rt-data` and its associations, `sg-db` and `sg-cache` with their rules, the subnet groups, the database and the replication group. Known at plan: every name built from `var.lab_id`/`var.name_prefix`, the database's and the cache's settings (`publicly_accessible: false`, `num_cache_clusters: 1`); unknown with references: ids, the subnet groups' `subnet_ids`, the security groups, the launch template's `user_data` (it names the database and cache addresses). `lab-plans.test.mjs` proves it.

- [ ] **Step 5: Generate the planned graph and the readme diagram** (`npm run labs-topology -- saa-11-three-tier`, `npm run labs-diagrams -- saa-11-three-tier`), add `GOLDEN["saa-11-three-tier"]` (the diagram list above, as `kind name < container` lines) to `worker/test/topology-golden.test.ts` and the id to `AWS_LAB_IDS` in `worker/test/fixtures/topology/round-trip.ts`.

- [ ] **Step 6: Run the checks**

Run: `node --test scripts/test/labs-aws-saa-11.test.mjs scripts/test/lab-plans.test.mjs scripts/test/labs-readmes.test.mjs scripts/test/labs-diagrams.test.mjs scripts/test/labs-learning-content.test.mjs`, then `npx vitest run worker/test/topology-golden.test.ts`, then `npm run labs-check`, `npm run labs-tf -- saa-11-three-tier`, `npm run labs-topology -- --check saa-11-three-tier`, `npm run labs-diagrams -- --check`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add labs/saa-11-three-tier labs/_learning/saa-11-three-tier.yaml shared/topology/planned/saa-11-three-tier.json shared/guides scripts/test worker/test
git commit -m "feat(aws labs): lab saa-11 three-tier web app across two AZs

Claude-Session: https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D"
```

---
### Task 8: Lab saa-12-serverless-api

Spec: §12.2 row 12 (secure, resilient, performance; associate; explore; £ 0.00; peering off; 4/3; 2/6; no prerequisites; API Gateway HTTP API, JWT authoriser on a Cognito user pool, Lambda, DynamoDB on demand); §7.4 (API Gateway public by nature); rulings A42, A56, A61, P2, P3, P11–P13.

**Files:**
- Create: `labs/saa-12-serverless-api/lab.yaml`, `readme.md`
- Create: `labs/saa-12-serverless-api/terraform/versions.tf`, `main.tf` (copied unchanged; no `network.tf`, ruling A61), `variables.tf` (the template's `lab_id`, `region`, `admin_password`, `tags`), `data.tf`, `function.tf`, `cognito.tf`, `api.tf`, `outputs.tf`, `lambda/api.py`
- Create: `labs/_learning/saa-12-serverless-api.yaml`, `scripts/test/fixtures/labs/plans/labs/saa-12-serverless-api.mjs`
- Create (generated): `shared/topology/planned/saa-12-serverless-api.json`, `shared/guides/saa-12-serverless-api/**`
- Modify: `worker/test/topology-golden.test.ts`, `worker/test/fixtures/topology/round-trip.ts`
- Test: `scripts/test/labs-aws-saa-12.test.mjs`

**Interfaces:**
- Consumes: Task 2 (P2's API Gateway verbs, P3's table names), Task 3 (API, Cognito, Lambda-source rules), Task 4 (API, pool and table handlers), Task 5 (API Gateway ARNs), Task 6 (API, pool, function, table cards).

**`labs/saa-12-serverless-api/lab.yaml`**
```yaml
# Lab saa-12 (AWS labs batch 3). SAA-C03 ((V) the wording against the current
# exam guide): Design Secure Architectures (a JWT authoriser on a Cognito user
# pool), Design Resilient Architectures and Design High-Performing
# Architectures (managed, scale-to-zero services; DynamoDB on demand).
# Everything here bills per request: an idle hour is free, and a session of
# Things to try stays inside the free tiers (authored figures, V: Lambda
# arm64, HTTP API, DynamoDB on demand and Cognito Lite, London).
id: saa-12-serverless-api
version: 1
cloud: aws
title: "Serverless API with Cognito sign-in"
summary: >-
  An API Gateway HTTP API in front of a Lambda function and a DynamoDB table, with a JWT authoriser that lets in only
  users of the lab's own Cognito user pool: sign in from CloudShell, call the API, see your name on what you stored.
exam: SAA-C03
skill_areas: [saa.secure, saa.resilient, saa.performance]
level: associate
type: explore
prerequisites: []
cost:
  items:
    - { name: "API Gateway HTTP API requests (a few hundred)", gbp_h: 0.0001 }
    - { name: "Lambda arm64, 128 MB, a few hundred calls", gbp_h: 0.0001 }
    - { name: "DynamoDB on demand: reads, writes and a few kB stored", gbp_h: 0.0001 }
    - { name: "Cognito user pool, Lite tier (one user, inside the free allowance)", gbp_h: 0 }
    - { name: "CloudWatch Logs (one day)", gbp_h: 0.0001 }
  pricey: null
timing: { deploy_min: 4, destroy_min: 3, session_h: 2, max_h: 6 }
capacity: { instance_types: [] }
regions: { secondary: null }
connectivity: { peering: off, dns_link: false, subnets_used: 0 }
identity:
  creates: [role]
  roles: []
  governance: false
```

**`labs/saa-12-serverless-api/terraform/data.tf`**
```hcl
# data.tf
#
# Plain English: lab 12's table, lab-<id>-items: DynamoDB on demand (billed
# per request, nothing while idle; ruling P12), keyed by an id, deletable at
# tear-down. Named lab-<id>-* so the safety net also finds it by name
# (ruling P3).

resource "aws_dynamodb_table" "items" {
  name                        = "lab-${var.lab_id}-items"
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "id"
  deletion_protection_enabled = false

  attribute {
    name = "id"
    type = "S"
  }
  tags = { Name = "table-items" }
}
```

**`labs/saa-12-serverless-api/terraform/function.tf`**
```hcl
# function.tf
#
# Plain English: lab 12's function, lab-<id>-api (Python 3.13 on arm64, 128 MB),
# logging to /cloudlabs/<id>/api for one day (ruling A56), running as
# lab-<id>-api under the lab boundary: allowed only to scan, read and write
# the lab's own table. API Gateway may invoke it only for the lab's own API
# (ruling P13), after a 20-second wait for the function's tags (ruling P11).

locals {
  table_arn = "arn:${data.aws_partition.current.partition}:dynamodb:${var.region}:${data.aws_caller_identity.current.account_id}:table/lab-${var.lab_id}-items"
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/cloudlabs/${var.lab_id}/api"
  retention_in_days = 1
}

resource "aws_iam_role" "api" {
  name                 = "lab-${var.lab_id}-api"
  path                 = "/cloudlabs-lab/"
  permissions_boundary = local.boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "api_logs" {
  role       = aws_iam_role.api.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_policy" "api" {
  name = "lab-${var.lab_id}-api"
  path = "/cloudlabs-lab/"
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Sid = "LabTable", Effect = "Allow", Action = ["dynamodb:Scan", "dynamodb:GetItem", "dynamodb:PutItem"], Resource = local.table_arn }]
  })
}

resource "aws_iam_role_policy_attachment" "api" {
  role       = aws_iam_role.api.name
  policy_arn = aws_iam_policy.api.arn
}

data "archive_file" "api" {
  type        = "zip"
  source_file = "${path.module}/lambda/api.py"
  output_path = "${path.module}/.terraform/api.zip"
}

resource "aws_lambda_function" "api" {
  function_name    = "lab-${var.lab_id}-api"
  role             = aws_iam_role.api.arn
  runtime          = "python3.13"
  architectures    = ["arm64"]
  handler          = "api.handler"
  filename         = data.archive_file.api.output_path
  source_code_hash = data.archive_file.api.output_base64sha256
  memory_size      = 128
  timeout          = 10
  environment {
    variables = { TABLE = aws_dynamodb_table.items.name }
  }
  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.api.name
  }
  tags       = { Name = "fn-api" }
  depends_on = [aws_iam_role_policy_attachment.api_logs, aws_iam_role_policy_attachment.api]
}

resource "time_sleep" "function_tags" {
  create_duration = "20s"
  depends_on      = [aws_lambda_function.api]
}

resource "aws_lambda_permission" "api" {
  statement_id  = "ApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.lab.execution_arn}/*/*"
  depends_on    = [time_sleep.function_tags]
}
```

**`labs/saa-12-serverless-api/terraform/lambda/api.py`**
```python
# lambda/api.py
#
# Plain English: lab 12's API behind API Gateway's HTTP API (payload format
# 2.0). GET /health answers anyone; GET /items lists up to 50 items and
# POST /items stores one, both only for a signed-in user of the lab's Cognito
# pool (the JWT authoriser checks the token before this code runs), recorded
# with the user name the token carries.

import json
import os
import uuid
from datetime import datetime, timezone

import boto3

TABLE = boto3.resource("dynamodb").Table(os.environ["TABLE"])


def reply(status, body):
    return {"statusCode": status, "headers": {"content-type": "application/json"}, "body": json.dumps(body, default=str)}


def handler(event, _context):
    route = event.get("routeKey", "")
    if route == "GET /health":
        return reply(200, {"ok": True})
    claims = event.get("requestContext", {}).get("authorizer", {}).get("jwt", {}).get("claims", {})
    who = claims.get("cognito:username") or claims.get("username") or "unknown"
    if route == "GET /items":
        return reply(200, {"you": who, "items": TABLE.scan(Limit=50).get("Items", [])})
    if route == "POST /items":
        try:
            body = json.loads(event.get("body") or "{}")
        except json.JSONDecodeError:
            return reply(400, {"error": "the body must be JSON"})
        item = {"id": str(uuid.uuid4()), "text": str(body.get("text", ""))[:200], "by": who, "at": datetime.now(timezone.utc).isoformat()}
        TABLE.put_item(Item=item)
        return reply(201, item)
    return reply(404, {"error": f"no route {route}"})
```

**`labs/saa-12-serverless-api/terraform/cognito.tf`**
```hcl
# cognito.tf
#
# Plain English: lab 12's sign-in. A Cognito user pool on the free Lite tier
# (ruling P12) where only an administrator makes users, deletable at
# tear-down, with no hosted domain (CloudShell signs in directly); an app
# client that signs in with a user name and password (USER_PASSWORD_AUTH,
# no client secret, as a command-line client); and one user, labuser, whose
# password is the session's (behind Show), set permanent and no email sent.
# A 20-second wait lets the pool's tags reach IAM before the client and the
# user, which IAM judges by them (ruling P11).

resource "aws_cognito_user_pool" "users" {
  name                = "lab-${var.lab_id}-users"
  user_pool_tier      = "LITE"
  deletion_protection = "INACTIVE"
  mfa_configuration   = "OFF"

  admin_create_user_config {
    allow_admin_create_user_only = true
  }
  account_recovery_setting {
    recovery_mechanism {
      name     = "admin_only"
      priority = 1
    }
  }
  password_policy {
    minimum_length    = 12
    require_lowercase = true
    require_uppercase = true
    require_numbers   = true
    require_symbols   = false
  }
  tags = { Name = "pool-users" }
}

resource "time_sleep" "pool_tags" {
  create_duration = "20s"
  depends_on      = [aws_cognito_user_pool.users]
}

resource "aws_cognito_user_pool_client" "cli" {
  name                          = "lab-${var.lab_id}-cli"
  user_pool_id                  = aws_cognito_user_pool.users.id
  generate_secret               = false
  explicit_auth_flows           = ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  prevent_user_existence_errors = "ENABLED"
  depends_on                    = [time_sleep.pool_tags]
}

resource "aws_cognito_user" "labuser" {
  user_pool_id   = aws_cognito_user_pool.users.id
  username       = "labuser"
  password       = var.admin_password
  message_action = "SUPPRESS"
  depends_on     = [time_sleep.pool_tags]
}
```

**`labs/saa-12-serverless-api/terraform/api.tf`**
```hcl
# api.tf
#
# Plain English: lab 12's HTTP API, lab-<id> (public by nature, spec §7.4).
# One Lambda integration and three routes: GET /health for anyone, GET and
# POST /items only with a valid token from the lab's own user pool for its
# own app client (a JWT authoriser; ruling P12). The $default stage deploys
# every change and holds the API to 10 requests at once and 5 a second, so a
# leaked address cannot run up a bill.

resource "aws_apigatewayv2_api" "lab" {
  name          = "lab-${var.lab_id}"
  protocol_type = "HTTP"
  tags          = { Name = "api-lab" }
}

resource "aws_apigatewayv2_authorizer" "cognito" {
  api_id           = aws_apigatewayv2_api.lab.id
  authorizer_type  = "JWT"
  name             = "cognito"
  identity_sources = ["$request.header.Authorization"]
  jwt_configuration {
    audience = [aws_cognito_user_pool_client.cli.id]
    issuer   = "https://${aws_cognito_user_pool.users.endpoint}"
  }
}

resource "aws_apigatewayv2_integration" "api" {
  api_id                 = aws_apigatewayv2_api.lab.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "health" {
  api_id    = aws_apigatewayv2_api.lab.id
  route_key = "GET /health"
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
}

resource "aws_apigatewayv2_route" "items_get" {
  api_id             = aws_apigatewayv2_api.lab.id
  route_key          = "GET /items"
  target             = "integrations/${aws_apigatewayv2_integration.api.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

resource "aws_apigatewayv2_route" "items_post" {
  api_id             = aws_apigatewayv2_api.lab.id
  route_key          = "POST /items"
  target             = "integrations/${aws_apigatewayv2_integration.api.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.lab.id
  name        = "$default"
  auto_deploy = true
  default_route_settings {
    throttling_burst_limit = 10
    throttling_rate_limit  = 5
  }
  tags = { Name = "stage-default" }
}
```

**`labs/saa-12-serverless-api/terraform/outputs.tf`**
```hcl
# outputs.tf
#
# Plain English: what the dashboard shows once lab 12 is up: the API's
# address, and CloudShell lines to sign in as labuser (the session password
# is behind Show) and call the API with the token. No instances, no peering.

output "private_ips" {
  value = {}
}

output "connect" {
  value = [
    "curl -s ${aws_apigatewayv2_api.lab.api_endpoint}/health",
    "TOKEN=$(aws cognito-idp initiate-auth --region ${var.region} --auth-flow USER_PASSWORD_AUTH --client-id ${aws_cognito_user_pool_client.cli.id} --auth-parameters USERNAME=labuser,PASSWORD='<the session password>' --query AuthenticationResult.IdToken --output text)",
    "curl -s -X POST -H \"Authorization: Bearer $TOKEN\" -d '{\"text\":\"hello\"}' ${aws_apigatewayv2_api.lab.api_endpoint}/items",
    "curl -s -H \"Authorization: Bearer $TOKEN\" ${aws_apigatewayv2_api.lab.api_endpoint}/items",
  ]
}
```

**`labs/saa-12-serverless-api/readme.md`** (exactly):
````markdown
An API with no servers at all: API Gateway's HTTP API takes the requests, a Lambda function does the work, a DynamoDB table keeps the data, and a Cognito user pool decides who may call it. API Gateway checks each caller's token itself, so the function only ever sees signed-in users. Everything is listed in the lab's resource group, `lab-saa-12-serverless-api`, in AWS Resource Groups (London).
From the SAA-C03 outline: design secure access to application tiers with an identity provider, and choose serverless, scale-to-zero services for resilient, high-performing designs.

## What it deploys

- The HTTP API `lab-saa-12-serverless-api` (Name `api-lab`): `GET /health` for anyone; `GET /items` and `POST /items` only with a token from the lab's user pool, checked by a JWT authoriser; the `$default` stage, throttled to 10 requests at once and 5 a second
- The function `lab-saa-12-serverless-api-api` (Python 3.13, arm64, 128 MB), logging to `/cloudlabs/saa-12-serverless-api/api`, running as the role `lab-saa-12-serverless-api-api`, which may only read and write the lab's table
- The table `lab-saa-12-serverless-api-items` (DynamoDB on demand)
- The user pool `lab-saa-12-serverless-api-users` (Lite tier, administrators make users), its app client `lab-saa-12-serverless-api-cli`, and one user, `labuser`, whose password is the session password (behind **Show**)

```text
lab-saa-12-serverless-api (London)
  you (CloudShell) --sign in--> pool-users --> ID token (JWT)
  you --HTTPS + token--> api-lab [JWT authoriser: pool-users, client cli] --> fn-api --> table-items
  GET /health needs no token
```

## Things to try

- Open CloudShell and run the first Connect line: `/health` answers without a token. Ask for `/items` without one and see API Gateway refuse it with 401 before the function runs (no new line in the function's log).
- Sign in with the second line (paste the session password), then add an item with the third and list them with the fourth: each item records who stored it, from the token's `cognito:username` claim.
- Paste the token into a JWT decoder of your choice and read its claims: issuer, audience (the app client), expiry. Change one character and call again: 401.
- Send 50 requests at once (`for i in $(seq 50); do curl -s -o /dev/null -w "%{http_code}\n" <api>/health & done; wait`) and count the 429s: the stage's throttle at work.
- Open the table in the DynamoDB console and look at its capacity mode: on demand bills each read and write, so an idle table costs nothing but its storage.

## Learn more

- [Control access to HTTP APIs with JWT authorizers](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html)
- [Amazon Cognito user pools](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-identity-pools.html)
- [Using Lambda with API Gateway](https://docs.aws.amazon.com/lambda/latest/dg/services-apigateway.html)
- [DynamoDB throughput capacity](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/capacity-mode.html)
- [Throttle requests to your HTTP APIs](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-throttling.html)

Everything this lab builds carries the tag `cloudlabs-lab = saa-12-serverless-api` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
````

**`labs/_learning/saa-12-serverless-api.yaml`**
```yaml
# Labs catalogue learning content (labs redesign spec §5). Outside the lab folder: editing it never needs a version bump.
objective: Call a serverless API that only lets in users who signed in to its own Cognito user pool.
learn:
  - Sign in to a Cognito user pool and read the token it gives you
  - Protect API routes with a JWT authoriser and throttle a stage
  - Store and read items in a DynamoDB table billed per request
learning_min: 45
```

**The diagram** must contain: `resourceGroup lab-saa-12-serverless-api · London`; `generic api-lab` with a `traffic` edge `HTTPS` to `lambda fn-api`; `generic pool-users`; `dynamodb table-items`; `logAnalytics /cloudlabs/saa-12-serverless-api/api`; `managedIdentity lab-saa-12-serverless-api-api`; no `vnet`.

- [ ] **Step 1: Write the failing test** `scripts/test/labs-aws-saa-12.test.mjs`:

```js
// labs-aws-saa-12.test.mjs
//
// Plain English: lab saa-12-serverless-api is the lab AWS labs spec §12.2 row
// 12 describes: an HTTP API with a JWT authoriser on the lab's Cognito pool,
// a Lambda function and a DynamoDB table on demand (rulings P12, P13).

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { validateLearning } from "../lib/labs.mjs";

const ID = "saa-12-serverless-api";

test("saa-12 keeps the AWS lab contract with no network (it cannot peer; ruling A61)", () => {
  assert.deepEqual(commonAwsProblems(ID), []);
  const { files } = awsLab(ID);
  assert.equal(files["network.tf"], undefined);
});

test("saa-12's lab.yaml: §12.2 row 12, pennies an hour", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["SAA-C03", "associate", "explore", ["saa.secure", "saa.resilient", "saa.performance"], []]);
  assert.deepEqual(yaml.timing, { deploy_min: 4, destroy_min: 3, session_h: 2, max_h: 6 });
  assert.deepEqual(yaml.connectivity, { peering: "off", dns_link: false, subnets_used: 0 });
  assert.deepEqual(yaml.identity.creates, ["role"]);
  assert.ok(yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0) < 0.01);
});

test("saa-12's API: JWT on the lab's own pool and client for /items, /health open, throttled, a Lambda proxy", () => {
  const { tf } = awsLab(ID);
  for (const re of [/protocol_type = "HTTP"/, /authorizer_type\s+= "JWT"/, /audience = \[aws_cognito_user_pool_client\.cli\.id\]/, /issuer\s+= "https:\/\/\$\{aws_cognito_user_pool\.users\.endpoint\}"/, /integration_type\s+= "AWS_PROXY"/, /throttling_burst_limit = 10/, /throttling_rate_limit\s+= 5/, /source_arn\s+= "\$\{aws_apigatewayv2_api\.lab\.execution_arn\}\/\*\/\*"/]) assert.match(tf, re);
  assert.equal([...tf.matchAll(/authorization_type = "JWT"/g)].length, 2, "GET and POST /items");
  assert.doesNotMatch(tf, /aws_cognito_user_pool_domain|body\s+=/);
});

test("saa-12's pool, table and function: Lite, protection off, admin-made users; on demand, named for the lab; tag waits", () => {
  const { tf } = awsLab(ID);
  for (const re of [/user_pool_tier\s+= "LITE"/, /deletion_protection = "INACTIVE"/, /allow_admin_create_user_only = true/, /password\s+= var\.admin_password/, /message_action = "SUPPRESS"/, /billing_mode\s+= "PAY_PER_REQUEST"/, /name\s+= "lab-\$\{var\.lab_id\}-items"/, /log_group\s+= aws_cloudwatch_log_group\.api\.name/, /depends_on\s+= \[time_sleep\.pool_tags\]/, /depends_on\s+= \[time_sleep\.function_tags\]/]) assert.match(tf, re);
});

test("saa-12's readme shows signing in and its learning content is valid", () => {
  const { readme, learning, yaml } = awsLab(ID);
  for (const s of ["labuser", "JWT authoriser", "401", "429", "cognito:username"]) assert.ok(readme.includes(s), s);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test scripts/test/labs-aws-saa-12.test.mjs`
Expected: FAIL (no lab folder).

- [ ] **Step 3: Write the lab**: the files above; copy `versions.tf` and `main.tf` unchanged; trim `variables.tf` to the four variables named.

- [ ] **Step 4: Write the plan fixture** `saa-12-serverless-api.mjs`: `[...templateMainResources(c), …]` with `data: templateMainData()` plus the archive, then the table, log group, role, policies and attachments, function, the two waits, the permission, the pool, client and user, the API, authoriser, integration, three routes and the stage. Known at plan: every name, the table's settings, the role's and policy's documents (the table ARN is built from the caller identity and region), the pool's settings, the routes' `route_key`s, the stage's throttling; unknown with references: ids, `invoke_arn`, `execution_arn` in `source_arn`, the authoriser's `issuer` and `audience`, the routes' `target` and `authorizer_id`, the user's and client's `user_pool_id`. The user's `password` is sensitive. `lab-plans.test.mjs` proves it.

- [ ] **Step 5: Generate the planned graph and the readme diagram**, `GOLDEN["saa-12-serverless-api"]`, `AWS_LAB_IDS`.

- [ ] **Step 6: Run the checks**

Run: `node --test scripts/test/labs-aws-saa-12.test.mjs scripts/test/lab-plans.test.mjs scripts/test/labs-readmes.test.mjs scripts/test/labs-diagrams.test.mjs scripts/test/labs-learning-content.test.mjs`, then `npx vitest run worker/test/topology-golden.test.ts`, then `npm run labs-check`, `npm run labs-tf -- saa-12-serverless-api`, `npm run labs-topology -- --check saa-12-serverless-api`, `npm run labs-diagrams -- --check`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add labs/saa-12-serverless-api labs/_learning/saa-12-serverless-api.yaml shared/topology/planned/saa-12-serverless-api.json shared/guides scripts/test worker/test
git commit -m "feat(aws labs): lab saa-12 serverless API with Cognito sign-in

Claude-Session: https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D"
```

---

### Task 9: Lab saa-13-decoupling

Spec: §12.2 row 13 (resilient; associate; explore; £ 0.00; peering off; 4/3; 2/6; prerequisite 12; SQS with DLQ, SNS fan-out to two queues, EventBridge bus and rule, Step Functions with a Lambda step); rulings A42, A56, A61, A68, P11, P14.

**Files:**
- Create: `labs/saa-13-decoupling/lab.yaml`, `readme.md`
- Create: `labs/saa-13-decoupling/terraform/versions.tf`, `main.tf` (copied unchanged; no `network.tf`), `variables.tf` (the template's `lab_id`, `region`, `tags`), `messaging.tf`, `workflow.tf`, `events.tf`, `outputs.tf`, `lambda/validate.py`
- Create: `labs/_learning/saa-13-decoupling.yaml`, `scripts/test/fixtures/labs/plans/labs/saa-13-decoupling.mjs`
- Create (generated): `shared/topology/planned/saa-13-decoupling.json`, `shared/guides/saa-13-decoupling/**`
- Modify: `worker/test/topology-golden.test.ts`, `worker/test/fixtures/topology/round-trip.ts`
- Test: `scripts/test/labs-aws-saa-13.test.mjs`

**Interfaces:**
- Consumes: Task 3 (`workflowProblem`, subscription and target rules), Task 4 (state machine, bus handlers), Task 6 (fan-out edges, bus kind).

**`labs/saa-13-decoupling/lab.yaml`**
```yaml
# Lab saa-13 (AWS labs batch 3). SAA-C03 ((V) the wording against the current
# exam guide): Design Resilient Architectures (loosely coupled designs:
# queues, dead-letter queues, fan-out, events and workflows).
# Every service here bills per request or per state transition: an idle hour
# is free and a session of Things to try stays inside the free tiers
# (authored figures, V).
id: saa-13-decoupling
version: 1
cloud: aws
title: "Decoupling: queues, fan-out, events, workflows"
summary: >-
  An order event on the lab's own EventBridge bus starts a Step Functions workflow, which validates the order with a
  Lambda function and publishes it to an SNS topic that fans out to two SQS queues, one with a dead-letter queue.
exam: SAA-C03
skill_areas: [saa.resilient]
level: associate
type: explore
prerequisites: [saa-12-serverless-api]
cost:
  items:
    - { name: "EventBridge custom events (a few hundred)", gbp_h: 0.0001 }
    - { name: "Step Functions standard state transitions (inside the free tier)", gbp_h: 0 }
    - { name: "Lambda arm64, 128 MB, a few hundred calls", gbp_h: 0.0001 }
    - { name: "SNS publishes and SQS requests (inside the free tiers)", gbp_h: 0 }
    - { name: "CloudWatch Logs (one day)", gbp_h: 0.0001 }
  pricey: null
timing: { deploy_min: 4, destroy_min: 3, session_h: 2, max_h: 6 }
capacity: { instance_types: [] }
regions: { secondary: null }
connectivity: { peering: off, dns_link: false, subnets_used: 0 }
identity:
  creates: [role]
  roles: []
  governance: false
```

**`labs/saa-13-decoupling/terraform/messaging.tf`**
```hcl
# messaging.tf
#
# Plain English: lab 13's fan-out. The topic lab-<id>-orders delivers every
# order to two queues, lab-<id>-billing and lab-<id>-shipping (raw messages,
# encrypted at rest with SQS's own key). Billing gives a message three tries:
# received three times without being deleted, it moves to
# lab-<id>-billing-dlq, where it waits a day. Each queue's policy lets only
# this lab's topic send to it (ruling P14). A 20-second wait lets the new
# topic's and queues' tags reach IAM before the policies and subscriptions,
# which IAM judges by them (ruling P11).

locals {
  account   = data.aws_caller_identity.current.account_id
  topic_arn = "arn:${data.aws_partition.current.partition}:sns:${var.region}:${local.account}:lab-${var.lab_id}-orders"
  queues    = toset(["billing", "shipping"])
}

resource "aws_sns_topic" "orders" {
  name = "lab-${var.lab_id}-orders"
  tags = { Name = "topic-orders" }
}

resource "aws_sqs_queue" "billing_dlq" {
  name                      = "lab-${var.lab_id}-billing-dlq"
  message_retention_seconds = 86400
  sqs_managed_sse_enabled   = true
  tags                      = { Name = "queue-billing-dlq" }
}

resource "aws_sqs_queue" "orders" {
  for_each                   = local.queues
  name                       = "lab-${var.lab_id}-${each.key}"
  visibility_timeout_seconds = 20
  message_retention_seconds  = 86400
  sqs_managed_sse_enabled    = true
  redrive_policy             = each.key == "billing" ? jsonencode({ deadLetterTargetArn = aws_sqs_queue.billing_dlq.arn, maxReceiveCount = 3 }) : null
  tags                       = { Name = "queue-${each.key}" }
}

resource "time_sleep" "messaging_tags" {
  create_duration = "20s"
  depends_on      = [aws_sns_topic.orders, aws_sqs_queue.orders]
}

resource "aws_sqs_queue_policy" "orders" {
  for_each  = local.queues
  queue_url = aws_sqs_queue.orders[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "FromTheLabTopic"
      Effect    = "Allow"
      Principal = { Service = "sns.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = "arn:${data.aws_partition.current.partition}:sqs:${var.region}:${local.account}:lab-${var.lab_id}-${each.key}"
      Condition = { ArnEquals = { "aws:SourceArn" = local.topic_arn } }
    }]
  })
  depends_on = [time_sleep.messaging_tags]
}

resource "aws_sns_topic_subscription" "orders" {
  for_each             = local.queues
  topic_arn            = aws_sns_topic.orders.arn
  protocol             = "sqs"
  endpoint             = aws_sqs_queue.orders[each.key].arn
  raw_message_delivery = true
  depends_on           = [aws_sqs_queue_policy.orders]
}
```

**`labs/saa-13-decoupling/terraform/lambda/validate.py`**
```python
# lambda/validate.py
#
# Plain English: lab 13's order check, the workflow's Lambda step. It takes
# the order from the EventBridge event's detail, refuses one whose quantity
# is not 1 or more (the workflow then ends Rejected), and returns the order
# with its total, which the workflow publishes to the topic.


def handler(event, _context):
    order = event.get("detail", event)
    qty = int(order.get("quantity", 0))
    price = float(order.get("price", 0))
    if qty <= 0:
        raise ValueError(f"order {order.get('orderId', '?')}: quantity must be 1 or more")
    return {"orderId": order.get("orderId", "unknown"), "quantity": qty, "price": price, "total": round(qty * price, 2), "valid": True}
```

**`labs/saa-13-decoupling/terraform/workflow.tf`**
```hcl
# workflow.tf
#
# Plain English: lab 13's workflow, lab-<id>-orders (Step Functions,
# standard). Validate calls the function lab-<id>-validate (retried twice on
# a Lambda service error); an order it refuses ends in Rejected; a valid one
# is published to the lab's topic, which fans it out. The definition names
# only the lab's own function and topic, known at plan (ruling P14). The
# function logs to /cloudlabs/<id>/validate (ruling A56); the workflow runs
# as lab-<id>-sfn, allowed only to call that function and publish to that
# topic.

locals {
  validate_arn = "arn:${data.aws_partition.current.partition}:lambda:${var.region}:${local.account}:function:lab-${var.lab_id}-validate"
  workflow_arn = "arn:${data.aws_partition.current.partition}:states:${var.region}:${local.account}:stateMachine:lab-${var.lab_id}-orders"
}

resource "aws_cloudwatch_log_group" "validate" {
  name              = "/cloudlabs/${var.lab_id}/validate"
  retention_in_days = 1
}

resource "aws_iam_role" "validate" {
  name                 = "lab-${var.lab_id}-validate"
  path                 = "/cloudlabs-lab/"
  permissions_boundary = local.boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "validate_logs" {
  role       = aws_iam_role.validate.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "archive_file" "validate" {
  type        = "zip"
  source_file = "${path.module}/lambda/validate.py"
  output_path = "${path.module}/.terraform/validate.zip"
}

resource "aws_lambda_function" "validate" {
  function_name    = "lab-${var.lab_id}-validate"
  role             = aws_iam_role.validate.arn
  runtime          = "python3.13"
  architectures    = ["arm64"]
  handler          = "validate.handler"
  filename         = data.archive_file.validate.output_path
  source_code_hash = data.archive_file.validate.output_base64sha256
  memory_size      = 128
  timeout          = 10
  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.validate.name
  }
  tags       = { Name = "fn-validate" }
  depends_on = [aws_iam_role_policy_attachment.validate_logs]
}

resource "aws_iam_role" "sfn" {
  name                 = "lab-${var.lab_id}-sfn"
  path                 = "/cloudlabs-lab/"
  permissions_boundary = local.boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "states.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_policy" "sfn" {
  name = "lab-${var.lab_id}-sfn"
  path = "/cloudlabs-lab/"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "Validate", Effect = "Allow", Action = "lambda:InvokeFunction", Resource = [local.validate_arn, "${local.validate_arn}:*"] },
      { Sid = "Publish", Effect = "Allow", Action = "sns:Publish", Resource = local.topic_arn },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "sfn" {
  role       = aws_iam_role.sfn.name
  policy_arn = aws_iam_policy.sfn.arn
}

resource "aws_sfn_state_machine" "orders" {
  name     = "lab-${var.lab_id}-orders"
  type     = "STANDARD"
  role_arn = aws_iam_role.sfn.arn
  definition = jsonencode({
    Comment = "lab ${var.lab_id}: validate an order, then fan it out"
    StartAt = "Validate"
    States = {
      Validate = {
        Type       = "Task"
        Resource   = "arn:aws:states:::lambda:invoke"
        Parameters = { FunctionName = local.validate_arn, "Payload.$" = "$" }
        OutputPath = "$.Payload"
        Retry      = [{ ErrorEquals = ["Lambda.ServiceException", "Lambda.TooManyRequestsException"], MaxAttempts = 2, IntervalSeconds = 2, BackoffRate = 2 }]
        Catch      = [{ ErrorEquals = ["States.ALL"], Next = "Rejected" }]
        Next       = "Publish"
      }
      Publish = {
        Type       = "Task"
        Resource   = "arn:aws:states:::sns:publish"
        Parameters = { TopicArn = local.topic_arn, "Message.$" = "$" }
        End        = true
      }
      Rejected = { Type = "Fail", Error = "OrderRejected", Cause = "the order did not validate" }
    }
  })
  tags       = { Name = "sfn-orders" }
  depends_on = [aws_iam_role_policy_attachment.sfn, aws_lambda_function.validate]
}
```

**`labs/saa-13-decoupling/terraform/events.tf`**
```hcl
# events.tf
#
# Plain English: lab 13's events. A bus of the lab's own, lab-<id>-bus, and a
# rule on it, lab-<id>-placed, matching OrderPlaced events from
# cloudlabs.shop; its one target starts the workflow, as lab-<id>-events,
# allowed only to start that workflow (ruling P14).

resource "aws_cloudwatch_event_bus" "orders" {
  name = "lab-${var.lab_id}-bus"
  tags = { Name = "bus-orders" }
}

resource "aws_cloudwatch_event_rule" "placed" {
  name           = "lab-${var.lab_id}-placed"
  event_bus_name = aws_cloudwatch_event_bus.orders.name
  event_pattern  = jsonencode({ source = ["cloudlabs.shop"], "detail-type" = ["OrderPlaced"] })
  tags           = { Name = "rule-placed" }
}

resource "aws_iam_role" "events" {
  name                 = "lab-${var.lab_id}-events"
  path                 = "/cloudlabs-lab/"
  permissions_boundary = local.boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "events.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_policy" "events" {
  name = "lab-${var.lab_id}-events"
  path = "/cloudlabs-lab/"
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Sid = "StartTheWorkflow", Effect = "Allow", Action = "states:StartExecution", Resource = local.workflow_arn }]
  })
}

resource "aws_iam_role_policy_attachment" "events" {
  role       = aws_iam_role.events.name
  policy_arn = aws_iam_policy.events.arn
}

resource "aws_cloudwatch_event_target" "workflow" {
  rule           = aws_cloudwatch_event_rule.placed.name
  event_bus_name = aws_cloudwatch_event_bus.orders.name
  target_id      = "workflow"
  arn            = aws_sfn_state_machine.orders.arn
  role_arn       = aws_iam_role.events.arn
  depends_on     = [aws_iam_role_policy_attachment.events]
}
```

**`labs/saa-13-decoupling/terraform/outputs.tf`**
```hcl
# outputs.tf
#
# Plain English: what the dashboard shows once lab 13 is up: CloudShell lines
# to put an order on the bus, list the workflow's runs, and read the queues.

output "private_ips" {
  value = {}
}

output "connect" {
  value = [
    "aws events put-events --region ${var.region} --entries '[{\"EventBusName\":\"${aws_cloudwatch_event_bus.orders.name}\",\"Source\":\"cloudlabs.shop\",\"DetailType\":\"OrderPlaced\",\"Detail\":\"{\\\"orderId\\\":\\\"o-1\\\",\\\"quantity\\\":2,\\\"price\\\":5}\"}]'",
    "aws stepfunctions list-executions --region ${var.region} --state-machine-arn ${aws_sfn_state_machine.orders.arn} --query 'executions[].[name,status]' --output table",
    "aws sqs receive-message --region ${var.region} --queue-url ${aws_sqs_queue.orders["billing"].id} --wait-time-seconds 5",
    "aws sqs receive-message --region ${var.region} --queue-url ${aws_sqs_queue.orders["shipping"].id} --wait-time-seconds 5",
    "aws sqs receive-message --region ${var.region} --queue-url ${aws_sqs_queue.billing_dlq.id} --wait-time-seconds 5",
  ]
}
```

**`labs/saa-13-decoupling/readme.md`** (exactly):
````markdown
Five ways to let the parts of a system stop waiting on each other. An order is put on an EventBridge bus; a rule starts a Step Functions workflow; the workflow asks a Lambda function to check the order and publishes it to an SNS topic; the topic copies it into two SQS queues, billing and shipping, which their own consumers would read at their own pace. Billing's queue has a dead-letter queue for messages nobody manages to handle. Everything is listed in the lab's resource group, `lab-saa-13-decoupling`, in AWS Resource Groups (London).
From the SAA-C03 outline: design loosely coupled architectures with queues, notifications, events and workflows, and handle failures with retries and dead-letter queues.

## What it deploys

- The bus `lab-saa-13-decoupling-bus` and its rule `lab-saa-13-decoupling-placed` (OrderPlaced events from `cloudlabs.shop`), whose target starts the workflow as the role `lab-saa-13-decoupling-events`
- The workflow `lab-saa-13-decoupling-orders` (Step Functions, standard): Validate (the function `lab-saa-13-decoupling-validate`, retried twice on a Lambda service error), then Publish to the topic; an order that fails validation ends in Rejected
- The topic `lab-saa-13-decoupling-orders`, fanning out to the queues `lab-saa-13-decoupling-billing` and `lab-saa-13-decoupling-shipping`
- The dead-letter queue `lab-saa-13-decoupling-billing-dlq`: a billing message received three times without being deleted moves there

```text
lab-saa-13-decoupling (London)
  put-events --> bus-orders --rule placed--> sfn-orders: Validate (fn-validate) --> Publish --> topic-orders
  topic-orders --fan-out--> queue-billing --3 failed receives--> queue-billing-dlq
  topic-orders --fan-out--> queue-shipping
  sfn-orders: Validate fails --> Rejected
```

## Things to try

- Put an order on the bus with the first Connect line in CloudShell, then list the workflow's runs with the second: open the run in the Step Functions console and follow it state by state, inputs and outputs included.
- Read the order from both queues with the third and fourth lines: one publish, two copies, each queue independent of the other.
- Read the billing message three times without deleting it (wait for its 20-second visibility timeout between reads): the fourth read finds nothing, and the fifth Connect line finds it in the dead-letter queue.
- Put an order with `quantity` 0 on the bus: the workflow ends in Rejected and nothing reaches the queues. Find the function's error in `/cloudlabs/saa-13-decoupling/validate`.
- Put an event with a different `Source` on the bus: the rule does not match it, so nothing runs. EventBridge decides what goes where, not the sender.

## Learn more

- [Using dead-letter queues in Amazon SQS](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html)
- [Fanout Amazon SNS notifications to Amazon SQS queues](https://docs.aws.amazon.com/sns/latest/dg/sns-sqs-as-subscriber.html)
- [Event buses in Amazon EventBridge](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-event-bus.html)
- [Invoke an AWS Lambda function with Step Functions](https://docs.aws.amazon.com/step-functions/latest/dg/connect-lambda.html)
- [Handling errors in Step Functions workflows](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-error-handling.html)

Everything this lab builds carries the tag `cloudlabs-lab = saa-13-decoupling` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
````

**`labs/_learning/saa-13-decoupling.yaml`**
```yaml
# Labs catalogue learning content (labs redesign spec §5). Outside the lab folder: editing it never needs a version bump.
objective: Follow one order through an event bus, a workflow, a topic and two queues, and watch failures land safely.
learn:
  - Route events from a custom bus to a workflow with a rule
  - Fan one message out to two queues with an SNS topic
  - Send messages that keep failing to a dead-letter queue
learning_min: 45
```

**The diagram** must contain: `resourceGroup lab-saa-13-decoupling · London`; `messaging bus-orders`, `rule-placed`, `sfn-orders`, `topic-orders`, `queue-billing`, `queue-shipping`, `queue-billing-dlq`; `dependency` edges `fan-out` from `topic-orders` to `queue-billing` and `queue-shipping`; a `dependency` edge from `rule-placed` to `sfn-orders`; `lambda fn-validate`; `logAnalytics /cloudlabs/saa-13-decoupling/validate`; `managedIdentity lab-saa-13-decoupling-validate`, `-sfn`, `-events`.

- [ ] **Step 1: Write the failing test** `scripts/test/labs-aws-saa-13.test.mjs`:

```js
// labs-aws-saa-13.test.mjs
//
// Plain English: lab saa-13-decoupling is the lab AWS labs spec §12.2 row 13
// describes: SQS with a dead-letter queue, SNS fan-out to two queues, an
// EventBridge bus and rule, and Step Functions with a Lambda step, every
// reference the lab's own (ruling P14).

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { validateLearning } from "../lib/labs.mjs";
import { workflowProblem } from "../../infra/ci/lab-scope-aws.mjs";

const ID = "saa-13-decoupling";

test("saa-13 keeps the AWS lab contract with no network", () => {
  assert.deepEqual(commonAwsProblems(ID), []);
  assert.equal(awsLab(ID).files["network.tf"], undefined);
});

test("saa-13's lab.yaml: §12.2 row 13, after saa-12, pennies an hour", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["SAA-C03", "associate", "explore", ["saa.resilient"], ["saa-12-serverless-api"]]);
  assert.deepEqual(yaml.timing, { deploy_min: 4, destroy_min: 3, session_h: 2, max_h: 6 });
  assert.deepEqual(yaml.connectivity, { peering: "off", dns_link: false, subnets_used: 0 });
  assert.ok(yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0) < 0.01);
});

test("saa-13's messaging: a DLQ after three receives, a fan-out to two queues, each queue taking only the lab's topic, after the tag wait", () => {
  const { tf } = awsLab(ID);
  for (const re of [/maxReceiveCount = 3/, /protocol\s+= "sqs"/, /raw_message_delivery = true/, /"aws:SourceArn" = local\.topic_arn/, /Principal = \{ Service = "sns\.amazonaws\.com" \}/, /depends_on = \[time_sleep\.messaging_tags\]/, /queues\s+= toset\(\["billing", "shipping"\]\)/]) assert.match(tf, re);
});

test("saa-13's workflow names only the lab's own function and topic (ruling P14), and the bus's rule starts it", () => {
  const { tf } = awsLab(ID);
  for (const re of [/Resource\s+= "arn:aws:states:::lambda:invoke"/, /Resource\s+= "arn:aws:states:::sns:publish"/, /Catch\s+= \[\{ ErrorEquals = \["States\.ALL"\], Next = "Rejected" \}\]/, /arn\s+= aws_sfn_state_machine\.orders\.arn/, /event_bus_name = aws_cloudwatch_event_bus\.orders\.name/]) assert.match(tf, re);
  const acct = "123456789012";
  const def = { StartAt: "Validate", States: { Validate: { Type: "Task", Resource: "arn:aws:states:::lambda:invoke", Parameters: { FunctionName: `arn:aws:lambda:eu-west-2:${acct}:function:lab-${ID}-validate`, "Payload.$": "$" }, Next: "Publish" }, Publish: { Type: "Task", Resource: "arn:aws:states:::sns:publish", Parameters: { TopicArn: `arn:aws:sns:eu-west-2:${acct}:lab-${ID}-orders`, "Message.$": "$" }, End: true } } };
  assert.equal(workflowProblem(def, ID), null);
});

test("saa-13's readme follows an order and its learning content is valid", () => {
  const { readme, learning, yaml } = awsLab(ID);
  for (const s of ["lab-saa-13-decoupling-billing-dlq", "fan-out", "Rejected", "visibility timeout"]) assert.ok(readme.includes(s), s);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test scripts/test/labs-aws-saa-13.test.mjs`
Expected: FAIL (no lab folder).

- [ ] **Step 3: Write the lab**: the files above; copy `versions.tf` and `main.tf`; trim `variables.tf` to the three variables named.

- [ ] **Step 4: Write the plan fixture** `saa-13-decoupling.mjs`: `[...templateMainResources(c), …]` with `data: templateMainData()` plus the archive; the topic, the DLQ, the two queues (`forEach` as Terraform prints it: `aws_sqs_queue.orders["billing"]`, `["shipping"]`), the wait, the two policies and two subscriptions, the log group, the two roles and their policies and attachments, the function, the state machine, the bus, rule and target. Known at plan: every name; the queue policies (built from the account, region and topic name); the redrive policy is unknown (it holds the DLQ's ARN); the state machine's `definition` is known (it names the function and topic by built ARNs) and rule `gateway` reads it; unknown with references: ARNs, ids, the subscriptions' `topic_arn` and `endpoint`, the target's `arn` and `role_arn`, the state machine's `role_arn`.

- [ ] **Step 5: Generate the planned graph and the readme diagram**, `GOLDEN["saa-13-decoupling"]`, `AWS_LAB_IDS`.

- [ ] **Step 6: Run the checks**

Run: `node --test scripts/test/labs-aws-saa-13.test.mjs scripts/test/lab-plans.test.mjs scripts/test/labs-readmes.test.mjs scripts/test/labs-diagrams.test.mjs scripts/test/labs-learning-content.test.mjs`, then `npx vitest run worker/test/topology-golden.test.ts`, then `npm run labs-check`, `npm run labs-tf -- saa-13-decoupling`, `npm run labs-topology -- --check saa-13-decoupling`, `npm run labs-diagrams -- --check`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add labs/saa-13-decoupling labs/_learning/saa-13-decoupling.yaml shared/topology/planned/saa-13-decoupling.json shared/guides scripts/test worker/test
git commit -m "feat(aws labs): lab saa-13 decoupling: queues, fan-out, events, workflows

Claude-Session: https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D"
```

---
### Task 10: Lab saa-14-storage

Spec: §12.2 row 14 (performance, cost; associate; explore; £ 0.02; peering optional; 5/4; 2/6; no prerequisites; bucket with Intelligent-Tiering and lifecycle, EFS with mount targets, gp3 and io2 volumes on one instance); §7.3 rule 13 (EBS ≤ 30 GiB, io2 ≤ 500 IOPS); rulings A49, P10, P11.

**Files:**
- Create: `labs/saa-14-storage/lab.yaml`, `readme.md`
- Create: `labs/saa-14-storage/terraform/versions.tf`, `main.tf`, `network.tf` (copied unchanged), `variables.tf` (the template's `lab_id`, `name_prefix`, `region`, `address_space`, `gateway_cidr`, `admin_password`, `tags`), `compute.tf`, `efs.tf`, `s3.tf`, `outputs.tf`
- Create: `labs/_learning/saa-14-storage.yaml`, `scripts/test/fixtures/labs/plans/labs/saa-14-storage.mjs`
- Create (generated): `shared/topology/planned/saa-14-storage.json`, `shared/guides/saa-14-storage/**`
- Modify: `worker/test/topology-golden.test.ts`, `worker/test/fixtures/topology/round-trip.ts`
- Test: `scripts/test/labs-aws-saa-14.test.mjs`

**Interfaces:**
- Consumes: the template network; Task 2 (EFS's service-linked role made ahead), Task 3 (EFS rules), Task 4 (EFS handler), Task 6 (EFS card).

**`labs/saa-14-storage/lab.yaml`**
```yaml
# Lab saa-14 (AWS labs batch 3). SAA-C03 ((V) the wording against the current
# exam guide): Design High-Performing Architectures (block, file and object
# storage, IOPS); Design Cost-Optimized Architectures (storage classes,
# lifecycle, Intelligent-Tiering).
# London list prices × 0.75 (labs-verify --aws-prices). io2's provisioned IOPS
# are billed per IOPS-month (authored, V: London $0.076); EFS and S3 hold a
# few kB (authored).
id: saa-14-storage
version: 1
cloud: aws
title: "Storage choices: S3 classes, EFS, EBS gp3 and io2"
summary: >-
  One instance with a gp3 and an io2 volume and an EFS file system mounted, and a bucket that moves objects between
  storage classes by itself, so you can measure block, file and object storage side by side and see what each costs.
exam: SAA-C03
skill_areas: [saa.performance, saa.cost]
level: associate
type: explore
prerequisites: []
cost:
  items:
    - name: "EC2 t4g.micro, Linux"
      gbp_h: 0.0071
      aws_price: { service: AmazonEC2, unit: Hrs, filters: { instanceType: t4g.micro, operatingSystem: Linux, tenancy: Shared, preInstalledSw: NA, capacitystatus: Used } }
    - name: "EBS gp3 root volume, 8 GiB"
      gbp_h: 0.0008
      aws_price: { service: AmazonEC2, unit: GB-Mo, gb: 8, filters: { productFamily: Storage, volumeApiName: gp3 } }
    - name: "EBS gp3 data volume, 4 GiB"
      gbp_h: 0.0004
      aws_price: { service: AmazonEC2, unit: GB-Mo, gb: 4, filters: { productFamily: Storage, volumeApiName: gp3 } }
    - name: "EBS io2 data volume, 4 GiB"
      gbp_h: 0.0006
      aws_price: { service: AmazonEC2, unit: GB-Mo, gb: 4, filters: { productFamily: Storage, volumeApiName: io2 } }
    - { name: "EBS io2 provisioned IOPS, 100", gbp_h: 0.0078 }
    - { name: "EFS Standard and S3 Intelligent-Tiering, a few kB, and their requests", gbp_h: 0.0002 }
    - { name: "EC2 Instance Connect Endpoint", gbp_h: 0 }
  pricey: null
timing: { deploy_min: 5, destroy_min: 4, session_h: 2, max_h: 6 }
capacity: { instance_types: [t4g.micro] }
regions: { secondary: null }
connectivity: { peering: optional, dns_link: false, subnets_used: 1 }
identity:
  creates: []
  roles: []
  governance: false
```

**`labs/saa-14-storage/terraform/compute.tf`**
```hcl
# compute.tf
#
# Plain English: lab 14's instance, vm-storage (t4g.micro), with two extra
# block volumes in its zone: a 4 GiB gp3 (3,000 IOPS whatever its size) at
# /dev/sdf and a 4 GiB io2 with 100 provisioned IOPS (the least io2 takes) at
# /dev/sdg, left unformatted for the Things to try. At boot it installs fio
# and the EFS mount helper through the S3 endpoint and mounts the lab's file
# system at /mnt/efs over TLS. The volumes carry only the provider's default
# tags and the instance tags its volumes with var.tags, the same set, so
# neither cycles (ruling A49).

locals {
  storage_cloud_init = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    runcmd = [
      "dnf install -y amazon-efs-utils fio",
      "mkdir -p /mnt/efs",
      "echo '${aws_efs_file_system.shared.id}:/ /mnt/efs efs _netdev,tls 0 0' >> /etc/fstab",
      "mount -a",
    ]
  }))}"
}

resource "aws_instance" "storage" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.micro"
  subnet_id              = aws_subnet.private[0].id
  vpc_security_group_ids = [aws_security_group.vms.id]
  user_data              = local.storage_cloud_init

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = var.tags
  tags        = { Name = "vm-storage" }
  depends_on  = [aws_efs_mount_target.shared, aws_vpc_endpoint.s3]
}

resource "aws_ebs_volume" "gp3" {
  availability_zone = aws_subnet.private[0].availability_zone
  size              = 4
  type              = "gp3"
}

resource "aws_ebs_volume" "io2" {
  availability_zone = aws_subnet.private[0].availability_zone
  size              = 4
  type              = "io2"
  iops              = 100
}

resource "aws_volume_attachment" "gp3" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.gp3.id
  instance_id = aws_instance.storage.id
}

resource "aws_volume_attachment" "io2" {
  device_name = "/dev/sdg"
  volume_id   = aws_ebs_volume.io2.id
  instance_id = aws_instance.storage.id
}
```

**`labs/saa-14-storage/terraform/efs.tf`**
```hcl
# efs.tf
#
# Plain English: lab 14's file system, efs-shared: EFS Standard, encrypted,
# bursting throughput (never provisioned: it bills by the hour), files moved
# to Infrequent Access after 7 days unread. A mount target in each private
# subnet admits NFS (TCP 2049) only from the lab instances. A 20-second wait
# lets the file system's tags reach IAM before the mount targets, which IAM
# judges by them (ruling P11). EFS's service-linked role is made ahead by the
# bootstrap (ruling P10).

resource "aws_security_group" "efs" {
  name        = "lab-efs"
  description = "NFS from the lab instances"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-efs" }
}

resource "aws_vpc_security_group_ingress_rule" "efs_nfs" {
  security_group_id            = aws_security_group.efs.id
  referenced_security_group_id = aws_security_group.vms.id
  ip_protocol                  = "tcp"
  from_port                    = 2049
  to_port                      = 2049
}

resource "aws_efs_file_system" "shared" {
  creation_token   = "lab-${var.lab_id}-${var.name_prefix}"
  encrypted        = true
  performance_mode = "generalPurpose"
  throughput_mode  = "bursting"
  lifecycle_policy {
    transition_to_ia = "AFTER_7_DAYS"
  }
  tags = { Name = "efs-shared" }
}

resource "time_sleep" "efs_tags" {
  create_duration = "20s"
  depends_on      = [aws_efs_file_system.shared]
}

resource "aws_efs_mount_target" "shared" {
  count           = 2
  file_system_id  = aws_efs_file_system.shared.id
  subnet_id       = aws_subnet.private[count.index].id
  security_groups = [aws_security_group.efs.id]
  depends_on      = [time_sleep.efs_tags]
}
```

**`labs/saa-14-storage/terraform/s3.tf`**
```hcl
# s3.tf
#
# Plain English: lab 14's bucket, cloudlabs-<name_prefix>-tiers, private and
# removable with its objects. Objects under reports/ go to S3
# Intelligent-Tiering at once (it moves an object to cheaper tiers when nobody
# reads it, and to the archive tiers after 90 and 180 days); objects under
# logs/ go to
# Standard-IA after 30 days, Glacier Instant Retrieval after 90, and are
# deleted after a year. Two sample objects show the classes.

resource "aws_s3_bucket" "tiers" {
  bucket        = "cloudlabs-${var.name_prefix}-tiers"
  force_destroy = true
  tags          = { Name = "tiers" }
}

resource "aws_s3_bucket_public_access_block" "tiers" {
  bucket                  = aws_s3_bucket.tiers.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_intelligent_tiering_configuration" "archive" {
  bucket = aws_s3_bucket.tiers.id
  name   = "archive"
  status = "Enabled"
  tiering {
    access_tier = "ARCHIVE_ACCESS"
    days        = 90
  }
  tiering {
    access_tier = "DEEP_ARCHIVE_ACCESS"
    days        = 180
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "tiers" {
  bucket = aws_s3_bucket.tiers.id
  rule {
    id     = "reports-to-intelligent-tiering"
    status = "Enabled"
    filter {
      prefix = "reports/"
    }
    transition {
      days          = 0
      storage_class = "INTELLIGENT_TIERING"
    }
  }
  rule {
    id     = "logs"
    status = "Enabled"
    filter {
      prefix = "logs/"
    }
    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }
    transition {
      days          = 90
      storage_class = "GLACIER_IR"
    }
    expiration {
      days = 365
    }
  }
}

resource "aws_s3_object" "report" {
  bucket        = aws_s3_bucket.tiers.id
  key           = "reports/hello.txt"
  content       = "an object stored straight into Intelligent-Tiering\n"
  content_type  = "text/plain"
  storage_class = "INTELLIGENT_TIERING"
}

resource "aws_s3_object" "log" {
  bucket       = aws_s3_bucket.tiers.id
  key          = "logs/first.log"
  content      = "a log line that the logs/ rule will move to Standard-IA after 30 days\n"
  content_type = "text/plain"
}
```

**`labs/saa-14-storage/terraform/outputs.tf`**
```hcl
# outputs.tf
#
# Plain English: what the dashboard shows once lab 14 is up: the instance's
# address and how to connect, and the bucket's name for the S3 lines.

output "private_ips" {
  value = { "vm-storage" = aws_instance.storage.private_ip }
}

output "connect" {
  value = [
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.storage.id} --os-user labadmin --connection-type eice",
    "sudo fio --name=rand --filename=/dev/nvme1n1 --rw=randread --bs=4k --iodepth=16 --direct=1 --runtime=20 --time_based --readonly",
    "df -h /mnt/efs",
    "aws s3api list-objects-v2 --bucket ${aws_s3_bucket.tiers.bucket} --query 'Contents[].[Key,StorageClass]' --output table",
    "ssh labadmin@${aws_instance.storage.private_ip}",
  ]
}

output "peer_vpc_id" {
  value = aws_vpc.lab.id
}

output "peer_route_table_ids" {
  value = [aws_route_table.private.id]
}
```

**`labs/saa-14-storage/readme.md`** (exactly):
````markdown
Block, file and object storage side by side, and what each costs. One instance has a gp3 and an io2 EBS volume and an EFS file system mounted; a bucket next to it moves objects between storage classes by itself. Measure the volumes, share files through EFS, and see which S3 class each object lands in. Everything is listed in the lab's resource group, `lab-saa-14-storage`, in AWS Resource Groups (London).
From the SAA-C03 outline: choose high-performing storage for block, file and object needs, and cost-optimised storage classes and lifecycle rules.

## What it deploys

- The VPC `vpc-lab` (the slot's first /20), two private subnets, an S3 gateway endpoint and an Instance Connect Endpoint (the template)
- The instance `vm-storage` (t4g.micro, Amazon Linux 2023) with two extra volumes: a 4 GiB **gp3** at `/dev/sdf` (3,000 IOPS whatever its size) and a 4 GiB **io2** with 100 provisioned IOPS at `/dev/sdg`, both unformatted; on Nitro instances they appear as `/dev/nvme1n1` and `/dev/nvme2n1` (`lsblk` shows which)
- The file system `efs-shared` (EFS Standard, encrypted, bursting throughput, files to Infrequent Access after 7 days unread) with a mount target in each private subnet, mounted on the instance at `/mnt/efs`
- The bucket `cloudlabs-<name prefix>-tiers`: `reports/` to S3 Intelligent-Tiering at once (archive tiers after 90 and 180 days unread); `logs/` to Standard-IA after 30 days, Glacier Instant Retrieval after 90, deleted after a year; two sample objects

```text
lab-saa-14-storage (London)
  vm-storage (snet-private-1) -- root gp3 8 GiB, gp3 4 GiB /dev/sdf, io2 4 GiB 100 IOPS /dev/sdg
  vm-storage --NFS 2049--> efs-shared mount targets (snet-private-1/2) [sg-efs]
  vm-storage --S3 endpoint--> cloudlabs-<prefix>-tiers (Intelligent-Tiering, lifecycle)
```

## Things to try

- Connect (the first Connect line), run `lsblk` to find the two data volumes, then the second line against each (change the device): the gp3 reads at about 3,000 IOPS, the io2 at about its 100. Then think about what each costs per month: the io2's IOPS are billed whether you use them or not.
- Write a file to `/mnt/efs`, then open a second Instance Connect session and read it: EFS is shared, an EBS volume can only be attached to one instance (in its own zone).
- List the bucket with the fourth line: the report is already `INTELLIGENT_TIERING`; the log starts as `STANDARD` and the lifecycle rule moves it later. Upload a file to `reports/` and one to the top of the bucket with `aws s3 cp` and see where each lands.
- Format and mount the gp3 volume (`sudo mkfs -t xfs /dev/nvme1n1 && sudo mkdir /data && sudo mount /dev/nvme1n1 /data`), then grow it to 8 GiB in the EC2 console while mounted and extend the file system with `sudo xfs_growfs /data`: no downtime.
- Compare prices for 100 GiB a month in London from the AWS pricing pages: S3 Standard, S3 Standard-IA, Glacier Instant Retrieval, EFS Standard, EFS Infrequent Access, gp3 and io2.

## Learn more

- [How S3 Intelligent-Tiering works](https://docs.aws.amazon.com/AmazonS3/latest/userguide/intelligent-tiering.html)
- [Managing the lifecycle of objects](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lifecycle-mgmt.html)
- [What is Amazon Elastic File System?](https://docs.aws.amazon.com/efs/latest/ug/whatisefs.html)
- [Amazon EBS volume types](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-volume-types.html)
- [Mounting EFS file systems using the EFS mount helper](https://docs.aws.amazon.com/efs/latest/ug/mounting-fs-mount-helper-ec2-linux.html)

Everything this lab builds carries the tag `cloudlabs-lab = saa-14-storage` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
````

**`labs/_learning/saa-14-storage.yaml`**
```yaml
# Labs catalogue learning content (labs redesign spec §5). Outside the lab folder: editing it never needs a version bump.
objective: Measure block, file and object storage side by side and choose between them on speed and cost.
learn:
  - Compare gp3 and io2 volumes and what their IOPS cost
  - Share files between instances with EFS mount targets
  - Move objects between S3 storage classes with lifecycle rules
learning_min: 60
```

**The diagram** must contain: `resourceGroup lab-saa-14-storage · London`; `vnet vpc-lab` with `subnet snet-private-1/2`; `vm vm-storage`; `generic efs-shared`; `storage tiers`; `nsg sg-vms`, `sg-efs`, `sg-eice`; `bastion eice-lab`; `privateEndpoint vpce-s3`; no `aws_volume_attachment` or `aws_efs_mount_target` card (they fold in).

- [ ] **Step 1: Write the failing test** `scripts/test/labs-aws-saa-14.test.mjs`:

```js
// labs-aws-saa-14.test.mjs
//
// Plain English: lab saa-14-storage is the lab AWS labs spec §12.2 row 14
// describes: a bucket with Intelligent-Tiering and lifecycle, EFS with mount
// targets, and gp3 and io2 volumes on one instance, inside rule size's caps.

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { validateLearning } from "../lib/labs.mjs";

const ID = "saa-14-storage";

test("saa-14 keeps the AWS lab contract", () => assert.deepEqual(commonAwsProblems(ID), []));

test("saa-14's lab.yaml: §12.2 row 14, about £0.02/h", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["SAA-C03", "associate", "explore", ["saa.performance", "saa.cost"], []]);
  assert.deepEqual(yaml.timing, { deploy_min: 5, destroy_min: 4, session_h: 2, max_h: 6 });
  assert.deepEqual(yaml.connectivity, { peering: "optional", dns_link: false, subnets_used: 1 });
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.012 && total < 0.03, `about £0.02/h, got ${total}`);
});

test("saa-14's volumes: a gp3 and an io2 of 4 GiB, the io2 at 100 IOPS (under rule size's 500), untagged by name so nothing cycles", () => {
  const { tf } = awsLab(ID);
  for (const re of [/type\s+= "gp3"/, /type\s+= "io2"/, /iops\s+= 100/, /device_name = "\/dev\/sdf"/, /device_name = "\/dev\/sdg"/, /volume_tags\s+= var\.tags/]) assert.match(tf, re);
  for (const m of tf.matchAll(/resource "aws_ebs_volume" "\w+" \{[\s\S]*?\n\}/g)) assert.doesNotMatch(m[0], /tags\s+=/, "volumes carry only default tags (ruling A49)");
});

test("saa-14's EFS: encrypted, bursting, two mount targets after the tag wait, NFS only from the lab instances; mounted at boot", () => {
  const { tf } = awsLab(ID);
  for (const re of [/encrypted\s+= true/, /throughput_mode\s+= "bursting"/, /transition_to_ia = "AFTER_7_DAYS"/, /count\s+= 2\n\s+file_system_id/, /depends_on\s+= \[time_sleep\.efs_tags\]/, /from_port\s+= 2049/, /amazon-efs-utils/, /\/mnt\/efs efs _netdev,tls/]) assert.match(tf, re);
});

test("saa-14's bucket: Intelligent-Tiering with archive tiers, a logs/ lifecycle, force_destroy; readme and learning content", () => {
  const { tf, readme, learning, yaml } = awsLab(ID);
  for (const re of [/access_tier = "ARCHIVE_ACCESS"/, /storage_class = "INTELLIGENT_TIERING"/, /storage_class = "GLACIER_IR"/, /force_destroy = true/]) assert.match(tf, re);
  for (const s of ["gp3", "io2", "efs-shared", "INTELLIGENT_TIERING", "xfs_growfs"]) assert.ok(readme.includes(s), s);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test scripts/test/labs-aws-saa-14.test.mjs`
Expected: FAIL (no lab folder).

- [ ] **Step 3: Write the lab**: the files above; copy `versions.tf`, `main.tf`, `network.tf`; trim `variables.tf` to the seven variables named.

- [ ] **Step 4: Write the plan fixture** `saa-14-storage.mjs`: `[...templateResources(c), …]`, the instance (`al2023Instance(c, { key: "storage", name: "vm-storage", volumeName: null, userDataUnknown: true })`: the cloud-init names the file system's id), the two volumes (known: size, type, iops; `availability_zone` unknown with a reference to the subnet), the attachments, `sg-efs` and its rule, the file system (known: `creation_token`, settings), the wait, the two mount targets (`count`), the bucket and its pieces and two objects. `lab-plans.test.mjs` proves it.

- [ ] **Step 5: Generate the planned graph and the readme diagram**, `GOLDEN["saa-14-storage"]`, `AWS_LAB_IDS`.

- [ ] **Step 6: Run the checks**

Run: `node --test scripts/test/labs-aws-saa-14.test.mjs scripts/test/lab-plans.test.mjs scripts/test/labs-readmes.test.mjs scripts/test/labs-diagrams.test.mjs scripts/test/labs-learning-content.test.mjs`, then `npx vitest run worker/test/topology-golden.test.ts`, then `npm run labs-check`, `npm run labs-tf -- saa-14-storage`, `npm run labs-topology -- --check saa-14-storage`, `npm run labs-diagrams -- --check`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add labs/saa-14-storage labs/_learning/saa-14-storage.yaml shared/topology/planned/saa-14-storage.json shared/guides scripts/test worker/test
git commit -m "feat(aws labs): lab saa-14 storage choices: S3 classes, EFS, EBS gp3 and io2

Claude-Session: https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D"
```

---

### Task 11: Lab saa-15-data-security

Spec: §12.2 row 15 (secure, soa.security; associate; explore; £ 0.01; peering optional; 3/3; 2/6; prerequisite 07; customer key, SSE-KMS bucket, bucket policy, S3 gateway endpoint with policy, instance to test from); rulings A42, A68, A73 (no tag-checked KMS change at deploy), A81, P18.

**Files:**
- Create: `labs/saa-15-data-security/lab.yaml`, `readme.md`
- Create: `labs/saa-15-data-security/terraform/versions.tf`, `main.tf`, `network.tf` (copied unchanged), `variables.tf` (the template's `lab_id`, `name_prefix`, `region`, `address_space`, `gateway_cidr`, `admin_password`, `tags`), `kms.tf`, `s3.tf`, `endpoint.tf`, `compute.tf`, `outputs.tf`
- Create: `labs/_learning/saa-15-data-security.yaml`, `scripts/test/fixtures/labs/plans/labs/saa-15-data-security.mjs`
- Create (generated): `shared/topology/planned/saa-15-data-security.json`, `shared/guides/saa-15-data-security/**`
- Modify: `worker/test/topology-golden.test.ts`, `worker/test/fixtures/topology/round-trip.ts`
- Test: `scripts/test/labs-aws-saa-15.test.mjs`

**Interfaces:**
- Consumes: the template network; Task 3 (`endpointPolicyProblem`, SSE key rule), Task 6 (the endpoint policy folds into the endpoint).

**`labs/saa-15-data-security/lab.yaml`**
```yaml
# Lab saa-15 (AWS labs batch 3). SAA-C03 ((V) the wording against the current
# exam guide): Design Secure Architectures (encryption with a customer
# managed key, bucket policies, VPC endpoint policies); SOA-C03 Security and
# Compliance.
# London list prices × 0.75 (labs-verify --aws-prices). A customer managed
# key bills $1 a month, prorated by the hour (authored, V), and nothing while
# it waits 7 days to delete (spec §15, V).
id: saa-15-data-security
version: 1
cloud: aws
title: "Data security: KMS, bucket and endpoint policies"
summary: >-
  A bucket encrypted with the lab's own KMS key, a bucket policy that refuses unencrypted transport and the wrong
  encryption, and an S3 endpoint policy that lets the lab's instance reach only that bucket.
exam: SAA-C03
skill_areas: [saa.secure, soa.security]
level: associate
type: explore
prerequisites: [soa-07-iam-kms]
cost:
  items:
    - name: "EC2 t4g.nano, Linux"
      gbp_h: 0.0035
      aws_price: { service: AmazonEC2, unit: Hrs, filters: { instanceType: t4g.nano, operatingSystem: Linux, tenancy: Shared, preInstalledSw: NA, capacitystatus: Used } }
    - name: "EBS gp3 root volume, 8 GiB"
      gbp_h: 0.0008
      aws_price: { service: AmazonEC2, unit: GB-Mo, gb: 8, filters: { productFamily: Storage, volumeApiName: gp3 } }
    - { name: "KMS customer managed key ($1 a month, by the hour) and its requests", gbp_h: 0.0011 }
    - { name: "S3 storage and requests, a few kB", gbp_h: 0.0001 }
    - { name: "EC2 Instance Connect Endpoint", gbp_h: 0 }
  pricey: null
timing: { deploy_min: 3, destroy_min: 3, session_h: 2, max_h: 6 }
capacity: { instance_types: [t4g.nano] }
regions: { secondary: null }
connectivity: { peering: optional, dns_link: false, subnets_used: 1 }
identity:
  creates: [role]
  roles: []
  governance: false
```

**`labs/saa-15-data-security/terraform/kms.tf`**
```hcl
# kms.tf
#
# Plain English: lab 15's customer managed key, alias/lab-<id>-data, which
# encrypts the lab's bucket. Its key policy gives the account (its root)
# every KMS action, so IAM policies can grant use of it and it can always be
# deleted (the scope check refuses one without that). Deleting waits 7 days,
# at no charge. Automatic rotation stays off at deploy (a tag-checked change
# right after the create; ruling A73): switch it on by hand.

resource "aws_kms_key" "data" {
  description             = "lab ${var.lab_id}, encrypts the lab bucket"
  deletion_window_in_days = 7
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "TheAccountAndItsIamPolicies", Effect = "Allow", Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }, Action = "kms:*", Resource = "*" },
    ]
  })
  tags = { Name = "key-data" }
}

resource "aws_kms_alias" "data" {
  name          = "alias/lab-${var.lab_id}-data"
  target_key_id = aws_kms_key.data.key_id
}
```

**`labs/saa-15-data-security/terraform/s3.tf`**
```hcl
# s3.tf
#
# Plain English: lab 15's bucket, cloudlabs-<name_prefix>-data, private and
# encrypted by default with the lab's key (SSE-KMS, with an S3 Bucket Key so
# S3 asks KMS far less often). Its policy refuses any request not over TLS
# and any upload that asks for encryption other than KMS. It is known at plan,
# naming the bucket by its built ARN (ruling A68); restricting it to the lab's
# endpoint is a Thing to try (ruling P18).

locals {
  bucket     = "cloudlabs-${var.name_prefix}-data"
  bucket_arn = "arn:aws:s3:::cloudlabs-${var.name_prefix}-data"
}

resource "aws_s3_bucket" "data" {
  bucket        = local.bucket
  force_destroy = true
  tags          = { Name = "data" }
}

resource "aws_s3_bucket_public_access_block" "data" {
  bucket                  = aws_s3_bucket.data.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "data" {
  bucket = aws_s3_bucket.data.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.data.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_policy" "data" {
  bucket = aws_s3_bucket.data.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "TlsOnly", Effect = "Deny", Principal = "*", Action = "s3:*", Resource = [local.bucket_arn, "${local.bucket_arn}/*"], Condition = { Bool = { "aws:SecureTransport" = "false" } } },
      { Sid = "KmsUploadsOnly", Effect = "Deny", Principal = "*", Action = "s3:PutObject", Resource = "${local.bucket_arn}/*", Condition = { StringNotEqualsIfExists = { "s3:x-amz-server-side-encryption" = "aws:kms" } } },
    ]
  })
  depends_on = [aws_s3_bucket_public_access_block.data]
}

resource "aws_s3_object" "secret" {
  bucket       = aws_s3_bucket.data.id
  key          = "secret.txt"
  content      = "encrypted at rest with the lab's own key\n"
  content_type = "text/plain"
  depends_on   = [aws_s3_bucket_server_side_encryption_configuration.data]
}
```

**`labs/saa-15-data-security/terraform/endpoint.tf`**
```hcl
# endpoint.tf
#
# Plain English: a policy on the template's S3 gateway endpoint (ruling P18):
# through it the lab's instances may reach only the lab's own bucket and
# Amazon Linux's package repositories. Any other bucket, even a public one,
# is refused at the endpoint, whatever the instance's role allows.

resource "aws_vpc_endpoint_policy" "s3" {
  vpc_endpoint_id = aws_vpc_endpoint.s3.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "LabBucketOnly", Effect = "Allow", Principal = "*", Action = "s3:*", Resource = [local.bucket_arn, "${local.bucket_arn}/*"] },
      { Sid = "AmazonLinuxRepositories", Effect = "Allow", Principal = "*", Action = "s3:GetObject", Resource = "arn:aws:s3:::al2023-repos-${var.region}-*/*" },
    ]
  })
}
```

**`labs/saa-15-data-security/terraform/compute.tf`**
```hcl
# compute.tf
#
# Plain English: lab 15's test instance, vm-client (t4g.nano), running as
# lab-<id>-client under the lab boundary: it may list, read and write the
# lab's bucket, and use the lab's key only through S3 for that bucket
# (kms:ViaService and the encryption context, never the alias, which takes
# minutes to count; ruling A81). It has no other way out than the S3
# endpoint: no NAT gateway.

resource "aws_iam_role" "client" {
  name                 = "lab-${var.lab_id}-client"
  path                 = "/cloudlabs-lab/"
  permissions_boundary = local.boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_policy" "client" {
  name = "lab-${var.lab_id}-client"
  path = "/cloudlabs-lab/"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "LabBucket", Effect = "Allow", Action = ["s3:ListBucket", "s3:GetObject", "s3:PutObject"], Resource = [local.bucket_arn, "${local.bucket_arn}/*"] },
      {
        Sid       = "LabKeyThroughS3"
        Effect    = "Allow"
        Action    = ["kms:Decrypt", "kms:GenerateDataKey"]
        Resource  = "*"
        Condition = { StringEquals = { "kms:ViaService" = "s3.${var.region}.amazonaws.com" }, StringLike = { "kms:EncryptionContext:aws:s3:arn" = [local.bucket_arn, "${local.bucket_arn}/*"] } }
      },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "client" {
  role       = aws_iam_role.client.name
  policy_arn = aws_iam_policy.client.arn
}

resource "aws_iam_instance_profile" "client" {
  name = "lab-${var.lab_id}-client"
  path = "/cloudlabs-lab/"
  role = aws_iam_role.client.name
}

resource "aws_instance" "client" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.private[0].id
  vpc_security_group_ids = [aws_security_group.vms.id]
  iam_instance_profile   = aws_iam_instance_profile.client.name
  user_data              = local.cloud_init

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-client" })
  tags        = { Name = "vm-client" }
  depends_on  = [aws_iam_role_policy_attachment.client, aws_vpc_endpoint_policy.s3]
}
```

**`labs/saa-15-data-security/terraform/outputs.tf`**
```hcl
# outputs.tf
#
# Plain English: what the dashboard shows once lab 15 is up: how to connect
# to the test instance, the S3 lines to run there, and the endpoint's id for
# the bucket policy you write by hand.

output "private_ips" {
  value = { "vm-client" = aws_instance.client.private_ip }
}

output "connect" {
  value = [
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.client.id} --os-user labadmin --connection-type eice",
    "aws s3 cp s3://${aws_s3_bucket.data.bucket}/secret.txt - && aws s3api head-object --bucket ${aws_s3_bucket.data.bucket} --key secret.txt",
    "echo hi | aws s3 cp - s3://${aws_s3_bucket.data.bucket}/aes.txt --sse AES256",
    "the S3 endpoint for a bucket policy condition (aws:SourceVpce): ${aws_vpc_endpoint.s3.id}",
    "ssh labadmin@${aws_instance.client.private_ip}",
  ]
}

output "peer_vpc_id" {
  value = aws_vpc.lab.id
}

output "peer_route_table_ids" {
  value = [aws_route_table.private.id]
}
```

**`labs/saa-15-data-security/readme.md`** (exactly):
````markdown
Three layers that decide who can read data in S3: the KMS key that encrypts it, the bucket's own policy, and the VPC endpoint the request travels through. Each refuses things the others would allow, so you can watch a request pass one layer and fail the next. Everything is listed in the lab's resource group, `lab-saa-15-data-security`, in AWS Resource Groups (London).
From the SAA-C03 outline: design data security controls: encryption at rest with AWS KMS, encryption in transit, bucket policies and VPC endpoint policies.

## What it deploys

- The key `alias/lab-saa-15-data-security-data` (Name `key-data`), a customer managed KMS key whose policy lets the account's IAM policies grant its use
- The bucket `cloudlabs-<name prefix>-data`: encrypted by default with that key (SSE-KMS and an S3 Bucket Key), private; its policy refuses anything not over TLS and any upload asking for other encryption; one object, `secret.txt`
- A policy on the S3 gateway endpoint `vpce-s3`: through it only the lab's bucket and Amazon Linux's package repositories can be reached
- The instance `vm-client` (t4g.nano) running as the role `lab-saa-15-data-security-client`, which may read and write the bucket and use the key only through S3 for it; its only way out is the S3 endpoint

```text
lab-saa-15-data-security (London)
  vm-client [role client] --S3 endpoint vpce-s3 (policy: lab bucket + AL2023 repos only)--> cloudlabs-<prefix>-data
  cloudlabs-<prefix>-data: SSE-KMS with key-data; bucket policy: TLS only, KMS uploads only
  key-data: the account's IAM policies may grant it; the client's role uses it only via S3
```

## Things to try

- Connect (the first Connect line) and run the second: the object reads back, and `head-object` shows `ServerSideEncryption: aws:kms` and the key's ARN.
- Run the third line: the upload asks for AES256, so the bucket policy refuses it. Run it again without `--sse AES256`: the bucket's default encryption uses the lab's key.
- From the instance, try `aws s3 ls s3://<any other bucket of yours>`: the endpoint policy refuses it before the bucket ever sees the request, even though your role would allow it.
- Disable the key (KMS, the key, Key actions, Disable), then read `secret.txt` again: the object is still there, but nobody can decrypt it. Enable it again.
- Add a statement to the bucket policy denying `s3:GetObject` unless `aws:SourceVpce` is the endpoint id (the fourth Connect line). Now the instance can read the object and you, in the console, cannot. Remove the statement before tear-down if you want the console to see the bucket.

## Learn more

- [Using server-side encryption with AWS KMS keys (SSE-KMS)](https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingKMSEncryption.html)
- [Reducing the cost of SSE-KMS with Amazon S3 Bucket Keys](https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucket-key.html)
- [Gateway endpoints for Amazon S3](https://docs.aws.amazon.com/vpc/latest/privatelink/vpc-endpoints-s3.html)
- [Controlling access from VPC endpoints with bucket policies](https://docs.aws.amazon.com/AmazonS3/latest/userguide/example-bucket-policies-vpc-endpoint.html)
- [Key policies in AWS KMS](https://docs.aws.amazon.com/kms/latest/developerguide/key-policies.html)

Everything this lab builds carries the tag `cloudlabs-lab = saa-15-data-security` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
````

**`labs/_learning/saa-15-data-security.yaml`**
```yaml
# Labs catalogue learning content (labs redesign spec §5). Outside the lab folder: editing it never needs a version bump.
objective: Protect data in S3 with a customer managed key, a bucket policy and an endpoint policy, and test each.
learn:
  - Encrypt a bucket by default with a customer managed KMS key
  - Refuse plain HTTP and the wrong encryption with a bucket policy
  - Limit what a VPC can reach in S3 with an endpoint policy
learning_min: 45
```

**The diagram** must contain: `resourceGroup lab-saa-15-data-security · London`; `vnet vpc-lab` with `subnet snet-private-1/2`; `vm vm-client`; `storage data`; `keyVault key-data`; `privateEndpoint vpce-s3`; `managedIdentity lab-saa-15-data-security-client`; `nsg sg-vms`, `sg-eice`; `bastion eice-lab`.

- [ ] **Step 1: Write the failing test** `scripts/test/labs-aws-saa-15.test.mjs`:

```js
// labs-aws-saa-15.test.mjs
//
// Plain English: lab saa-15-data-security is the lab AWS labs spec §12.2 row
// 15 describes: a customer key, an SSE-KMS bucket, a bucket policy, an S3
// endpoint with a policy, and an instance to test from (ruling P18).

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { validateLearning } from "../lib/labs.mjs";
import { endpointPolicyProblem } from "../../infra/ci/lab-scope-aws.mjs";

const ID = "saa-15-data-security";

test("saa-15 keeps the AWS lab contract", () => assert.deepEqual(commonAwsProblems(ID), []));

test("saa-15's lab.yaml: §12.2 row 15, after soa-07, about £0.01/h", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["SAA-C03", "associate", "explore", ["saa.secure", "soa.security"], ["soa-07-iam-kms"]]);
  assert.deepEqual(yaml.timing, { deploy_min: 3, destroy_min: 3, session_h: 2, max_h: 6 });
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.003 && total < 0.015, `about £0.01/h, got ${total}`);
});

test("saa-15's key and bucket: 7-day deletion, the root's kms:*, no rotation at deploy; SSE-KMS with a Bucket Key; TLS-only and KMS-only policy", () => {
  const { tf } = awsLab(ID);
  for (const re of [/deletion_window_in_days = 7/, /Action = "kms:\*"/, /sse_algorithm\s+= "aws:kms"/, /kms_master_key_id = aws_kms_key\.data\.arn/, /bucket_key_enabled = true/, /"aws:SecureTransport" = "false"/, /StringNotEqualsIfExists = \{ "s3:x-amz-server-side-encryption" = "aws:kms" \}/]) assert.match(tf, re);
  assert.doesNotMatch(tf, /enable_key_rotation\s+= true/);
});

test("saa-15's endpoint policy allows only the lab bucket and AL2023's repositories (ruling P18); the role uses the key only via S3", () => {
  const { tf } = awsLab(ID);
  assert.match(tf, /resource "aws_vpc_endpoint_policy" "s3"/);
  assert.match(tf, /"kms:ViaService" = "s3\.\$\{var\.region\}\.amazonaws\.com"/);
  const doc = { Statement: [{ Effect: "Allow", Principal: "*", Action: "s3:*", Resource: ["arn:aws:s3:::cloudlabs-a15k3x9q-data", "arn:aws:s3:::cloudlabs-a15k3x9q-data/*"] }, { Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: "arn:aws:s3:::al2023-repos-eu-west-2-*/*" }] };
  assert.equal(endpointPolicyProblem(doc, "a15k3x9q", "eu-west-2"), null);
});

test("saa-15's readme tests each layer and its learning content is valid", () => {
  const { readme, learning, yaml } = awsLab(ID);
  for (const s of ["aws:kms", "--sse AES256", "aws:SourceVpce", "Disable"]) assert.ok(readme.includes(s), s);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test scripts/test/labs-aws-saa-15.test.mjs`
Expected: FAIL (no lab folder).

- [ ] **Step 3: Write the lab**: the files above; copy `versions.tf`, `main.tf`, `network.tf`; trim `variables.tf` to the seven variables named.

- [ ] **Step 4: Write the plan fixture** `saa-15-data-security.mjs`: `[...templateResources(c), …]`, the key (policy known: the account from the caller identity), the alias, the bucket and its pieces (the SSE configuration's `kms_master_key_id` unknown with a reference to the key), the bucket policy and the endpoint policy (both known at plan), the object, the role, policy (known), attachment, profile, and the instance (`al2023Instance(c, { key: "client", name: "vm-client", type: "t4g.nano", profile: "aws_iam_instance_profile.client" })`). `lab-plans.test.mjs` proves it.

- [ ] **Step 5: Generate the planned graph and the readme diagram**, `GOLDEN["saa-15-data-security"]`, `AWS_LAB_IDS`.

- [ ] **Step 6: Run the checks**

Run: `node --test scripts/test/labs-aws-saa-15.test.mjs scripts/test/lab-plans.test.mjs scripts/test/labs-readmes.test.mjs scripts/test/labs-diagrams.test.mjs scripts/test/labs-learning-content.test.mjs`, then `npx vitest run worker/test/topology-golden.test.ts`, then `npm run labs-check`, `npm run labs-tf -- saa-15-data-security`, `npm run labs-topology -- --check saa-15-data-security`, `npm run labs-diagrams -- --check`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add labs/saa-15-data-security labs/_learning/saa-15-data-security.yaml shared/topology/planned/saa-15-data-security.json shared/guides scripts/test worker/test
git commit -m "feat(aws labs): lab saa-15 data security: KMS, bucket and endpoint policies

Claude-Session: https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D"
```

---
### Task 12: Lab saa-16-dr-pilot-light

Spec: §4 (the secondary provider; a second resource group there), §12.2 row 16 (resilient, soa.reliability; associate; explore; £ 0.02; peering optional; 12/12; 2/4; prerequisite 04; S3 cross-region replication, DynamoDB global table, private-zone failover records on a CloudWatch-alarm health check, AMI copied to Ireland), §14 item 3, §15 (Route 53 zone charge); rulings A49, A60, P3–P6, P10, P19.

**Files:**
- Create: `labs/saa-16-dr-pilot-light/lab.yaml`, `readme.md`
- Create: `labs/saa-16-dr-pilot-light/terraform/versions.tf`, `main.tf`, `network.tf` (copied unchanged), `variables.tf` (the template's `lab_id`, `name_prefix`, `region`, `secondary_region`, `address_space`, `gateway_cidr`, `admin_password`, `tags`), `ireland.tf`, `app.tf`, `data.tf`, `dns.tf`, `ami.tf`, `outputs.tf`
- Create: `labs/_learning/saa-16-dr-pilot-light.yaml`, `scripts/test/fixtures/labs/plans/labs/saa-16-dr-pilot-light.mjs`
- Create (generated): `shared/topology/planned/saa-16-dr-pilot-light.json`, `shared/guides/saa-16-dr-pilot-light/**`
- Modify: `scripts/test/fixtures/labs/plans/realistic.mjs` (a resource description may name `providerKey: "aws.secondary"`: its `provider_config_key`, and its default `region` the plan's `secondary_region`), `scripts/test/lab-plans.test.mjs` (a test for it), `worker/test/topology-golden.test.ts`, `worker/test/fixtures/topology/round-trip.ts`
- Test: `scripts/test/labs-aws-saa-16.test.mjs`

**Interfaces:**
- Consumes: Task 1 (`AWS_DNS_LABS`), Task 2 (P3's replica rights, P4's `CopyImage`, the DynamoDB replication role made ahead), Task 3 (replica, copy, private zone, health check rules), Task 4 (tables by name, replicas first, AMIs by name), Task 5 (us-east-1 and Ireland reads), Task 6 (replica fold).

**`labs/saa-16-dr-pilot-light/lab.yaml`**
```yaml
# Lab saa-16 (AWS labs batch 3). SAA-C03 ((V) the wording against the current
# exam guide): Design Resilient Architectures (disaster recovery strategies:
# pilot light); SOA-C03 Reliability and Business Continuity.
# London list prices × 0.75 (labs-verify --aws-prices). Route 53 bills a
# hosted zone and a health check by the month; a zone deleted within 12 hours
# is believed not to be charged (spec §15, V; Task 17 reads Cost Explorer).
# The AMI copy's snapshot and the Ireland replica hold kB to a few GB
# (authored, region: secondary).
id: saa-16-dr-pilot-light
version: 1
cloud: aws
title: "Pilot-light DR across London and Ireland"
summary: >-
  An app in London with its data already copied to Ireland (S3 cross-region replication, a DynamoDB global table)
  and its image copied there too, and a private DNS name that fails over to Ireland when London's health alarm fires.
exam: SAA-C03
skill_areas: [saa.resilient, soa.reliability]
level: associate
type: explore
prerequisites: [soa-04-backup]
cost:
  items:
    - name: "EC2 t4g.nano, Linux (the London app)"
      gbp_h: 0.0035
      aws_price: { service: AmazonEC2, unit: Hrs, filters: { instanceType: t4g.nano, operatingSystem: Linux, tenancy: Shared, preInstalledSw: NA, capacitystatus: Used } }
    - name: "EBS gp3 root volume, 8 GiB"
      gbp_h: 0.0008
      aws_price: { service: AmazonEC2, unit: GB-Mo, gb: 8, filters: { productFamily: Storage, volumeApiName: gp3 } }
    - { name: "Route 53 private hosted zone ($0.50 a month)", gbp_h: 0.0005 }
    - { name: "Route 53 health check on a CloudWatch alarm ($0.50 a month)", gbp_h: 0.0005 }
    - { name: "CloudWatch alarm", gbp_h: 0.0001 }
    - { name: "The AMI copy's snapshot in Ireland, about 2 GB", gbp_h: 0.0001, region: secondary }
    - { name: "DynamoDB global table on demand and S3 replication, a few kB", gbp_h: 0.0001 }
    - { name: "EC2 Instance Connect Endpoints (London and Ireland)", gbp_h: 0 }
  pricey: null
timing: { deploy_min: 12, destroy_min: 12, session_h: 2, max_h: 4 }
capacity: { instance_types: [t4g.nano] }
regions: { secondary: eu-west-1 }
connectivity: { peering: optional, dns_link: false, subnets_used: 2 }
identity:
  creates: [role]
  roles: []
  governance: false
```

**`labs/saa-16-dr-pilot-light/terraform/ireland.tf`**
```hcl
# ireland.tf
#
# Plain English: lab 16's pilot light in Ireland (eu-west-1, the session's
# secondary region; ruling P19). The second aws provider, alias secondary,
# exactly as spec §4 writes it, and the lab's resource group there (groups
# are regional). A VPC of its own, the slot's second /20, with one private
# subnet, a free S3 gateway endpoint, an Instance Connect Endpoint and a
# security group for the DR instance; and a launch template, lt-<prefix>-dr,
# from the AMI copied from London. Nothing runs here: launching the DR
# instance is a Thing to try, at a fixed address (local.dr_ip) the private
# zone already names.

provider "aws" {
  alias  = "secondary"
  region = var.secondary_region
  default_tags {
    tags = var.tags
  }
}

data "aws_availability_zones" "dr" {
  provider = aws.secondary
  state    = "available"
}

locals {
  dr_vpc_cidr    = cidrsubnet(var.address_space, 2, 1)
  dr_subnet_cidr = cidrsubnet(local.dr_vpc_cidr, 4, 0)
  dr_ip          = cidrhost(local.dr_subnet_cidr, 10)
  dr_unit = join("\n", [
    "[Unit]",
    "Description=Lab 16 app page on port 80 (Ireland, DR)",
    "After=network-online.target",
    "[Service]",
    "ExecStartPre=/bin/sh -c 'mkdir -p /srv/www && echo \"app in Ireland (DR)\" > /srv/www/index.html'",
    "ExecStart=/usr/bin/python3 -m http.server 80 --directory /srv/www",
    "Restart=always",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ])
  dr_cloud_init = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [{ path = "/etc/systemd/system/lab-app.service", permissions = "0644", content = local.dr_unit }]
    runcmd      = ["systemctl daemon-reload", "systemctl enable --now lab-app.service"]
  }))}"
}

resource "aws_resourcegroups_group" "secondary" {
  provider = aws.secondary
  name     = "lab-${var.lab_id}"

  resource_query {
    type = "TAG_FILTERS_1_0"
    query = jsonencode({
      ResourceTypeFilters = ["AWS::AllSupported"]
      TagFilters          = [{ Key = "cloudlabs-lab", Values = [var.lab_id] }]
    })
  }
}

resource "aws_vpc" "dr" {
  provider             = aws.secondary
  cidr_block           = local.dr_vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "vpc-dr" }
}

resource "aws_subnet" "dr" {
  provider                = aws.secondary
  vpc_id                  = aws_vpc.dr.id
  cidr_block              = local.dr_subnet_cidr
  availability_zone       = data.aws_availability_zones.dr.names[0]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-dr" }
}

resource "aws_route_table" "dr" {
  provider = aws.secondary
  vpc_id   = aws_vpc.dr.id
  tags     = { Name = "rt-dr" }
}

resource "aws_route_table_association" "dr" {
  provider       = aws.secondary
  subnet_id      = aws_subnet.dr.id
  route_table_id = aws_route_table.dr.id
}

resource "aws_vpc_endpoint" "dr_s3" {
  provider          = aws.secondary
  vpc_id            = aws_vpc.dr.id
  service_name      = "com.amazonaws.${var.secondary_region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.dr.id]
  tags              = { Name = "vpce-s3-dr" }
}

resource "aws_security_group" "dr_eice" {
  provider    = aws.secondary
  name        = "lab-eice-dr"
  description = "EC2 Instance Connect Endpoint in Ireland: SSH out to the DR instance"
  vpc_id      = aws_vpc.dr.id
  tags        = { Name = "sg-eice-dr" }
}

resource "aws_vpc_security_group_egress_rule" "dr_eice_ssh" {
  provider          = aws.secondary
  security_group_id = aws_security_group.dr_eice.id
  cidr_ipv4         = local.dr_vpc_cidr
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}

resource "aws_ec2_instance_connect_endpoint" "dr" {
  provider           = aws.secondary
  subnet_id          = aws_subnet.dr.id
  security_group_ids = [aws_security_group.dr_eice.id]
  preserve_client_ip = false
  tags               = { Name = "eice-dr" }
}

resource "aws_security_group" "dr" {
  provider    = aws.secondary
  name        = "lab-dr"
  description = "The DR instance: SSH from the Instance Connect Endpoint, HTTP inside its VPC"
  vpc_id      = aws_vpc.dr.id
  tags        = { Name = "sg-dr" }
}

resource "aws_vpc_security_group_ingress_rule" "dr_ssh_eice" {
  provider                     = aws.secondary
  security_group_id            = aws_security_group.dr.id
  referenced_security_group_id = aws_security_group.dr_eice.id
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
}

resource "aws_vpc_security_group_ingress_rule" "dr_http" {
  provider          = aws.secondary
  security_group_id = aws_security_group.dr.id
  cidr_ipv4         = local.dr_vpc_cidr
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_egress_rule" "dr_all" {
  provider          = aws.secondary
  security_group_id = aws_security_group.dr.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_launch_template" "dr" {
  provider               = aws.secondary
  name                   = "lt-${var.name_prefix}-dr"
  image_id               = aws_ami_copy.dr.id
  instance_type          = "t4g.nano"
  user_data              = base64encode(local.dr_cloud_init)
  update_default_version = true

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size           = 8
      volume_type           = "gp3"
      delete_on_termination = true
    }
  }
  tag_specifications {
    resource_type = "instance"
    tags          = merge(var.tags, { Name = "vm-dr" })
  }
  tag_specifications {
    resource_type = "volume"
    tags          = merge(var.tags, { Name = "vm-dr" })
  }
  tag_specifications {
    resource_type = "network-interface"
    tags          = merge(var.tags, { Name = "vm-dr" })
  }
  tags = { Name = "lt-dr" }
}
```

**`labs/saa-16-dr-pilot-light/terraform/app.tf`**
```hcl
# app.tf
#
# Plain English: lab 16's app in London, vm-app (t4g.nano), serving a page
# that says where it runs, and the alarm that decides failover:
# lab-<id>-app-down fires when the instance's status checks fail for two
# minutes, or when it stops reporting at all (missing data counts as failing),
# which is what stopping or losing the instance looks like.

locals {
  app_unit = join("\n", [
    "[Unit]",
    "Description=Lab 16 app page on port 80 (London, primary)",
    "After=network-online.target",
    "[Service]",
    "ExecStartPre=/bin/sh -c 'mkdir -p /srv/www && echo \"app in London (primary)\" > /srv/www/index.html'",
    "ExecStart=/usr/bin/python3 -m http.server 80 --directory /srv/www",
    "Restart=always",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ])
  app_cloud_init = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [{ path = "/etc/systemd/system/lab-app.service", permissions = "0644", content = local.app_unit }]
    runcmd      = ["systemctl daemon-reload", "systemctl enable --now lab-app.service"]
  }))}"
}

resource "aws_instance" "app" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.private[0].id
  vpc_security_group_ids = [aws_security_group.vms.id]
  user_data              = local.app_cloud_init

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-app" })
  tags        = { Name = "vm-app" }
  depends_on  = [aws_vpc_endpoint.s3]
}

resource "aws_cloudwatch_metric_alarm" "app_down" {
  alarm_name          = "lab-${var.lab_id}-app-down"
  alarm_description   = "lab ${var.lab_id}: the London app's status checks fail, or it stops reporting"
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "breaching"
  dimensions          = { InstanceId = aws_instance.app.id }
  tags                = { Name = "alarm-app-down" }
}
```

**`labs/saa-16-dr-pilot-light/terraform/data.tf`**
```hcl
# data.tf
#
# Plain English: lab 16's data, already in Ireland. Two buckets,
# cloudlabs-<name_prefix>-london and -ireland, versioned and removable; every
# object and delete marker put in London is replicated to Ireland by the
# lab's own role (its documents name both buckets by their ARNs, known at
# plan). And a DynamoDB table, lab-<id>-orders, on demand, with a replica in
# Ireland that carries the lab's tags (a global table; rulings P3, P10).

locals {
  london_bucket  = "cloudlabs-${var.name_prefix}-london"
  ireland_bucket = "cloudlabs-${var.name_prefix}-ireland"
  london_arn     = "arn:aws:s3:::cloudlabs-${var.name_prefix}-london"
  ireland_arn    = "arn:aws:s3:::cloudlabs-${var.name_prefix}-ireland"
}

resource "aws_s3_bucket" "london" {
  bucket        = local.london_bucket
  force_destroy = true
  tags          = { Name = "london" }
}

resource "aws_s3_bucket" "ireland" {
  provider      = aws.secondary
  bucket        = local.ireland_bucket
  force_destroy = true
  tags          = { Name = "ireland" }
}

resource "aws_s3_bucket_public_access_block" "london" {
  bucket                  = aws_s3_bucket.london.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_public_access_block" "ireland" {
  provider                = aws.secondary
  bucket                  = aws_s3_bucket.ireland.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "london" {
  bucket = aws_s3_bucket.london.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_versioning" "ireland" {
  provider = aws.secondary
  bucket   = aws_s3_bucket.ireland.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_iam_role" "replication" {
  name                 = "lab-${var.lab_id}-replication"
  path                 = "/cloudlabs-lab/"
  permissions_boundary = local.boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "s3.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_policy" "replication" {
  name = "lab-${var.lab_id}-replication"
  path = "/cloudlabs-lab/"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:GetReplicationConfiguration", "s3:ListBucket"], Resource = local.london_arn },
      { Effect = "Allow", Action = ["s3:GetObjectVersionForReplication", "s3:GetObjectVersionAcl", "s3:GetObjectVersionTagging"], Resource = "${local.london_arn}/*" },
      { Effect = "Allow", Action = ["s3:ReplicateObject", "s3:ReplicateDelete", "s3:ReplicateTags"], Resource = "${local.ireland_arn}/*" },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "replication" {
  role       = aws_iam_role.replication.name
  policy_arn = aws_iam_policy.replication.arn
}

# A new role takes a moment to reach S3 (as lab 04 found).
resource "time_sleep" "replication_role" {
  create_duration = "20s"
  depends_on      = [aws_iam_role_policy_attachment.replication]
}

resource "aws_s3_bucket_replication_configuration" "london" {
  bucket = aws_s3_bucket.london.id
  role   = aws_iam_role.replication.arn
  rule {
    id     = "to-ireland"
    status = "Enabled"
    filter {}
    delete_marker_replication {
      status = "Enabled"
    }
    destination {
      bucket        = aws_s3_bucket.ireland.arn
      storage_class = "STANDARD"
    }
  }
  depends_on = [aws_s3_bucket_versioning.london, aws_s3_bucket_versioning.ireland, time_sleep.replication_role]
}

resource "aws_s3_object" "hello" {
  bucket       = aws_s3_bucket.london.id
  key          = "hello.txt"
  content      = "written in London, replicated to Ireland\n"
  content_type = "text/plain"
  depends_on   = [aws_s3_bucket_replication_configuration.london]
}

resource "aws_dynamodb_table" "orders" {
  name                        = "lab-${var.lab_id}-orders"
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "id"
  stream_enabled              = true
  stream_view_type            = "NEW_AND_OLD_IMAGES"
  deletion_protection_enabled = false

  attribute {
    name = "id"
    type = "S"
  }
  replica {
    region_name    = var.secondary_region
    propagate_tags = true
  }
  tags = { Name = "table-orders" }
}
```

**`labs/saa-16-dr-pilot-light/terraform/dns.tf`**
```hcl
# dns.tf
#
# Plain English: lab 16's failover name. A private hosted zone,
# dr.<name_prefix>.internal, answering only inside the lab's two VPCs
# (ruling P6), and one name in it, app: London's address while the health
# check is healthy, Ireland's standby address when it is not. Private zones
# cannot probe an address, so the health check follows the London alarm
# (a CloudWatch-metric health check; healthy while the alarm has no data yet,
# at deploy).

resource "aws_route53_zone" "dr" {
  name          = "dr.${var.name_prefix}.internal"
  force_destroy = true
  vpc {
    vpc_id     = aws_vpc.lab.id
    vpc_region = var.region
  }
  vpc {
    vpc_id     = aws_vpc.dr.id
    vpc_region = var.secondary_region
  }
  tags = { Name = "zone-dr" }
}

resource "aws_route53_health_check" "app" {
  type                            = "CLOUDWATCH_METRIC"
  cloudwatch_alarm_name           = aws_cloudwatch_metric_alarm.app_down.alarm_name
  cloudwatch_alarm_region         = var.region
  insufficient_data_health_status = "Healthy"
  tags                            = { Name = "hc-app" }
}

resource "aws_route53_record" "app_london" {
  zone_id         = aws_route53_zone.dr.zone_id
  name            = "app.${aws_route53_zone.dr.name}"
  type            = "A"
  ttl             = 30
  records         = [aws_instance.app.private_ip]
  set_identifier  = "london"
  health_check_id = aws_route53_health_check.app.id
  failover_routing_policy {
    type = "PRIMARY"
  }
}

resource "aws_route53_record" "app_ireland" {
  zone_id        = aws_route53_zone.dr.zone_id
  name           = "app.${aws_route53_zone.dr.name}"
  type           = "A"
  ttl            = 30
  records        = [local.dr_ip]
  set_identifier = "ireland"
  failover_routing_policy {
    type = "SECONDARY"
  }
}
```

**`labs/saa-16-dr-pilot-light/terraform/ami.tf`**
```hcl
# ami.tf
#
# Plain English: lab 16's image in Ireland: Amazon Linux 2023 (arm64), the
# image London runs, copied from London so a DR launch never depends on
# London (ruling P4: a copy of AWS's own public image, named lab-<id>-*,
# which the safety net also finds by name, with its snapshot). The copy
# takes a few minutes.

resource "aws_ami_copy" "dr" {
  provider          = aws.secondary
  name              = "lab-${var.lab_id}-al2023-${var.name_prefix}"
  description       = "lab ${var.lab_id}: Amazon Linux 2023 (arm64) from London, for a DR launch in Ireland"
  source_ami_id     = data.aws_ssm_parameter.al2023_arm64.insecure_value
  source_ami_region = var.region
  tags              = { Name = "ami-dr" }
}
```

**`labs/saa-16-dr-pilot-light/terraform/outputs.tf`**
```hcl
# outputs.tf
#
# Plain English: what the dashboard shows once lab 16 is up: the London app's
# address and the Ireland standby address, and the lines for the Things to
# try: connect, resolve the failover name, launch the DR instance, and check
# the data reached Ireland.

output "private_ips" {
  value = { "vm-app" = aws_instance.app.private_ip, "Ireland standby (when launched)" = local.dr_ip }
}

output "connect" {
  value = [
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.app.id} --os-user labadmin --connection-type eice",
    "getent hosts app.${aws_route53_zone.dr.name}",
    "aws ec2 run-instances --region ${var.secondary_region} --launch-template LaunchTemplateId=${aws_launch_template.dr.id},Version='$Latest' --network-interfaces DeviceIndex=0,SubnetId=${aws_subnet.dr.id},PrivateIpAddress=${local.dr_ip},Groups=${aws_security_group.dr.id}",
    "aws dynamodb put-item --region ${var.region} --table-name ${aws_dynamodb_table.orders.name} --item '{\"id\":{\"S\":\"o-1\"}}' && aws dynamodb get-item --region ${var.secondary_region} --table-name ${aws_dynamodb_table.orders.name} --key '{\"id\":{\"S\":\"o-1\"}}'",
    "echo hi | aws s3 cp - s3://${aws_s3_bucket.london.bucket}/hi.txt && sleep 30 && aws s3api head-object --bucket ${aws_s3_bucket.london.bucket} --key hi.txt --query ReplicationStatus",
  ]
}

output "peer_vpc_id" {
  value = aws_vpc.lab.id
}

output "peer_route_table_ids" {
  value = [aws_route_table.private.id]
}
```

**`labs/saa-16-dr-pilot-light/readme.md`** (exactly):
````markdown
Pilot-light disaster recovery: the app runs only in London, but everything needed to run it in Ireland is already there. Its data is copied as it is written (S3 cross-region replication and a DynamoDB global table), its image has been copied to Ireland, and a launch template and a fixed standby address wait in an Ireland VPC. A private DNS name points at London while London's health alarm is quiet and at Ireland when it fires. Everything is listed in the lab's resource groups, `lab-saa-16-dr-pilot-light`, in AWS Resource Groups (London and Ireland; the DNS zone and health check are global).
From the SAA-C03 outline: design disaster recovery strategies (backup and restore, pilot light, warm standby) across Regions, meeting recovery time and point objectives.

## What it deploys

- **London**: the VPC `vpc-lab` with the app instance `vm-app` (t4g.nano, a page saying "app in London (primary)") and the alarm `lab-saa-16-dr-pilot-light-app-down` (status checks failing, or no data at all)
- **Ireland**: the VPC `vpc-dr` (the slot's second /20) with the subnet `snet-dr`, an S3 gateway endpoint, an Instance Connect Endpoint `eice-dr`, the security group `sg-dr`, and the launch template `lt-<name prefix>-dr` built on `ami-dr`, the copy of London's Amazon Linux 2023 image. Nothing runs in Ireland
- **Data**: the buckets `cloudlabs-<name prefix>-london` and `-ireland`, versioned, with every object and delete marker replicated London to Ireland by the role `lab-saa-16-dr-pilot-light-replication`; the table `lab-saa-16-dr-pilot-light-orders`, a DynamoDB global table with its replica in Ireland
- **DNS**: the private zone `dr.<name prefix>.internal`, answering in both VPCs; the name `app` in it fails over from London's address to the Ireland standby address when the health check `hc-app` (following the alarm) turns unhealthy

```text
lab-saa-16-dr-pilot-light
  London: vm-app (snet-private-1) --alarm app-down--> hc-app
  app.dr.<prefix>.internal: PRIMARY vm-app (while hc-app healthy), SECONDARY Ireland standby address
  cloudlabs-<prefix>-london --replication--> cloudlabs-<prefix>-ireland
  table-orders (London) <--global table--> replica (Ireland)
  Ireland: vpc-dr, snet-dr, lt-dr on ami-dr (copied from London), nothing running
```

## Things to try

- Connect to `vm-app` (the first Connect line) and resolve the name with the second: London's address. Stop `vm-app` in the EC2 console (from your PC), wait three or four minutes for the alarm to fire and the health check to turn unhealthy, start it again and resolve the name once you are back in: you get Ireland's standby address until London has been healthy again for a few minutes. Watch the alarm and the health check change in their consoles.
- Run the DR drill: launch the DR instance in Ireland with the third Connect line (CloudShell), connect to it through `eice-dr` (`aws ec2-instance-connect ssh --region eu-west-1 --instance-id <id> --os-user labadmin --connection-type eice`), and `curl localhost`. How long did that take? That is the pilot light's recovery time. Terminate it when you are done; if you forget, the tear-down's safety net does it (the destroy then ends with a fallback).
- Write an order in London and read it in Ireland with the fourth line: a global table replicates within about a second.
- Upload a file to the London bucket with the fifth line: after a short while its replication status is `COMPLETED` and the copy is in the Ireland bucket. Delete it in London and see the delete marker arrive in Ireland too.
- Compare the four DR strategies in the AWS whitepaper below and decide what you would add to turn this pilot light into a warm standby, and what that would cost per hour.

## Learn more

- [Disaster recovery options in the cloud](https://docs.aws.amazon.com/whitepapers/latest/disaster-recovery-workloads-on-aws/disaster-recovery-options-in-the-cloud.html)
- [Replicating objects within and across Regions](https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication.html)
- [Global tables: multi-active, multi-Region replication](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GlobalTables.html)
- [Configuring failover in a private hosted zone](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/dns-failover-private-hosted-zones.html)
- [Copy an Amazon EC2 AMI](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/CopyingAMIs.html)

Everything this lab builds carries the tag `cloudlabs-lab = saa-16-dr-pilot-light` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
````

**`labs/_learning/saa-16-dr-pilot-light.yaml`**
```yaml
# Labs catalogue learning content (labs redesign spec §5). Outside the lab folder: editing it never needs a version bump.
objective: Keep an app's data and image ready in a second Region and fail its DNS name over when London goes quiet.
learn:
  - Replicate S3 objects and a DynamoDB table to a second Region
  - Fail a private DNS name over on a CloudWatch alarm health check
  - Launch the recovery instance from a copied image and time it
learning_min: 75
```

**The diagram** must contain: `resourceGroup lab-saa-16-dr-pilot-light · London` and `resourceGroup lab-saa-16-dr-pilot-light · Ireland`; `vnet vpc-lab` (London) with `subnet snet-private-1/2`; `vnet vpc-dr` (Ireland) with `subnet snet-dr`; `vm vm-app`; `monitor alarm-app-down`, `hc-app`; `dnsZone zone-dr`; `storage london` (London) with a `dependency` edge `replicates` to `storage ireland` (Ireland); `dynamodb table-orders`; `generic ami-dr` (Ireland); `bastion eice-lab`, `eice-dr`; `privateEndpoint vpce-s3`, `vpce-s3-dr`; `managedIdentity lab-saa-16-dr-pilot-light-replication`.

- [ ] **Step 1: Write the failing tests.** `scripts/test/labs-aws-saa-16.test.mjs`:

```js
// labs-aws-saa-16.test.mjs
//
// Plain English: lab saa-16-dr-pilot-light is the lab AWS labs spec §12.2
// row 16 describes, the first two-region lab: S3 cross-region replication, a
// DynamoDB global table, private-zone failover on a CloudWatch-alarm health
// check, and an AMI copied to Ireland (rulings P3–P6, P19).

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { AWS_DNS_LABS, AWS_GLOBAL_LABS, validateLearning } from "../lib/labs.mjs";

const ID = "saa-16-dr-pilot-light";

test("saa-16 keeps the AWS lab contract; Ireland is its secondary region and it lists Route 53 in us-east-1", () => {
  assert.deepEqual(commonAwsProblems(ID), []);
  const { yaml } = awsLab(ID);
  assert.deepEqual(yaml.regions, { secondary: "eu-west-1" });
  assert.ok(AWS_DNS_LABS.includes(ID) && !AWS_GLOBAL_LABS.includes(ID));
});

test("saa-16's lab.yaml: §12.2 row 16, after soa-04, two /20s, pennies an hour", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["SAA-C03", "associate", "explore", ["saa.resilient", "soa.reliability"], ["soa-04-backup"]]);
  assert.deepEqual(yaml.timing, { deploy_min: 12, destroy_min: 12, session_h: 2, max_h: 4 });
  assert.deepEqual(yaml.connectivity, { peering: "optional", dns_link: false, subnets_used: 2 });
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.003 && total < 0.03, `pennies an hour, got ${total}`);
});

test("saa-16's Ireland: the secondary provider exactly as §4, its own resource group, VPC in the slot's second /20, nothing running", () => {
  const { files, tf } = awsLab(ID);
  assert.match(files["ireland.tf"], /provider "aws" \{\n  alias  = "secondary"\n  region = var\.secondary_region\n  default_tags \{\n    tags = var\.tags\n  \}\n\}/);
  for (const re of [/resource "aws_resourcegroups_group" "secondary" \{\n  provider = aws\.secondary/, /dr_vpc_cidr\s+= cidrsubnet\(var\.address_space, 2, 1\)/, /image_id\s+= aws_ami_copy\.dr\.id/]) assert.match(tf, re);
  assert.doesNotMatch(files["ireland.tf"], /resource "aws_instance"|resource "aws_autoscaling_group"/, "a pilot light runs nothing in Ireland");
});

test("saa-16's data and image: replication to the Ireland bucket, a global table replica with its tags, a copy of the public AMI named for the lab", () => {
  const { tf } = awsLab(ID);
  for (const re of [/bucket\s+= aws_s3_bucket\.ireland\.arn/, /delete_marker_replication \{\n\s+status = "Enabled"/, /region_name\s+= var\.secondary_region\n\s+propagate_tags = true/, /stream_enabled\s+= true/, /name\s+= "lab-\$\{var\.lab_id\}-orders"/, /source_ami_id\s+= data\.aws_ssm_parameter\.al2023_arm64\.insecure_value/, /name\s+= "lab-\$\{var\.lab_id\}-al2023-\$\{var\.name_prefix\}"/]) assert.match(tf, re);
});

test("saa-16's failover: a private .internal zone in both lab VPCs, a CloudWatch-metric health check on the lab's alarm, PRIMARY and SECONDARY records", () => {
  const { tf } = awsLab(ID);
  for (const re of [/name\s+= "dr\.\$\{var\.name_prefix\}\.internal"/, /vpc_id\s+= aws_vpc\.lab\.id/, /vpc_id\s+= aws_vpc\.dr\.id/, /type\s+= "CLOUDWATCH_METRIC"/, /cloudwatch_alarm_name\s+= aws_cloudwatch_metric_alarm\.app_down\.alarm_name/, /treat_missing_data\s+= "breaching"/, /type = "PRIMARY"/, /type = "SECONDARY"/, /records\s+= \[local\.dr_ip\]/]) assert.match(tf, re);
});

test("saa-16's readme runs a DR drill and its learning content is valid", () => {
  const { readme, learning, yaml } = awsLab(ID);
  for (const s of ["pilot light", "eice-dr", "COMPLETED", "global table", "fallback"]) assert.ok(readme.includes(s), s);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
```
`scripts/test/lab-plans.test.mjs` gains:
```js
test("ruling P5: a resource description with providerKey aws.secondary plans under that configuration, in the secondary region", () => {
  const plan = realisticPlan({ resources: [{ address: "aws_vpc.dr", providerKey: "aws.secondary", values: { cidr_block: "10.64.16.0/20" }, refs: {} }], data: [], providers: ["aws"], providerConfig: { "aws.secondary": { name: "aws", full_name: "registry.terraform.io/hashicorp/aws", alias: "secondary", expressions: { region: { references: ["var.secondary_region"] } } } }, variables: { region: "eu-west-2", secondary_region: "eu-west-1" } });
  assert.equal(plan.configuration.root_module.resources.find((r) => r.address === "aws_vpc.dr").provider_config_key, "aws.secondary");
  assert.equal(plan.planned_values.root_module.resources.find((r) => r.address === "aws_vpc.dr").values.region, "eu-west-1");
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test scripts/test/labs-aws-saa-16.test.mjs scripts/test/lab-plans.test.mjs`
Expected: FAIL (no lab folder; `providerKey` ignored).

- [ ] **Step 3: Teach `realistic.mjs` `providerKey`**: in the managed `configure(...)` call, `provider_config_key: def.providerKey ?? type.split("_")[0]`; in `providerDefaults`' caller, the region is `variables.secondary_region` when `def.providerKey === "aws.secondary"` (else as today). The header's description list gains "providerKey: a provider configuration key other than the type's (aws.secondary: lab 16's Ireland resources, planned in the secondary region)".

- [ ] **Step 4: Write the lab**: the files above; copy `versions.tf`, `main.tf`, `network.tf` unchanged; trim `variables.tf` to the eight variables named.

- [ ] **Step 5: Write the plan fixture** `saa-16-dr-pilot-light.mjs`: `variables: { ...c.variables, secondary_region: "eu-west-1" }`; `providerConfig: { ...AWS_PROVIDER_CONFIG, "aws.secondary": <Task 3's P5 configuration> }`; data: `awsData()` plus `data.aws_availability_zones.dr` (eu-west-1a, b, c); resources: `templateResources(c)`, every `ireland.tf` resource with `providerKey: "aws.secondary"` (the group, VPC `cidrsubnet(c.address, 2, 1)`, subnet, route table, association, endpoint `com.amazonaws.eu-west-1.s3`, the two security groups and their rules, EICE, launch template with `image_id` unknown referencing the copy), the app instance (`al2023Instance(c, { key: "app", name: "vm-app", type: "t4g.nano" })`), the alarm (dimensions unknown, referencing the instance), the buckets (Ireland's with `providerKey`), their pieces, the role and policy (known), the wait, the replication configuration, the object, the table (`replica: [{ region_name: "eu-west-1", propagate_tags: true }]`), the zone (`vpc` blocks with `vpc_region` known and `vpc_id` unknown, referencing each VPC), the health check (known alarm name and region), the two records, the AMI copy (`providerKey`, `source_ami_id: AMI`, `source_ami_region: "eu-west-2"`). `lab-plans.test.mjs` proves it, the scope check included.

- [ ] **Step 6: Generate the planned graph and the readme diagram**, `GOLDEN["saa-16-dr-pilot-light"]`, `AWS_LAB_IDS`.

- [ ] **Step 7: Run the checks**

Run: `node --test scripts/test/labs-aws-saa-16.test.mjs scripts/test/lab-plans.test.mjs scripts/test/labs-readmes.test.mjs scripts/test/labs-diagrams.test.mjs scripts/test/labs-learning-content.test.mjs`, then `npx vitest run worker/test/topology-golden.test.ts`, then `npm run labs-check`, `npm run labs-tf -- saa-16-dr-pilot-light`, `npm run labs-topology -- --check saa-16-dr-pilot-light`, `npm run labs-diagrams -- --check`
Expected: all PASS (labs-tf's mock plan sets `secondary_region`, so the secondary provider passes).

- [ ] **Step 8: Commit**

```bash
git add labs/saa-16-dr-pilot-light labs/_learning/saa-16-dr-pilot-light.yaml shared/topology/planned/saa-16-dr-pilot-light.json shared/guides scripts/test worker/test
git commit -m "feat(aws labs): lab saa-16 pilot-light DR across London and Ireland

Claude-Session: https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D"
```

---

### Task 13: Lab saa-17-data-pipeline

Spec: §12.2 row 17 (performance; associate; explore; £ 0.02; peering off; 5/5; 2/4; no prerequisites; Kinesis Data Streams (1 shard), producer Lambda on a schedule, Firehose to S3, Glue crawler, Athena workgroup), §9 (per-use charges named in the readme); rulings A56, A61, P11, P13–P15.

**Files:**
- Create: `labs/saa-17-data-pipeline/lab.yaml`, `readme.md`
- Create: `labs/saa-17-data-pipeline/terraform/versions.tf`, `main.tf` (copied unchanged; no `network.tf`), `variables.tf` (the template's `lab_id`, `name_prefix`, `region`, `tags`), `stream.tf`, `delivery.tf`, `catalog.tf`, `outputs.tf`, `lambda/producer.py`
- Create: `labs/_learning/saa-17-data-pipeline.yaml`, `scripts/test/fixtures/labs/plans/labs/saa-17-data-pipeline.mjs`
- Create (generated): `shared/topology/planned/saa-17-data-pipeline.json`, `shared/guides/saa-17-data-pipeline/**`
- Modify: `worker/test/topology-golden.test.ts`, `worker/test/fixtures/topology/round-trip.ts`
- Test: `scripts/test/labs-aws-saa-17.test.mjs`

**Interfaces:**
- Consumes: Task 3 (stream, Firehose, crawler, workgroup, Lambda-source rules), Task 4 (stream, Firehose, crawler, database, workgroup handlers), Task 6 (stream edges, Glue and Athena cards).

**`labs/saa-17-data-pipeline/lab.yaml`**
```yaml
# Lab saa-17 (AWS labs batch 3). SAA-C03 ((V) the wording against the current
# exam guide): Design High-Performing Architectures (streaming ingestion,
# data transformation and analytics: Kinesis, Firehose, Glue, Athena).
# London list prices × 0.75; the shard hour's filter is (V): if labs-verify
# finds no single product it becomes authored-only (Task 16). A Glue crawler
# run (about 5p) and Athena scans (pennies per GB, cut off at 10 MB a query)
# are per use, named in the readme.
id: saa-17-data-pipeline
version: 1
cloud: aws
title: "Streaming data pipeline to Athena"
summary: >-
  A Lambda function puts shop events on a Kinesis stream every minute; Firehose delivers them to S3; a Glue crawler
  turns the files into a table; Athena queries it with SQL, in a workgroup that caps what each query may scan.
exam: SAA-C03
skill_areas: [saa.performance]
level: associate
type: explore
prerequisites: []
cost:
  items:
    - name: "Kinesis Data Streams, one provisioned shard"
      gbp_h: 0.0124
      aws_price: { service: AmazonKinesis, unit: Hrs, filters: { usagetype: "{usage}-Storage-ShardHour" } }
    - { name: "Kinesis PUT payload units and Firehose ingestion (20 events a minute)", gbp_h: 0.0005 }
    - { name: "Lambda arm64, one call a minute", gbp_h: 0.0001 }
    - { name: "S3 storage and requests, a few MB", gbp_h: 0.0001 }
    - { name: "CloudWatch Logs (one day)", gbp_h: 0.0001 }
  pricey: null
timing: { deploy_min: 5, destroy_min: 5, session_h: 2, max_h: 4 }
capacity: { instance_types: [] }
regions: { secondary: null }
connectivity: { peering: off, dns_link: false, subnets_used: 0 }
identity:
  creates: [role]
  roles: []
  governance: false
```

**`labs/saa-17-data-pipeline/terraform/lambda/producer.py`**
```python
# lambda/producer.py
#
# Plain English: lab 17's producer. Every minute EventBridge calls it; it puts
# 20 made-up shop events (a user, an action, an amount) on the Kinesis
# stream, one JSON object per line so Athena can read the files Firehose
# writes, partitioned by user.

import json
import os
import random
import uuid
from datetime import datetime, timezone

import boto3

KINESIS = boto3.client("kinesis")
STREAM = os.environ["STREAM"]
ACTIONS = ["view", "view", "view", "add_to_basket", "checkout"]


def handler(_event, _context):
    now = datetime.now(timezone.utc).isoformat()
    records = []
    for _ in range(20):
        e = {"event_id": str(uuid.uuid4()), "user": f"user-{random.randint(1, 25):02d}", "action": random.choice(ACTIONS), "amount": round(random.uniform(1, 80), 2), "at": now}
        records.append({"Data": (json.dumps(e) + "\n").encode(), "PartitionKey": e["user"]})
    out = KINESIS.put_records(StreamName=STREAM, Records=records)
    return {"sent": len(records), "failed": out.get("FailedRecordCount", 0)}
```

**`labs/saa-17-data-pipeline/terraform/stream.tf`**
```hcl
# stream.tf
#
# Plain English: lab 17's ingestion. The stream lab-<id>-events: one
# provisioned shard (rule size), a day's retention, deletable with any
# consumers (rule lingering; ruling P15). The producer, lab-<id>-producer,
# logs to /cloudlabs/<id>/producer (ruling A56) and may only put records on
# that stream; the rule lab-<id>-every-minute calls it, allowed by a
# permission naming only that rule (ruling P13), after a 20-second wait for
# the function's tags (ruling P11).

locals {
  account    = data.aws_caller_identity.current.account_id
  stream_arn = "arn:${data.aws_partition.current.partition}:kinesis:${var.region}:${local.account}:stream/lab-${var.lab_id}-events"
}

resource "aws_kinesis_stream" "events" {
  name                      = "lab-${var.lab_id}-events"
  shard_count               = 1
  retention_period          = 24
  enforce_consumer_deletion = true
  stream_mode_details {
    stream_mode = "PROVISIONED"
  }
  tags = { Name = "stream-events" }
}

resource "aws_cloudwatch_log_group" "producer" {
  name              = "/cloudlabs/${var.lab_id}/producer"
  retention_in_days = 1
}

resource "aws_iam_role" "producer" {
  name                 = "lab-${var.lab_id}-producer"
  path                 = "/cloudlabs-lab/"
  permissions_boundary = local.boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "producer_logs" {
  role       = aws_iam_role.producer.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_policy" "producer" {
  name = "lab-${var.lab_id}-producer"
  path = "/cloudlabs-lab/"
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Sid = "LabStream", Effect = "Allow", Action = ["kinesis:PutRecord", "kinesis:PutRecords"], Resource = local.stream_arn }]
  })
}

resource "aws_iam_role_policy_attachment" "producer" {
  role       = aws_iam_role.producer.name
  policy_arn = aws_iam_policy.producer.arn
}

data "archive_file" "producer" {
  type        = "zip"
  source_file = "${path.module}/lambda/producer.py"
  output_path = "${path.module}/.terraform/producer.zip"
}

resource "aws_lambda_function" "producer" {
  function_name    = "lab-${var.lab_id}-producer"
  role             = aws_iam_role.producer.arn
  runtime          = "python3.13"
  architectures    = ["arm64"]
  handler          = "producer.handler"
  filename         = data.archive_file.producer.output_path
  source_code_hash = data.archive_file.producer.output_base64sha256
  memory_size      = 128
  timeout          = 30
  environment {
    variables = { STREAM = aws_kinesis_stream.events.name }
  }
  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.producer.name
  }
  tags       = { Name = "fn-producer" }
  depends_on = [aws_iam_role_policy_attachment.producer_logs, aws_iam_role_policy_attachment.producer]
}

resource "time_sleep" "producer_tags" {
  create_duration = "20s"
  depends_on      = [aws_lambda_function.producer]
}

resource "aws_cloudwatch_event_rule" "every_minute" {
  name                = "lab-${var.lab_id}-every-minute"
  schedule_expression = "rate(1 minute)"
  tags                = { Name = "rule-every-minute" }
}

resource "aws_lambda_permission" "every_minute" {
  statement_id  = "EveryMinute"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.producer.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.every_minute.arn
  depends_on    = [time_sleep.producer_tags]
}

resource "aws_cloudwatch_event_target" "producer" {
  rule       = aws_cloudwatch_event_rule.every_minute.name
  target_id  = "producer"
  arn        = aws_lambda_function.producer.arn
  depends_on = [aws_lambda_permission.every_minute]
}
```

**`labs/saa-17-data-pipeline/terraform/delivery.tf`**
```hcl
# delivery.tf
#
# Plain English: lab 17's lake. The bucket cloudlabs-<name_prefix>-lake,
# private and removable with its objects, and the delivery stream
# lab-<id>-to-s3: Firehose reads the Kinesis stream and writes its records to
# events/ every minute (or each MB), failures to errors/, as the role
# lab-<id>-firehose, allowed only to read that stream and write that bucket.
# Firehose's own error logging stays off (it would make a log group outside
# /cloudlabs/; ruling P15). A 20-second wait lets the new role reach Firehose,
# which checks it at create (as lab 04's replication role).

resource "aws_s3_bucket" "lake" {
  bucket        = "cloudlabs-${var.name_prefix}-lake"
  force_destroy = true
  tags          = { Name = "lake" }
}

resource "aws_s3_bucket_public_access_block" "lake" {
  bucket                  = aws_s3_bucket.lake.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_iam_role" "firehose" {
  name                 = "lab-${var.lab_id}-firehose"
  path                 = "/cloudlabs-lab/"
  permissions_boundary = local.boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "firehose.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_policy" "firehose" {
  name = "lab-${var.lab_id}-firehose"
  path = "/cloudlabs-lab/"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "ReadTheStream", Effect = "Allow", Action = ["kinesis:DescribeStream", "kinesis:DescribeStreamSummary", "kinesis:GetShardIterator", "kinesis:GetRecords", "kinesis:ListShards"], Resource = local.stream_arn },
      { Sid = "WriteTheLake", Effect = "Allow", Action = ["s3:AbortMultipartUpload", "s3:GetBucketLocation", "s3:GetObject", "s3:ListBucket", "s3:ListBucketMultipartUploads", "s3:PutObject"], Resource = ["arn:aws:s3:::cloudlabs-${var.name_prefix}-lake", "arn:aws:s3:::cloudlabs-${var.name_prefix}-lake/*"] },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "firehose" {
  role       = aws_iam_role.firehose.name
  policy_arn = aws_iam_policy.firehose.arn
}

resource "time_sleep" "firehose_role" {
  create_duration = "20s"
  depends_on      = [aws_iam_role_policy_attachment.firehose]
}

resource "aws_kinesis_firehose_delivery_stream" "to_s3" {
  name        = "lab-${var.lab_id}-to-s3"
  destination = "extended_s3"

  kinesis_source_configuration {
    kinesis_stream_arn = aws_kinesis_stream.events.arn
    role_arn           = aws_iam_role.firehose.arn
  }
  extended_s3_configuration {
    role_arn            = aws_iam_role.firehose.arn
    bucket_arn          = aws_s3_bucket.lake.arn
    prefix              = "events/"
    error_output_prefix = "errors/!{firehose:error-output-type}/"
    buffering_size      = 1
    buffering_interval  = 60
    compression_format  = "UNCOMPRESSED"
    cloudwatch_logging_options {
      enabled = false
    }
  }
  tags       = { Name = "firehose-to-s3" }
  depends_on = [time_sleep.firehose_role]
}
```

**`labs/saa-17-data-pipeline/terraform/catalog.tf`**
```hcl
# catalog.tf
#
# Plain English: lab 17's catalogue and queries. The Glue database
# lab_<id> (Glue and Athena take no hyphens; ruling P15) and the crawler
# lab-<id>-events, which reads events/ in the lake and makes a table for it.
# It never runs on a schedule (each run is billed: a Thing to try), and its
# role lab-<id>-crawler may read only the lake and write only this
# database's tables, with no CloudWatch Logs rights, so Glue makes no shared
# log group (V: the crawler still runs). The Athena workgroup lab-<id>-wg
# keeps its results in the lake, refuses queries that would scan more than
# 10 MB, and is deleted with its saved queries.

locals {
  glue_db  = "lab_${replace(var.lab_id, "-", "_")}"
  glue_arn = "arn:${data.aws_partition.current.partition}:glue:${var.region}:${local.account}"
}

resource "aws_glue_catalog_database" "lake" {
  name        = local.glue_db
  description = "lab ${var.lab_id}: the lake's tables"
  tags        = { Name = "glue-lake" }
}

resource "aws_iam_role" "crawler" {
  name                 = "lab-${var.lab_id}-crawler"
  path                 = "/cloudlabs-lab/"
  permissions_boundary = local.boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "glue.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_policy" "crawler" {
  name = "lab-${var.lab_id}-crawler"
  path = "/cloudlabs-lab/"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "LabCatalogue", Effect = "Allow", Action = "glue:*", Resource = ["${local.glue_arn}:catalog", "${local.glue_arn}:database/${local.glue_db}", "${local.glue_arn}:table/${local.glue_db}/*"] },
      { Sid = "ReadTheLake", Effect = "Allow", Action = ["s3:GetObject", "s3:ListBucket"], Resource = ["arn:aws:s3:::cloudlabs-${var.name_prefix}-lake", "arn:aws:s3:::cloudlabs-${var.name_prefix}-lake/events/*"] },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "crawler" {
  role       = aws_iam_role.crawler.name
  policy_arn = aws_iam_policy.crawler.arn
}

resource "aws_glue_crawler" "events" {
  name          = "lab-${var.lab_id}-events"
  database_name = aws_glue_catalog_database.lake.name
  role          = aws_iam_role.crawler.arn
  s3_target {
    path = "s3://${aws_s3_bucket.lake.bucket}/events/"
  }
  schema_change_policy {
    delete_behavior = "DELETE_FROM_DATABASE"
    update_behavior = "UPDATE_IN_DATABASE"
  }
  tags       = { Name = "crawler-events" }
  depends_on = [aws_iam_role_policy_attachment.crawler]
}

resource "aws_athena_workgroup" "wg" {
  name          = "lab-${var.lab_id}-wg"
  force_destroy = true
  configuration {
    enforce_workgroup_configuration    = true
    publish_cloudwatch_metrics_enabled = false
    bytes_scanned_cutoff_per_query     = 10485760
    result_configuration {
      output_location = "s3://${aws_s3_bucket.lake.bucket}/athena-results/"
    }
  }
  tags = { Name = "athena-wg" }
}
```

**`labs/saa-17-data-pipeline/terraform/outputs.tf`**
```hcl
# outputs.tf
#
# Plain English: what the dashboard shows once lab 17 is up: CloudShell lines
# to watch the stream, list what Firehose wrote, run the crawler, and query
# the table in the lab's workgroup.

output "private_ips" {
  value = {}
}

output "connect" {
  value = [
    "aws kinesis describe-stream-summary --region ${var.region} --stream-name ${aws_kinesis_stream.events.name}",
    "aws s3 ls --recursive s3://${aws_s3_bucket.lake.bucket}/events/ | tail",
    "aws glue start-crawler --region ${var.region} --name ${aws_glue_crawler.events.name}",
    "aws athena start-query-execution --region ${var.region} --work-group ${aws_athena_workgroup.wg.name} --query-string \"SELECT action, count(*) AS n, round(sum(amount), 2) AS total FROM ${local.glue_db}.events GROUP BY action ORDER BY n DESC\"",
  ]
}
```

**`labs/saa-17-data-pipeline/readme.md`** (exactly):
````markdown
A small streaming analytics pipeline. Every minute a Lambda function puts 20 shop events on a Kinesis stream; Firehose collects them and writes a file to S3 each minute; a Glue crawler reads the files and adds a table to the data catalogue; Athena answers SQL questions about the events, in a workgroup that refuses any query that would scan more than 10 MB. Everything is listed in the lab's resource group, `lab-saa-17-data-pipeline`, in AWS Resource Groups (London).
From the SAA-C03 outline: design high-performing data ingestion and transformation, and choose analytics services such as Kinesis, Firehose, Glue and Athena.

## What it deploys

- The stream `lab-saa-17-data-pipeline-events` (Kinesis Data Streams, one provisioned shard, a day's retention)
- The producer `lab-saa-17-data-pipeline-producer` (Python 3.13, arm64), called every minute by the rule `lab-saa-17-data-pipeline-every-minute`, logging to `/cloudlabs/saa-17-data-pipeline/producer`
- The delivery stream `lab-saa-17-data-pipeline-to-s3` (Firehose): from the stream to `events/` in the bucket `cloudlabs-<name prefix>-lake`, a file every minute, as the role `lab-saa-17-data-pipeline-firehose`
- The Glue database `lab_saa_17_data_pipeline` and the crawler `lab-saa-17-data-pipeline-events` (run it by hand), as the role `lab-saa-17-data-pipeline-crawler`
- The Athena workgroup `lab-saa-17-data-pipeline-wg`: results in `athena-results/` in the lake, at most 10 MB scanned per query

```text
lab-saa-17-data-pipeline (London)
  rule every-minute --> fn-producer --20 events/min--> stream-events (1 shard)
  stream-events --reads--> firehose-to-s3 --delivers--> cloudlabs-<prefix>-lake/events/
  crawler-events --catalogues--> glue-lake (table events)
  you --SQL--> athena-wg --> glue-lake + lake (results in athena-results/)
```

## Things to try

- Run the first Connect line in CloudShell and open the stream's Monitoring tab: about 20 incoming records a minute. Read a few with `aws kinesis get-shard-iterator` and `get-records`.
- After two or three minutes list what Firehose wrote with the second line: one file a minute under a date path. Download one and look: one JSON event a line.
- Run the crawler with the third line (about 5p a run; about a minute), then find the `events` table in the Glue console with the columns it worked out.
- Run the fourth line, then `aws athena get-query-results --query-execution-id <id>`, or use the Athena console with the workgroup `lab-saa-17-data-pipeline-wg` selected. Each query bills by the data it scans (pennies here); try one that would scan more than 10 MB and watch the workgroup cancel it.
- Raise the stream to two shards (`aws kinesis update-shard-count --target-shard-count 2 --scaling-type UNIFORM_SCALING`) and see the shard hours, and the bill, double. Set it back before you leave.

## Learn more

- [What is Amazon Kinesis Data Streams?](https://docs.aws.amazon.com/streams/latest/dev/introduction.html)
- [What is Amazon Data Firehose?](https://docs.aws.amazon.com/firehose/latest/dev/what-is-this-service.html)
- [Configuring a crawler](https://docs.aws.amazon.com/glue/latest/dg/add-crawler.html)
- [Using workgroups to control query access and costs](https://docs.aws.amazon.com/athena/latest/ug/workgroups-manage-queries-control-costs.html)
- [Querying JSON](https://docs.aws.amazon.com/athena/latest/ug/querying-JSON.html)

Everything this lab builds carries the tag `cloudlabs-lab = saa-17-data-pipeline` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
````

**`labs/_learning/saa-17-data-pipeline.yaml`**
```yaml
# Labs catalogue learning content (labs redesign spec §5). Outside the lab folder: editing it never needs a version bump.
objective: Stream events into S3 with Kinesis and Firehose, catalogue them with Glue and query them with Athena.
learn:
  - Put records on a Kinesis stream and watch Firehose deliver them
  - Turn files in S3 into a table with a Glue crawler
  - Query the table with Athena inside a workgroup's scan limit
learning_min: 60
```

**The diagram** must contain: `resourceGroup lab-saa-17-data-pipeline · London`; `stream stream-events` with a `dependency` edge `reads` to `stream firehose-to-s3`, which has a `dependency` edge `delivers` to `storage lake`; `lambda fn-producer`; `messaging rule-every-minute` with a `dependency` edge to `fn-producer`; `generic glue-lake`; `generic crawler-events` with a `dependency` edge `catalogues` to `glue-lake`; `generic athena-wg`; `logAnalytics /cloudlabs/saa-17-data-pipeline/producer`; `managedIdentity lab-saa-17-data-pipeline-producer`, `-firehose`, `-crawler`; no `vnet`.

- [ ] **Step 1: Write the failing test** `scripts/test/labs-aws-saa-17.test.mjs`:

```js
// labs-aws-saa-17.test.mjs
//
// Plain English: lab saa-17-data-pipeline is the lab AWS labs spec §12.2 row
// 17 describes: one Kinesis shard, a producer Lambda on a schedule, Firehose
// to S3, a Glue crawler and an Athena workgroup (rulings P13–P15).

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { validateLearning } from "../lib/labs.mjs";

const ID = "saa-17-data-pipeline";

test("saa-17 keeps the AWS lab contract with no network", () => {
  assert.deepEqual(commonAwsProblems(ID), []);
  assert.equal(awsLab(ID).files["network.tf"], undefined);
});

test("saa-17's lab.yaml: §12.2 row 17, about £0.01–0.02/h, the shard hour priced", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["SAA-C03", "associate", "explore", ["saa.performance"], []]);
  assert.deepEqual(yaml.timing, { deploy_min: 5, destroy_min: 5, session_h: 2, max_h: 4 });
  assert.deepEqual(yaml.connectivity, { peering: "off", dns_link: false, subnets_used: 0 });
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.01 && total < 0.03, `about £0.013/h, got ${total}`);
});

test("saa-17's stream and producer: one provisioned shard deleted with its consumers, a producer every minute allowed only by its own rule", () => {
  const { tf } = awsLab(ID);
  for (const re of [/shard_count\s+= 1/, /stream_mode = "PROVISIONED"/, /enforce_consumer_deletion = true/, /schedule_expression = "rate\(1 minute\)"/, /source_arn\s+= aws_cloudwatch_event_rule\.every_minute\.arn/, /depends_on\s+= \[time_sleep\.producer_tags\]/, /log_group\s+= aws_cloudwatch_log_group\.producer\.name/]) assert.match(tf, re);
});

test("saa-17's delivery and catalogue: Firehose from the stream to the lake with its logging off; an unscheduled crawler on the lake; a capped workgroup", () => {
  const { tf } = awsLab(ID);
  for (const re of [/destination = "extended_s3"/, /kinesis_stream_arn = aws_kinesis_stream\.events\.arn/, /cloudwatch_logging_options \{\n\s+enabled = false/, /glue_db\s+= "lab_\$\{replace\(var\.lab_id, "-", "_"\)\}"/, /path = "s3:\/\/\$\{aws_s3_bucket\.lake\.bucket\}\/events\/"/, /bytes_scanned_cutoff_per_query\s+= 10485760/, /enforce_workgroup_configuration\s+= true/, /force_destroy = true/]) assert.match(tf, re);
  assert.doesNotMatch(tf, /schedule\s+= "cron/);
  assert.doesNotMatch(tf, /"logs:/, "the crawler role makes no log group (ruling P15)");
});

test("saa-17's readme names the per-use charges and its learning content is valid", () => {
  const { readme, learning, yaml } = awsLab(ID);
  for (const s of ["about 5p a run", "10 MB", "lab_saa_17_data_pipeline", "update-shard-count"]) assert.ok(readme.includes(s), s);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test scripts/test/labs-aws-saa-17.test.mjs`
Expected: FAIL (no lab folder).

- [ ] **Step 3: Write the lab**: the files above; copy `versions.tf` and `main.tf`; trim `variables.tf` to the four variables named.

- [ ] **Step 4: Write the plan fixture** `saa-17-data-pipeline.mjs`: `[...templateMainResources(c), …]` with `data: templateMainData()` plus the archive; the stream, log group, roles, policies (known: the stream, lake and catalogue ARNs are built from known parts), attachments, function, waits, rule, permission (`source_arn` unknown, referencing the rule), target (`arn` unknown, referencing the function), bucket and its block, delivery stream (the nested `kinesis_stream_arn`, `role_arn` and `bucket_arn` unknown with their own references), database (known name), crawler (`role` unknown referencing the role; `s3_target.0.path` known), workgroup (known configuration). `lab-plans.test.mjs` proves it.

- [ ] **Step 5: Generate the planned graph and the readme diagram**, `GOLDEN["saa-17-data-pipeline"]`, `AWS_LAB_IDS`.

- [ ] **Step 6: Run the checks**

Run: `node --test scripts/test/labs-aws-saa-17.test.mjs scripts/test/lab-plans.test.mjs scripts/test/labs-readmes.test.mjs scripts/test/labs-diagrams.test.mjs scripts/test/labs-learning-content.test.mjs`, then `npx vitest run worker/test/topology-golden.test.ts`, then `npm run labs-check`, `npm run labs-tf -- saa-17-data-pipeline`, `npm run labs-topology -- --check saa-17-data-pipeline`, `npm run labs-diagrams -- --check`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add labs/saa-17-data-pipeline labs/_learning/saa-17-data-pipeline.yaml shared/topology/planned/saa-17-data-pipeline.json shared/guides scripts/test worker/test
git commit -m "feat(aws labs): lab saa-17 streaming data pipeline to Athena

Claude-Session: https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D"
```

---
### Task 14: Lab saa-18-cost-compute

Spec: §12.2 row 18 (cost, performance; associate; explore; £ 0.02; peering optional; 5/5; 2/4; prerequisite 03; mixed-instances ASG (On-Demand base, Spot above, t4g and t3), price comparison in the readme), "Not built here": Savings Plans and Reserved Instances; §6 (capacity); rulings A49, P9, P10.

**Files:**
- Create: `labs/saa-18-cost-compute/lab.yaml`, `readme.md`
- Create: `labs/saa-18-cost-compute/terraform/versions.tf`, `main.tf`, `network.tf` (copied unchanged), `variables.tf` (the template's `lab_id`, `name_prefix`, `region`, `address_space`, `gateway_cidr`, `admin_password`, `tags`), `compute.tf`, `outputs.tf`
- Create: `labs/_learning/saa-18-cost-compute.yaml`, `scripts/test/fixtures/labs/plans/labs/saa-18-cost-compute.mjs`
- Create (generated): `shared/topology/planned/saa-18-cost-compute.json`, `shared/guides/saa-18-cost-compute/**`
- Modify: `worker/test/topology-golden.test.ts`, `worker/test/fixtures/topology/round-trip.ts`
- Test: `scripts/test/labs-aws-saa-18.test.mjs`

**Interfaces:**
- Consumes: the template network; Task 2 (the Spot service-linked role made ahead), Task 3 (the mixed-instances override sizes, batch 1's), Task 4 (the ready check's Spot tolerance), Task 6 (both launch templates fold into the group).

**`labs/saa-18-cost-compute/lab.yaml`**
```yaml
# Lab saa-18 (AWS labs batch 3). SAA-C03 ((V) the wording against the current
# exam guide): Design Cost-Optimized Architectures (purchase options: On-Demand,
# Spot; instance families: Graviton and x86); Design High-Performing
# Architectures (an Auto Scaling group across several instance types).
# London list prices × 0.75 (labs-verify --aws-prices). Spot prices move and
# are authored at about a third of On-Demand (V: describe-spot-price-history,
# a Thing to try). capacity lists one type per instance at the group's
# maximum; the warning counts all four against the On-Demand quota (ruling P9).
id: saa-18-cost-compute
version: 1
cloud: aws
title: "Cost-optimised compute: Spot, Graviton and x86"
summary: >-
  An Auto Scaling group that keeps one On-Demand Graviton instance as a base and runs the rest on Spot, choosing
  between Graviton and x86 types by price and spare capacity, so you can compare what each instance costs.
exam: SAA-C03
skill_areas: [saa.cost, saa.performance]
level: associate
type: explore
prerequisites: [soa-03-auto-scaling]
cost:
  items:
    - name: "EC2 t4g.micro, Linux, On-Demand (the base)"
      gbp_h: 0.0071
      aws_price: { service: AmazonEC2, unit: Hrs, filters: { instanceType: t4g.micro, operatingSystem: Linux, tenancy: Shared, preInstalledSw: NA, capacitystatus: Used } }
    - { name: "EC2 Spot, two of t4g.micro, t4g.small or t3.micro (about a third of On-Demand)", gbp_h: 0.0028, qty: 2 }
    - name: "EBS gp3 root volume, 8 GiB"
      gbp_h: 0.0008
      qty: 3
      aws_price: { service: AmazonEC2, unit: GB-Mo, gb: 8, filters: { productFamily: Storage, volumeApiName: gp3 } }
    - { name: "EC2 Instance Connect Endpoint", gbp_h: 0 }
  pricey: null
timing: { deploy_min: 5, destroy_min: 5, session_h: 2, max_h: 4 }
capacity: { instance_types: [t4g.micro, t4g.micro, t4g.small, t3.micro] }
regions: { secondary: null }
connectivity: { peering: optional, dns_link: false, subnets_used: 1 }
identity:
  creates: []
  roles: []
  governance: false
```

**`labs/saa-18-cost-compute/terraform/compute.tf`**
```hcl
# compute.tf
#
# Plain English: lab 18's group, asg-<prefix>, three instances (up to four)
# across the two private subnets (ruling P9). The first is always an
# On-Demand t4g.micro (the base); every one above it is Spot, chosen by
# AWS for the lowest price and the most spare capacity among t4g.micro,
# t4g.small and t3.micro, and replaced early when AWS warns it will take one
# back (capacity rebalancing). Two launch templates: Graviton (arm64) and
# x86_64, each Amazon Linux 2023 from AWS's public parameter, tagging
# instance, volume and interface at launch. Each instance serves a page
# naming its type, purchase option, architecture and zone. The apply does
# not wait for the group to fill: a Spot shortfall never fails it.

data "aws_ssm_parameter" "al2023_x86" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

locals {
  mixed_unit = join("\n", [
    "[Unit]",
    "Description=Lab 18 page: this instance's type, purchase option, architecture and zone",
    "After=network-online.target",
    "[Service]",
    "ExecStartPre=/bin/sh -c 'mkdir -p /srv/www && T=$(curl -s -X PUT http://169.254.169.254/latest/api/token -H \"X-aws-ec2-metadata-token-ttl-seconds: 300\") && for k in instance-type instance-life-cycle placement/availability-zone; do curl -s -H \"X-aws-ec2-metadata-token: $T\" http://169.254.169.254/latest/meta-data/$k; echo; done > /srv/www/index.html && uname -m >> /srv/www/index.html'",
    "ExecStart=/usr/bin/python3 -m http.server 80 --directory /srv/www",
    "Restart=always",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ])
  mixed_cloud_init = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [{ path = "/etc/systemd/system/lab-page.service", permissions = "0644", content = local.mixed_unit }]
    runcmd      = ["systemctl daemon-reload", "systemctl enable --now lab-page.service"]
  }))}"
  templates = {
    arm = data.aws_ssm_parameter.al2023_arm64.insecure_value
    x86 = data.aws_ssm_parameter.al2023_x86.insecure_value
  }
}

resource "aws_launch_template" "mixed" {
  for_each               = local.templates
  name                   = "lt-${var.name_prefix}-${each.key}"
  image_id               = each.value
  instance_type          = each.key == "arm" ? "t4g.micro" : "t3.micro"
  vpc_security_group_ids = [aws_security_group.vms.id]
  user_data              = base64encode(local.mixed_cloud_init)
  update_default_version = true

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size           = 8
      volume_type           = "gp3"
      delete_on_termination = true
    }
  }
  tag_specifications {
    resource_type = "instance"
    tags          = merge(var.tags, { Name = "vm-${each.key}" })
  }
  tag_specifications {
    resource_type = "volume"
    tags          = merge(var.tags, { Name = "vm-${each.key}" })
  }
  tag_specifications {
    resource_type = "network-interface"
    tags          = merge(var.tags, { Name = "vm-${each.key}" })
  }
  tags = { Name = "lt-${each.key}" }
}

resource "aws_autoscaling_group" "mixed" {
  name                      = "asg-${var.name_prefix}"
  min_size                  = 3
  max_size                  = 4
  desired_capacity          = 3
  vpc_zone_identifier       = aws_subnet.private[*].id
  capacity_rebalance        = true
  force_delete              = true
  wait_for_capacity_timeout = "0"

  mixed_instances_policy {
    instances_distribution {
      on_demand_base_capacity                  = 1
      on_demand_percentage_above_base_capacity = 0
      spot_allocation_strategy                 = "price-capacity-optimized"
    }
    launch_template {
      launch_template_specification {
        launch_template_id = aws_launch_template.mixed["arm"].id
        version            = "$Latest"
      }
      override {
        instance_type = "t4g.micro"
      }
      override {
        instance_type = "t4g.small"
      }
      override {
        instance_type = "t3.micro"
        launch_template_specification {
          launch_template_id = aws_launch_template.mixed["x86"].id
          version            = "$Latest"
        }
      }
    }
  }
  tag {
    key                 = "cloudlabs-lab"
    value               = var.lab_id
    propagate_at_launch = true
  }
  tag {
    key                 = "cloudlabs-session"
    value               = var.tags["cloudlabs-session"]
    propagate_at_launch = true
  }
  tag {
    key                 = "project"
    value               = var.tags["project"]
    propagate_at_launch = true
  }
  tag {
    key                 = "Name"
    value               = "vm-mixed"
    propagate_at_launch = true
  }
  depends_on = [aws_vpc_endpoint.s3]
}
```

**`labs/saa-18-cost-compute/terraform/outputs.tf`**
```hcl
# outputs.tf
#
# Plain English: what the dashboard shows once lab 18 is up. The group's
# instances come and go, so no fixed addresses: how to list them with their
# type and purchase option, today's Spot prices, and how to connect.

output "private_ips" {
  value = {}
}

output "connect" {
  value = [
    "aws ec2 describe-instances --region ${var.region} --filters Name=tag:aws:autoscaling:groupName,Values=${aws_autoscaling_group.mixed.name} Name=instance-state-name,Values=running --query 'Reservations[].Instances[].[InstanceId,InstanceType,InstanceLifecycle,Placement.AvailabilityZone]' --output table",
    "aws ec2 describe-spot-price-history --region ${var.region} --instance-types t4g.micro t4g.small t3.micro --product-descriptions Linux/UNIX --start-time $(date -u +%Y-%m-%dT%H:%M:%S) --query 'SpotPriceHistory[].[InstanceType,AvailabilityZone,SpotPrice]' --output table",
    "aws ec2-instance-connect ssh --instance-id <an instance id from the first line> --os-user labadmin --connection-type eice",
    "curl -s localhost",
  ]
}

output "peer_vpc_id" {
  value = aws_vpc.lab.id
}

output "peer_route_table_ids" {
  value = [aws_route_table.private.id]
}
```

**`labs/saa-18-cost-compute/readme.md`** (exactly):
````markdown
The same small web server on three purchase options and two processor families. An Auto Scaling group keeps one On-Demand Graviton instance as its base and runs everything above it on Spot, letting AWS pick among a Graviton and an x86 type by price and spare capacity. Each instance's page says what it is and how it is billed. Everything is listed in the lab's resource group, `lab-saa-18-cost-compute`, in AWS Resource Groups (London).
From the SAA-C03 outline: design cost-optimised compute: choose purchase options (On-Demand, Spot, Savings Plans, Reserved Instances) and instance families, and mix them in an Auto Scaling group.

## What it deploys

- The VPC `vpc-lab` (the slot's first /20), two private subnets, an S3 gateway endpoint and an Instance Connect Endpoint (the template)
- The group `asg-<name prefix>`: three instances (up to four) across both zones; the first an On-Demand `t4g.micro`, the rest Spot from `t4g.micro`, `t4g.small` or `t3.micro` (price-capacity-optimized), replaced early when AWS warns it will reclaim one (capacity rebalancing)
- Two launch templates, `lt-<name prefix>-arm` (Graviton, arm64) and `lt-<name prefix>-x86` (x86_64), Amazon Linux 2023 from AWS's public parameters; each instance serves a page naming its type, purchase option (`spot` or `on-demand`), architecture and zone

Prices in London today, On-Demand, Linux, per hour (check the second Connect line for Spot; it moves):

| Type | Processor | vCPU, memory | On-Demand | Spot, typically |
|---|---|---|---|---|
| t4g.micro | Graviton (arm64) | 2, 1 GiB | about $0.0095 | about a third of that |
| t4g.small | Graviton (arm64) | 2, 2 GiB | about $0.019 | about a third of that |
| t3.micro | Intel (x86_64) | 2, 1 GiB | about $0.012 | about a third of that |

```text
lab-saa-18-cost-compute (London)
  asg-<prefix> (snet-private-1/2): base 1 x On-Demand t4g.micro (lt-arm)
                                   above it: Spot t4g.micro | t4g.small (lt-arm) | t3.micro (lt-x86)
  each instance: page = type, spot/on-demand, arm64/x86_64, zone
```

## Things to try

- List the instances with the first Connect line (CloudShell): one with an empty `InstanceLifecycle` (On-Demand) and two `spot`. Which Spot types did AWS choose, and in which zones?
- Run the second line and compare today's Spot prices with the table: how much would a month of each cost, per instance, On-Demand and Spot?
- Connect to an instance (third line) and run `curl -s localhost`: the page says its type, `spot` or `on-demand`, and `aarch64` or `x86_64`. The same AMI family runs on both architectures; most open-source software does too.
- Raise the group's desired capacity to 4 and watch the new instance come up on Spot. Lower it to 3 and see which one AWS removes.
- In the Auto Scaling console, look at the group's Activity history: a Spot instance AWS reclaims (rare in a short session) is replaced automatically, and the On-Demand base never is reclaimed.

## Not built here

**Savings Plans and Reserved Instances.** Both are billing commitments, not resources: you agree to pay for a level of use (Savings Plans: dollars an hour of compute; Reserved Instances: an instance type in a Region) for one or three years, and AWS discounts the On-Demand price, by up to about 72%. A lab cannot buy one for a two-hour session; compare them with Spot (no commitment, can be reclaimed) in the AWS pages below.

## Learn more

- [Auto Scaling groups with multiple instance types and purchase options](https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-mixed-instances-groups.html)
- [Spot Instances](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/using-spot-instances.html)
- [Use Capacity Rebalancing to handle Amazon EC2 Spot Interruptions](https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-capacity-rebalancing.html)
- [What are Savings Plans?](https://docs.aws.amazon.com/savingsplans/latest/userguide/what-is-savings-plans.html)
- [Reserved Instances for Amazon EC2](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-reserved-instances.html)

Everything this lab builds carries the tag `cloudlabs-lab = saa-18-cost-compute` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
````

**`labs/_learning/saa-18-cost-compute.yaml`**
```yaml
# Labs catalogue learning content (labs redesign spec §5). Outside the lab folder: editing it never needs a version bump.
objective: Mix On-Demand and Spot, Graviton and x86 in one Auto Scaling group and compare what each costs.
learn:
  - Keep an On-Demand base and run the rest of a group on Spot
  - Let one group choose among Graviton and x86 instance types
  - Compare On-Demand, Spot and commitment prices for the same work
learning_min: 45
```

**The diagram** must contain: `resourceGroup lab-saa-18-cost-compute · London`; `vnet vpc-lab` with `subnet snet-private-1/2`; `vmss vm-mixed`; `nsg sg-vms`, `sg-eice`; `bastion eice-lab`; `privateEndpoint vpce-s3`; no launch-template card (both fold into the group).

- [ ] **Step 1: Write the failing test** `scripts/test/labs-aws-saa-18.test.mjs`:

```js
// labs-aws-saa-18.test.mjs
//
// Plain English: lab saa-18-cost-compute is the lab AWS labs spec §12.2 row
// 18 describes: a mixed-instances group with an On-Demand base and Spot
// above it, t4g and t3, and a price comparison in the readme (ruling P9).

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { validateLearning } from "../lib/labs.mjs";

const ID = "saa-18-cost-compute";

test("saa-18 keeps the AWS lab contract", () => assert.deepEqual(commonAwsProblems(ID), []));

test("saa-18's lab.yaml: §12.2 row 18, after soa-03, about £0.02/h, one capacity entry per instance at the group's maximum", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["SAA-C03", "associate", "explore", ["saa.cost", "saa.performance"], ["soa-03-auto-scaling"]]);
  assert.deepEqual(yaml.timing, { deploy_min: 5, destroy_min: 5, session_h: 2, max_h: 4 });
  assert.deepEqual(yaml.capacity.instance_types, ["t4g.micro", "t4g.micro", "t4g.small", "t3.micro"]);
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.01 && total < 0.03, `about £0.015/h, got ${total}`);
});

test("saa-18's group: an On-Demand base of 1, Spot above it, price-capacity-optimized, rebalancing, never waiting for capacity (ruling P9)", () => {
  const { tf } = awsLab(ID);
  for (const re of [/on_demand_base_capacity\s+= 1/, /on_demand_percentage_above_base_capacity = 0/, /spot_allocation_strategy\s+= "price-capacity-optimized"/, /capacity_rebalance\s+= true/, /wait_for_capacity_timeout = "0"/, /max_size\s+= 4/, /propagate_at_launch = true/]) assert.match(tf, re);
});

test("saa-18's templates: Graviton and x86 from AWS's public parameters, t3.micro only through the x86 template", () => {
  const { tf } = awsLab(ID);
  for (const re of [/name = "\/aws\/service\/ami-amazon-linux-latest\/al2023-ami-kernel-default-x86_64"/, /instance_type = "t3\.micro"\n\s+launch_template_specification \{\n\s+launch_template_id = aws_launch_template\.mixed\["x86"\]\.id/, /instance-life-cycle/]) assert.match(tf, re);
  assert.doesNotMatch(tf, /spot-instances-request/, "Spot requests are never tagged (ruling P9)");
});

test("saa-18's readme compares prices, explains commitments, and its learning content is valid", () => {
  const { readme, learning, yaml } = awsLab(ID);
  for (const s of ["| t3.micro |", "capacity rebalancing", "## Not built here", "Savings Plans and Reserved Instances"]) assert.ok(readme.includes(s), s);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test scripts/test/labs-aws-saa-18.test.mjs`
Expected: FAIL (no lab folder).

- [ ] **Step 3: Write the lab**: the files above; copy `versions.tf`, `main.tf`, `network.tf`; trim `variables.tf` to the seven variables named.

- [ ] **Step 4: Write the plan fixture** `saa-18-cost-compute.mjs`: `[...templateResources(c), …]` with `data: [...awsData(), the x86 parameter]`; the two launch templates (`forEach`: `aws_launch_template.mixed["arm"]`, `["x86"]`; `image_id` known from the parameters; `user_data` known), and the group (`mixed_instances_policy` with its overrides known; the template ids unknown with references). `lab-plans.test.mjs` proves it, rule `size` reading the three override types.

- [ ] **Step 5: Generate the planned graph and the readme diagram**, `GOLDEN["saa-18-cost-compute"]`, `AWS_LAB_IDS`.

- [ ] **Step 6: Run the checks**

Run: `node --test scripts/test/labs-aws-saa-18.test.mjs scripts/test/lab-plans.test.mjs scripts/test/labs-readmes.test.mjs scripts/test/labs-diagrams.test.mjs scripts/test/labs-learning-content.test.mjs`, then `npx vitest run worker/test/topology-golden.test.ts`, then `npm run labs-check`, `npm run labs-tf -- saa-18-cost-compute`, `npm run labs-topology -- --check saa-18-cost-compute`, `npm run labs-diagrams -- --check`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add labs/saa-18-cost-compute labs/_learning/saa-18-cost-compute.yaml shared/topology/planned/saa-18-cost-compute.json shared/guides scripts/test worker/test
git commit -m "feat(aws labs): lab saa-18 cost-optimised compute: Spot, Graviton and x86

Claude-Session: https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D"
```

---

### Task 15: Lab saa-19-eks

Spec: §12.2 row 19 (performance; expert; explore; £ 0.14; peering optional; 20/15; 2/3; prerequisite 10; EKS cluster, one-node managed group (t4g.medium, V), NAT gateway, a sample deployment reached by port-forward), §7.3 rule 13 (t4g.medium for lab 19 only; node groups max 2), §15 (EKS-made resources); rulings A14, A20, P7, P8.

**Files:**
- Create: `labs/saa-19-eks/lab.yaml`, `readme.md`
- Create: `labs/saa-19-eks/terraform/versions.tf`, `main.tf`, `network.tf` (copied unchanged), `variables.tf` (the template's `lab_id`, `name_prefix`, `region`, `address_space`, `gateway_cidr`, `admin_password`, `tags`), `public.tf` (soa-03's), `nat.tf` (soa-10's), `eks.tf`, `outputs.tf`
- Create: `labs/_learning/saa-19-eks.yaml`, `scripts/test/fixtures/labs/plans/labs/saa-19-eks.mjs`
- Create (generated): `shared/topology/planned/saa-19-eks.json`, `shared/guides/saa-19-eks/**`
- Modify: `worker/test/topology-golden.test.ts`, `worker/test/fixtures/topology/round-trip.ts`
- Test: `scripts/test/labs-aws-saa-19.test.mjs`

**Interfaces:**
- Consumes: the template network; soa-03's `public.tf`, soa-10's `nat.tf`; Task 2 (P8's load balancer exception), Task 3 (EKS rules), Task 4 (EKS handlers, Unblock's Kubernetes load balancers), Task 6 (cluster and node group cards).

**`labs/saa-19-eks/lab.yaml`**
```yaml
# Lab saa-19 (AWS labs batch 3). SAA-C03 ((V) the wording against the current
# exam guide): Design High-Performing Architectures (containers on Kubernetes:
# EKS, managed node groups).
# London list prices × 0.75 (labs-verify --aws-prices; the EKS filter is (V):
# if it matches no single product it becomes authored-only, Task 16). The EKS
# control plane is $0.10 an hour on standard support (extended support,
# $0.60, is refused: ruling P7). The NAT gateway bills each started hour
# whole (V, A20). t4g.medium: 4 GiB, enough for the system pods and a small
# deployment (V, Task 17).
id: saa-19-eks
version: 1
cloud: aws
title: "EKS with a managed node group"
summary: >-
  An EKS cluster with one Graviton node in a managed node group, in private subnets behind a NAT gateway: give
  yourself access with an access entry, deploy a sample app with kubectl from CloudShell and reach it by port-forward.
exam: SAA-C03
skill_areas: [saa.performance]
level: expert
type: explore
prerequisites: [soa-10-containers]
cost:
  items:
    - name: "EKS cluster, standard support, hourly"
      gbp_h: 0.0750
      aws_price: { service: AmazonEKS, unit: Hrs, filters: { usagetype: "{usage}-AmazonEKS-Hours:perCluster" } }
    - name: "EC2 t4g.medium, Linux (the node)"
      gbp_h: 0.0282
      aws_price: { service: AmazonEC2, unit: Hrs, filters: { instanceType: t4g.medium, operatingSystem: Linux, tenancy: Shared, preInstalledSw: NA, capacitystatus: Used } }
    - name: "EBS gp3 node volume, 20 GiB"
      gbp_h: 0.0019
      aws_price: { service: AmazonEC2, unit: GB-Mo, gb: 20, filters: { productFamily: Storage, volumeApiName: gp3 } }
    - name: "NAT gateway, hourly"
      gbp_h: 0.0375
      whole_hours: true
      aws_price: { service: AmazonEC2, unit: Hrs, filters: { productFamily: "NAT Gateway", usagetype: "{usage}-NatGateway-Hours" } }
    - name: "Public IPv4 address (the NAT gateway's)"
      gbp_h: 0.0038
      aws_price: { service: AmazonVPC, unit: Hrs, filters: { group: VPCPublicIPv4Address, usagetype: "{usage}-PublicIPv4:InUseAddress" } }
    - { name: "EC2 Instance Connect Endpoint", gbp_h: 0 }
  pricey: null
timing: { deploy_min: 20, destroy_min: 15, session_h: 2, max_h: 3 }
capacity: { instance_types: [t4g.medium, t4g.medium] }
regions: { secondary: null }
connectivity: { peering: optional, dns_link: false, subnets_used: 1 }
identity:
  creates: [role]
  roles: []
  governance: false
```

**`public.tf`**, **`nat.tf`**: soa-03's `public.tf` and soa-10's `nat.tf`, each header's first sentence naming lab 19 (the nodes pull images and reach EKS's API through the NAT gateway).

**`labs/saa-19-eks/terraform/eks.tf`**
```hcl
# eks.tf
#
# Plain English: lab 19's Kubernetes (ruling P7). The cluster lab-<id> on
# standard support (never extended, which bills six times as much), in the two
# private subnets, its API reachable privately and (IAM-authenticated) from
# the internet so CloudShell can use it. Access is by access entries only:
# nobody, not even the pipeline that made it, is a Kubernetes admin until you
# give yourself an entry (the first Connect line). No control-plane logs (they
# would make a log group outside /cloudlabs/). The cluster role is denied
# making load balancers and security groups, so a Kubernetes LoadBalancer
# service can never leave an untagged load balancer behind (ruling P8): reach
# the sample app by port-forward. One t4g.medium node (at most two) in a
# managed node group, launched from a template that tags instance, volume and
# interface at launch and keeps IMDSv2 one hop away from pods.

locals {
  cluster_name = "lab-${var.lab_id}"
}

resource "aws_iam_role" "cluster" {
  name                 = "lab-${var.lab_id}-cluster"
  path                 = "/cloudlabs-lab/"
  permissions_boundary = local.boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "eks.amazonaws.com" }, Action = ["sts:AssumeRole", "sts:TagSession"] }]
  })
}

resource "aws_iam_role_policy_attachment" "cluster" {
  role       = aws_iam_role.cluster.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
}

resource "aws_iam_policy" "no_load_balancers" {
  name = "lab-${var.lab_id}-no-lb"
  path = "/cloudlabs-lab/"
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Sid = "NoLoadBalancerServices", Effect = "Deny", Action = ["elasticloadbalancing:CreateLoadBalancer", "ec2:CreateSecurityGroup"], Resource = "*" }]
  })
}

resource "aws_iam_role_policy_attachment" "cluster_no_lb" {
  role       = aws_iam_role.cluster.name
  policy_arn = aws_iam_policy.no_load_balancers.arn
}

resource "aws_iam_role" "node" {
  name                 = "lab-${var.lab_id}-node"
  path                 = "/cloudlabs-lab/"
  permissions_boundary = local.boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "node" {
  for_each   = toset(["AmazonEKSWorkerNodePolicy", "AmazonEKS_CNI_Policy", "AmazonEC2ContainerRegistryReadOnly"])
  role       = aws_iam_role.node.name
  policy_arn = "arn:aws:iam::aws:policy/${each.key}"
}

resource "aws_eks_cluster" "lab" {
  name                          = local.cluster_name
  role_arn                      = aws_iam_role.cluster.arn
  bootstrap_self_managed_addons = true

  vpc_config {
    subnet_ids              = aws_subnet.private[*].id
    endpoint_private_access = true
    endpoint_public_access  = true
  }
  access_config {
    authentication_mode                         = "API"
    bootstrap_cluster_creator_admin_permissions = false
  }
  upgrade_policy {
    support_type = "STANDARD"
  }
  tags       = { Name = "eks-lab" }
  depends_on = [aws_iam_role_policy_attachment.cluster, aws_iam_role_policy_attachment.cluster_no_lb, aws_route.private_nat]
}

resource "aws_launch_template" "node" {
  name                   = "lt-${var.name_prefix}"
  update_default_version = true

  metadata_options {
    http_tokens                 = "required"
    http_endpoint               = "enabled"
    http_put_response_hop_limit = 2
  }
  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size           = 20
      volume_type           = "gp3"
      delete_on_termination = true
    }
  }
  tag_specifications {
    resource_type = "instance"
    tags          = merge(var.tags, { Name = "node-eks" })
  }
  tag_specifications {
    resource_type = "volume"
    tags          = merge(var.tags, { Name = "node-eks" })
  }
  tag_specifications {
    resource_type = "network-interface"
    tags          = merge(var.tags, { Name = "node-eks" })
  }
  tags = { Name = "lt-node" }
}

resource "aws_eks_node_group" "lab" {
  cluster_name    = aws_eks_cluster.lab.name
  node_group_name = "lab-${var.lab_id}-ng"
  node_role_arn   = aws_iam_role.node.arn
  subnet_ids      = aws_subnet.private[*].id
  ami_type        = "AL2023_ARM_64_STANDARD"
  instance_types  = ["t4g.medium"]
  capacity_type   = "ON_DEMAND"

  scaling_config {
    desired_size = 1
    min_size     = 1
    max_size     = 2
  }
  update_config {
    max_unavailable = 1
  }
  launch_template {
    id      = aws_launch_template.node.id
    version = aws_launch_template.node.latest_version
  }
  tags       = { Name = "ng-lab" }
  depends_on = [aws_iam_role_policy_attachment.node]
}
```

**`labs/saa-19-eks/terraform/outputs.tf`**
```hcl
# outputs.tf
#
# Plain English: what the dashboard shows once lab 19 is up: the CloudShell
# lines to give yourself access (an access entry for your own IAM role or
# user), point kubectl at the cluster, deploy the sample and reach it by
# port-forward. The node comes and goes with its group: no fixed address.

output "private_ips" {
  value = {}
}

output "connect" {
  value = [
    "ME=$(aws sts get-caller-identity --query Arn --output text | sed -E 's#:sts::([0-9]+):assumed-role/([^/]+)/.*#:iam::\\1:role/\\2#') && aws eks create-access-entry --region ${var.region} --cluster-name ${aws_eks_cluster.lab.name} --principal-arn $ME && aws eks associate-access-policy --region ${var.region} --cluster-name ${aws_eks_cluster.lab.name} --principal-arn $ME --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy --access-scope type=cluster",
    "aws eks update-kubeconfig --region ${var.region} --name ${aws_eks_cluster.lab.name}",
    "kubectl create deployment web --image=public.ecr.aws/nginx/nginx:stable-alpine --replicas=2 && kubectl rollout status deployment/web",
    "kubectl port-forward deployment/web 8080:80 & sleep 3; curl -sI http://localhost:8080/",
  ]
}

output "peer_vpc_id" {
  value = aws_vpc.lab.id
}

output "peer_route_table_ids" {
  value = [aws_route_table.private.id]
}
```

**`labs/saa-19-eks/readme.md`** (exactly):
````markdown
Kubernetes on AWS: an EKS cluster whose control plane AWS runs, and one Graviton node in a managed node group, in private subnets that reach the internet through a NAT gateway. Nobody can use the cluster until they are given an access entry, so the first thing you do is give yourself one; then you deploy a sample app with `kubectl` from CloudShell and reach it by port-forward. Everything is listed in the lab's resource group, `lab-saa-19-eks`, in AWS Resource Groups (London).
From the SAA-C03 outline: choose and design container platforms for high-performing architectures, including Amazon EKS with managed node groups.

## What it deploys

- The VPC `vpc-lab` (the slot's first /20): two private subnets for the cluster and its node, two public subnets for the NAT gateway `nat-lab`, the internet gateway `igw-lab`
- The cluster `lab-saa-19-eks` (Name `eks-lab`): standard support, its API reachable privately and, signed with IAM, from CloudShell; access by access entries only (no `aws-auth` ConfigMap), and no entry for anyone yet; the role `lab-saa-19-eks-cluster`, which may not make load balancers
- The node group `lab-saa-19-eks-ng` (Name `ng-lab`): one `t4g.medium` (Graviton, 4 GiB, up to two), Amazon Linux 2023 for EKS, launched from `lt-<name prefix>` (IMDSv2), as the role `lab-saa-19-eks-node`

It takes about 20 minutes: the cluster about 10, the node group about 5 more.

```text
lab-saa-19-eks (London)
  you (CloudShell) --kubectl, signed with IAM--> eks-lab API (public and private endpoints)
  eks-lab control plane (AWS) <--> ng-lab: 1 x t4g.medium (snet-private-1/2) [pods: web x2]
  ng-lab --> nat-lab (snet-public-1) --> igw-lab --> ECR Public (nginx image), EKS
  kubectl port-forward deployment/web 8080:80 --> a web pod (no load balancer)
```

## Things to try

- Open CloudShell and run the first Connect line: it finds your own IAM role (or user), creates an access entry for it and gives it cluster admin. Then open the cluster's Access tab in the EKS console and see the entry. Access entries replace the old `aws-auth` ConfigMap: who may use the cluster is now an AWS API, kept with the cluster. If you sign in to AWS as the root user, use an IAM role or user instead: root cannot be given an entry.
- Run the second line, then `kubectl get nodes -o wide` and `kubectl get pods -A`: the node, and the system pods EKS installed (CoreDNS, kube-proxy, the VPC CNI).
- Deploy the sample with the third line and reach it with the fourth: `kubectl port-forward` carries the traffic through the cluster's API, so no load balancer is needed. `kubectl get pods -o wide` shows each pod has an address from the lab's subnet (the VPC CNI).
- Try `kubectl expose deployment web --type=LoadBalancer --port=80` and watch `kubectl get svc`: the external address stays pending, because the cluster's role is not allowed to make a load balancer (`kubectl describe svc web` shows why). Delete the service again.
- Scale the deployment to 20 (`kubectl scale deployment web --replicas=20`): some pods stay Pending, because one t4g.medium has room for only so many pods. Then raise the node group to 2 in the console and watch them schedule.

## Learn more

- [What is Amazon EKS?](https://docs.aws.amazon.com/eks/latest/userguide/what-is-eks.html)
- [Simplify node lifecycle with managed node groups](https://docs.aws.amazon.com/eks/latest/userguide/managed-node-groups.html)
- [Grant IAM users access to Kubernetes with EKS access entries](https://docs.aws.amazon.com/eks/latest/userguide/access-entries.html)
- [Connect kubectl to an EKS cluster by creating a kubeconfig file](https://docs.aws.amazon.com/eks/latest/userguide/create-kubeconfig.html)
- [View Kubernetes resources in the AWS Management Console](https://docs.aws.amazon.com/eks/latest/userguide/view-kubernetes-resources.html)

Everything this lab builds carries the tag `cloudlabs-lab = saa-19-eks` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
````

**`labs/_learning/saa-19-eks.yaml`**
```yaml
# Labs catalogue learning content (labs redesign spec §5). Outside the lab folder: editing it never needs a version bump.
objective: Give yourself access to an EKS cluster, deploy an app on its managed node and reach it with port-forward.
learn:
  - Grant cluster access with an EKS access entry, not aws-auth
  - Run a deployment on a managed node group and read its pods
  - Reach a pod by port-forward and see why no load balancer was made
learning_min: 75
```

**The diagram** must contain: `resourceGroup lab-saa-19-eks · London`; `vnet vpc-lab` with `subnet snet-private-1/2`, `snet-public-1/2`; `internetGateway igw-lab`; `natGateway nat-lab`; `aks eks-lab`; `aks ng-lab`; `routeTable rt-private` (a `dependency` edge `0.0.0.0/0` to `nat-lab`); `managedIdentity lab-saa-19-eks-cluster`, `lab-saa-19-eks-node`; `nsg sg-vms`, `sg-eice`; `bastion eice-lab`; `privateEndpoint vpce-s3`; no launch-template card.

- [ ] **Step 1: Write the failing test** `scripts/test/labs-aws-saa-19.test.mjs`:

```js
// labs-aws-saa-19.test.mjs
//
// Plain English: lab saa-19-eks is the lab AWS labs spec §12.2 row 19
// describes: an EKS cluster with a one-node managed group (t4g.medium), a NAT
// gateway and a sample deployment reached by port-forward, with no way to
// leave a load balancer behind (rulings P7, P8).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { AWS_MEDIUM_LABS, validateLearning } from "../lib/labs.mjs";

const ID = "saa-19-eks";
const body = (p) => readFileSync(fileURLToPath(new URL(`../../labs/${p}`, import.meta.url)), "utf8").replace(/\r\n/g, "\n").split("\n").filter((l) => !l.startsWith("#")).join("\n");

test("saa-19 keeps the AWS lab contract; its public subnets are soa-03's and its NAT gateway soa-10's", () => {
  assert.deepEqual(commonAwsProblems(ID), []);
  assert.equal(body(`${ID}/terraform/public.tf`), body("soa-03-auto-scaling/terraform/public.tf"));
  assert.equal(body(`${ID}/terraform/nat.tf`), body("soa-10-containers/terraform/nat.tf"));
});

test("saa-19's lab.yaml: §12.2 row 19, expert, after soa-10, about £0.14/h with the NAT gateway by the whole hour", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["SAA-C03", "expert", "explore", ["saa.performance"], ["soa-10-containers"]]);
  assert.deepEqual(yaml.timing, { deploy_min: 20, destroy_min: 15, session_h: 2, max_h: 3 });
  assert.deepEqual(yaml.capacity.instance_types, ["t4g.medium", "t4g.medium"]);
  assert.ok(AWS_MEDIUM_LABS.includes(ID));
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.12 && total < 0.17, `about £0.14/h, got ${total}`);
  assert.equal(yaml.cost.items.find((i) => i.name === "NAT gateway, hourly").whole_hours, true);
});

test("Review Focus 3: saa-19's cluster role cannot make a load balancer, and nobody is admin until given an entry (ruling P7)", () => {
  const { tf } = awsLab(ID);
  for (const re of [/Action = \["elasticloadbalancing:CreateLoadBalancer", "ec2:CreateSecurityGroup"\]/, /Effect = "Deny"/, /policy_arn = aws_iam_policy\.no_load_balancers\.arn/, /authentication_mode\s+= "API"/, /bootstrap_cluster_creator_admin_permissions = false/, /support_type = "STANDARD"/, /endpoint_public_access\s+= true/]) assert.match(tf, re);
  assert.doesNotMatch(tf, /enabled_cluster_log_types|aws_eks_access_entry|provider "kubernetes"/);
});

test("saa-19's node group: one t4g.medium (max 2), AL2023 for arm64, a launch template that tags at launch and keeps IMDSv2 a hop from pods", () => {
  const { tf } = awsLab(ID);
  for (const re of [/instance_types\s+= \["t4g\.medium"\]/, /desired_size = 1/, /max_size\s+= 2/, /ami_type\s+= "AL2023_ARM_64_STANDARD"/, /http_put_response_hop_limit = 2/, /volume_size\s+= 20/]) assert.match(tf, re);
});

test("saa-19's readme gives access, deploys by kubectl, uses port-forward, and its learning content is valid", () => {
  const { readme, learning, yaml } = awsLab(ID);
  for (const s of ["access entry", "aws-auth", "port-forward", "stays pending", "root user"]) assert.ok(readme.includes(s), s);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test scripts/test/labs-aws-saa-19.test.mjs`
Expected: FAIL (no lab folder).

- [ ] **Step 3: Write the lab**: the files above; copy `versions.tf`, `main.tf`, `network.tf`, soa-03's `public.tf` and soa-10's `nat.tf`; trim `variables.tf` to the seven variables named.

- [ ] **Step 4: Write the plan fixture** `saa-19-eks.mjs`: `[...templateResources(c), …]`, soa-03's public pieces and soa-10's NAT pieces (as their fixtures write them), the two roles, the deny policy (known), the attachments (the node's `forEach` over the three policy names), the cluster (`access_config`, `upgrade_policy` and the endpoint flags known; `role_arn` and `vpc_config.0.subnet_ids` unknown with references), the launch template (tag specifications known), the node group (`cluster_name` known, `lab-saa-19-eks`; `node_role_arn`, `subnet_ids`, `launch_template.0.id` and `.version` unknown with references). `lab-plans.test.mjs` proves it, the EKS rules included.

- [ ] **Step 5: Generate the planned graph and the readme diagram**, `GOLDEN["saa-19-eks"]`, `AWS_LAB_IDS`.

- [ ] **Step 6: Run the checks**

Run: `node --test scripts/test/labs-aws-saa-19.test.mjs scripts/test/lab-plans.test.mjs scripts/test/labs-readmes.test.mjs scripts/test/labs-diagrams.test.mjs scripts/test/labs-learning-content.test.mjs`, then `npx vitest run worker/test/topology-golden.test.ts`, then `npm run labs-check`, `npm run labs-tf -- saa-19-eks`, `npm run labs-topology -- --check saa-19-eks`, `npm run labs-diagrams -- --check`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add labs/saa-19-eks labs/_learning/saa-19-eks.yaml shared/topology/planned/saa-19-eks.json shared/guides scripts/test worker/test
git commit -m "feat(aws labs): lab saa-19 EKS with a managed node group

Claude-Session: https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D"
```

---
### Task 16: Full gate, price and link checks, V answers, spec rulings, PR and whole-branch review (controller)

The controller runs this task itself: it needs the local AWS admin keys (read-only calls only here) and the PR. Spec: §11, §14, §17.

**Files:**
- Modify: `docs/superpowers/specs/2026-10-15-aws-labs-design.md` (§17 gains "### Rulings from the batch 3 plan (A83 on)": P1–P21 as A83–A103, each "**Ann. Title.** sentence. Reason.", worded as the other rulings; §7.4's public-by-nature list gains "the EKS API endpoint (IAM-authenticated; lab 19, A89)"; §7.1's service-linked list gains `spot`, `replication.dynamodb`, `elasticfilesystem` (A92); batch 2 final review M-2: §5 step 10's Unpeer row and §7.1's `Lab07Users` row gain "(A79)" and "(A64)")
- Modify (only if a check below fails): the labs' `lab.yaml` cost items and readme links; `infra/aws-bootstrap/lab-abac.json`/`lab-policies.json` and the pin (Task 2); `scripts/test/fixtures/labs/plans/computed.json`/`schema-facts.json` (Task 3); lab 11's `engine_version` (Step 3)
- Create: the PR

- [ ] **Step 1: Generate what an implementer could not.** If Task 2 left the ABAC files ungenerated: `node scripts/aws-labs-abac.mjs && node scripts/aws-labs-abac.mjs --render && node scripts/aws-labs-abac.mjs --check`, pin the hash, `node --test scripts/test/aws-labs-iam.test.mjs` (PASS), commit `chore(aws labs): regenerate the ABAC lists and rendered policies for batch 3`. If Task 3 left the schema facts ungenerated, run Task 3 Step 3, then `node --test scripts/test/lab-scope-aws.test.mjs scripts/test/lab-plans.test.mjs`, and commit. Record the render's policy count (expected 11–16 of 20, ruling P1).

- [ ] **Step 2: Prices and links on the real services** (local keys, read only):
Run: `npm run labs-verify -- --aws-prices saa-11-three-tier saa-12-serverless-api saa-13-decoupling saa-14-storage saa-15-data-security saa-16-dr-pilot-light saa-17-data-pipeline saa-18-cost-compute saa-19-eks` and `npm run labs-verify -- --links` with the same ids
Expected: every `aws_price` (NAT, ALB, IPv4, t4g.nano/micro/medium, gp3 and io2 storage, RDS, ElastiCache, EKS, Kinesis) matches exactly one product and each authored figure is within 25%; every link answers 200. The three (V) filters (ElastiCache `cacheEngine: Valkey`, EKS `{usage}-AmazonEKS-Hours:perCluster`, Kinesis `{usage}-Storage-ShardHour`): one matching 0 or several products takes the distinguishing attribute the error names, or becomes authored-only (`aws_price` removed, `gbp_h` kept). A figure more than 25% off is set to AWS's; a dead link is replaced by the page it moved to. The labs are new (version 1): no bump. Record each answer for the PR body.

- [ ] **Step 3: The (V) facts batch 3 relies on** (local keys, read only; each answer under "V answers" in the PR body):
  - `aws service-quotas get-service-quota --service-code iam --quota-code L-0DA4ABF3 --region us-east-1 --query Quota.Value`: 20 (ruling P1). Lower: STOP the merge until a pre-approved quota request is granted (`request-service-quota-increase … --desired-value 20`).
  - `aws service-quotas get-service-quota --service-code ec2 --quota-code L-34B43A08 --region eu-west-2 --query Quota.Value` (All Standard Spot Instance Requests, vCPUs): at least 6 (lab 18's three Spot instances at its maximum). Lower: request 8 (pre-approved); lab 18 still deploys meanwhile (its base is On-Demand, ruling P9).
  - `aws ec2 describe-instance-type-offerings --region eu-west-2 --location-type availability-zone --filters Name=instance-type,Values=t4g.medium,t4g.small,t3.micro --query "InstanceTypeOfferings[].[InstanceType,Location]"`: each in eu-west-2a and 2b at least.
  - `aws ssm get-parameter --region eu-west-2 --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 --query Parameter.Name` answers (lab 18).
  - `aws eks describe-cluster-versions --region eu-west-2 --default-only --query "clusterVersions[].[clusterVersion,versionStatus]"`: the default is in standard support (lab 19 leaves `version` unset, ruling P7).
  - `aws elasticache describe-cache-engine-versions --engine valkey --region eu-west-2 --query "CacheEngineVersions[].EngineVersion"`: includes `8.0` (else set lab 11's `engine_version` to the newest listed and fix its test; still version 1).
  - `aws apigatewayv2 get-apis --region eu-west-2` and `--region eu-west-1`, `aws cognito-idp list-user-pools --max-results 10 --region eu-west-2`, `aws dynamodb list-tables --region eu-west-2` and `eu-west-1`, `aws ec2 describe-images --owners self --region eu-west-1 --query "Images[].Name"`: none (the account has none of these but the labs', so P2's unguarded route POSTs and P3/P4's names reach nothing else). Any found: note it in the PR; not a stop.
  - `aws elbv2 describe-load-balancers --region eu-west-2 --query "LoadBalancers[].LoadBalancerName"` and `aws elb describe-load-balancers --region eu-west-2`: none (P8 deletes only lab 19's Kubernetes ones).
  - `aws iam get-role --role-name AWSServiceRoleForEC2Spot`, `AWSServiceRoleForDynamoDBReplication`, `AWSServiceRoleForAmazonElasticFileSystem`, `AWSServiceRoleForAmazonEKS`, `AWSServiceRoleForAmazonEKSNodegroup`: record which exist (Task 17's bootstrap makes the first three, ruling P10).
  - Left to Task 17's release tests, each named there: DynamoDB replicas made with no request tag under P3's names; `CopyImage` and the copy's time; API Gateway children judged by their API's tag; the Cognito, EFS, SQS/SNS, Lambda and Firehose tag waits; the Route 53 private zone and CloudWatch-metric health check; EKS create and destroy times and what EKS leaves; Spot instances launching; the ready check's ElastiCache states; Route 53 billing; the classic load balancer's `aws:ResourceTag` support (P8).

- [ ] **Step 4: Copy the rulings into the spec**: append "### Rulings from the batch 3 plan (A83 on)" to §17 with A83–A103 (P1 → A83 … P21 → A103), and make the §7.1, §7.4 and M-2 edits named above. Commit `docs(aws labs): batch 3 rulings A83-A103`.

- [ ] **Step 5: The full gate**
Run: `npm run typecheck && npm test && npm run build:web && npm run bundle-size && npm run labs-check -- --base origin/main && npm run labs-tf && npm run labs-topology -- --check && npm run labs-diagrams -- --check`
Expected: all PASS (the 4 known local Azure "Remove lab peerings" failures excepted, as batch 2's gate; CI is the judge); the web entry did not grow (no web change in batch 3). Fix anything red test-first and commit.

- [ ] **Step 6: Push and open the PR**

```bash
git push -u origin feat/aws-labs-batch3
gh pr create --base main --title "AWS labs batch 3: labs saa-11 to saa-19" --body "$(cat <<'EOF'
AWS hands-on labs, batch 3 (spec docs/superpowers/specs/2026-10-15-aws-labs-design.md §14 B3; plan docs/superpowers/plans/2026-10-16-aws-labs-batch3-plan.md).

- Labs saa-11 three-tier, saa-12 serverless API with Cognito, saa-13 decoupling, saa-14 storage choices, saa-15 data security, saa-16 pilot-light DR (London and Ireland), saa-17 streaming pipeline to Athena, saa-18 Spot/Graviton/x86, saa-19 EKS (all Untested until their release tests from main)
- IAM: up to 20 role policies packed with headroom; API Gateway's HTTP verbs by rule; DynamoDB tables and AMI copies owned by name too; only lab or lab-19-Kubernetes load balancers deletable; Spot, DynamoDB replication and EFS service-linked roles made ahead
- Scope and lint: batch 3's types; event, subscription, workflow, pipeline, private-zone, health-check, Lambda-source and endpoint-policy references held to the lab; public databases, EKS creator admin, extended support and control-plane logs refused
- Clean-up: EKS node groups then clusters, global table replicas first, EFS mount targets first, ElastiCache groups, API Gateway, Cognito (domain first), Step Functions, buses, streams, Glue, Athena, AMI copies with their snapshots; Unblock removes Kubernetes-made load balancers; ElastiCache fails fast in the ready check
- Worker: API Gateway ARNs, a DNS lab's us-east-1 tags, a two-region live diagram in 15 calls; diagrams for batch 3's types

Rulings A83-A103 are in the spec's §17. V answers (from Steps 1-3):

https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D
EOF
)"
gh pr checks --watch
```
Expected: CI green.

- [ ] **Step 7: Whole-branch review**: one fresh reviewer on the most capable model, with the spec, this plan and `git diff origin/main...feat/aws-labs-batch3`. Ask about: the Review Focus list; the regenerated ABAC lists' diff and `ElbDeleteLabOrEks` (anything newly allowed that reaches beyond the lab, or newly refused that a lab needs?); `NAMED_CREATES`/`TAG_LAG_NAMED` for DynamoDB and the `CopyImage` exemption (can a name-owned item be anything not the lab's?); `batch3Problems` (can a plan point a target, subscription, workflow, stream, crawler, zone, alarm or endpoint policy outside the lab?); the safety net's new handlers (order across two regions, never-touch rules, nothing deleted by name that is not `lab-<id>-*` or `lab_<id>`); lab 19's access and load-balancer story; each lab against its §12.2 row. Fix each finding test-first, re-run Step 5's gate, push, wait for CI green.

---

### Task 17: Ship: spend check, bootstrap preview then apply, merge, deploy, release tests 11–19, record, recalibrate (controller)

The controller runs this task itself. Spec: §11 (release tests, spend), §13, §14 (A24), §15. Budget: batch 3 aims at ≤ £3 of AWS test spend; the whole AWS labs project may spend ≤ £15 (about £0.19 so far; a projected overrun is a STOP). A change needed in `wg-aws.yml`, `infra/aws/**` or the deploy role is a STOP.

**Files:**
- Modify (after the tests): `docs/labs/release-tests.md`, `scripts/test/fixtures/labs/plans/shapes/saa-*.json` (written by `lab-release-test.mjs`), the labs' plan fixtures where a recorded shape differs (and `realistic.mjs` where the provider prints a batch 3 type its own way), memories `aws-labs-autonomy.md` (or `aws-support.md`), `labs-feature.md`, `golive-versions.md`, `MEMORY.md` (one line each)

Expected test spend (London list, one pass): saa-12 ≈ £0.001; saa-13 ≈ £0.001; saa-15 ≈ £0.003 (the key costs nothing while it waits to delete); saa-14 ≈ £0.006; saa-18 ≈ £0.01; saa-17 ≈ £0.01; saa-16 ≈ £0.01 likely, up to about £0.75 if Route 53 bills the zone and the health check by the whole month (V); saa-11 ≈ £0.10 (a whole hour of the NAT gateway and the ALB, about 40 minutes of RDS Multi-AZ and ElastiCache); saa-19 ≈ £0.12 (about 45 minutes of the EKS control plane and the node, a whole hour of the NAT gateway). About £0.27 likely and £1.40 worst with one retry each.

- [ ] **Step 1: Spend check.** `aws ce get-cost-and-usage --region us-east-1 --time-period Start=<first of month>,End=<today> --granularity MONTHLY --metrics UnblendedCost --group-by Type=TAG,Key=cloudlabs-lab`. If the AWS labs project's test spend so far plus £3 would pass £15, STOP and report.

- [ ] **Step 2: Preview the bootstrap, then apply it** (local admin keys, from the PR branch: the role's new policies must exist before the tests).
Run: `node "C:\Users\steven\AppData\Local\Temp\claude\C--cloudflare-projects-wireguard\683842d1-3455-4eae-b2ce-5a2d019bcd23\scratchpad\aws-labs\bootstrap-preview.mjs"` (from the repo root: Terraform's plan only)
Expected: a few `wg-admin-labs-N` policies and their attachments added (the render's count above 10), the other ten changed (P1's re-pack), **no** change to the boundary, `wg-admin-deploy` or the Worker user, 0 destroy. Anything else: STOP and read it.
Run: `node scripts/aws-bootstrap.mjs --labs`
Expected: applied; all 52 role and 16 boundary simulator cases print as wanted; "Service-linked roles made ahead: spot.amazonaws.com, replication.dynamodb.amazonaws.com, elasticfilesystem.amazonaws.com" (any already there are left); the quotas met; the cost tag active. A simulator mismatch is fixed in `scripts/lib/aws-lab-policies.mjs` test-first, re-rendered, pushed, and the bootstrap run again.

- [ ] **Step 3: Merge and deploy.**

```bash
gh pr merge <PR number> --merge
git switch main && git pull
npm run deploy-worker
git checkout -- worker/src/build.ts
```
Expected: the new Worker version id (no migration). Write it, with the previous version as the rollback target, into memory `golive-versions.md`.

- [ ] **Step 4: Dashboard checks** (Steven's signed-in Chrome; if not available, note "needs Steven's sign-in" and go on): the Labs tab shows nineteen AWS cards, saa-11..19 "Untested v1"; the modals of saa-12, 13 and 17 (peering off) offer no **Peer to gateway**; saa-16's modal names Ireland as its second region; saa-13 names saa-12, saa-19 names soa-10 as "run before".

- [ ] **Step 5: Release tests from main**, cheapest first, one at a time or in at most three streams as batch 2 did (each always tears down; `--ref` defaults to main):

```bash
node scripts/lab-release-test.mjs saa-12-serverless-api --confirm-cost
node scripts/lab-release-test.mjs saa-13-decoupling --confirm-cost
node scripts/lab-release-test.mjs saa-15-data-security --confirm-cost
node scripts/lab-release-test.mjs saa-14-storage --confirm-cost
node scripts/lab-release-test.mjs saa-18-cost-compute --confirm-cost
node scripts/lab-release-test.mjs saa-17-data-pipeline --confirm-cost
node scripts/lab-release-test.mjs saa-16-dr-pilot-light --confirm-cost
node scripts/lab-release-test.mjs saa-11-three-tier --confirm-cost
node scripts/lab-release-test.mjs saa-19-eks --confirm-cost
```
Expected: each row in `docs/labs/release-tests.md` reads pass, clean yes, and saves its plan shape. After each: `aws resourcegroupstaggingapi get-resources --tag-filters Key=cloudlabs-lab,Values=<id> --region eu-west-2` (and `eu-west-1` and `us-east-1` for saa-16) lists nothing that is not terminated, deleted or (a KMS key) pending deletion; `aws iam list-roles --path-prefix /cloudlabs-lab/` lists none. The V answers each test gives, recorded in the batch report:
  - saa-12: the apply passed `apigateway:POST` on `/apis` with the tag and on the routes without; Cognito's client and user after the 20-second wait; `AddPermission`; the destroy's `apigateway:DELETE` on routes, integrations, the authoriser and the stage (judged by the API's tag, P2) passed: no `AccessDenied` in the Destroy log (else the safety net's API delete finished it: record which).
  - saa-13: the queue policies and subscriptions after the wait; `events:PutTargets` on the custom bus's rule; the state machine made with its role (PassRole to states).
  - saa-15: `ModifyVpcEndpoint` (the endpoint policy) passed right after the endpoint; Verify clean counted the key `PendingDeletion` clean.
  - saa-14: EFS mount targets after the wait; EFS's service-linked role used; afterwards `aws backup list-recovery-points-by-backup-vault --backup-vault-name aws/efs/automatic-backup-vault --region eu-west-2` lists nothing for the lab's file system (automatic backups are off for an API-made file system, V; a recovery point there is a STOP-free fix: add `aws_efs_backup_policy { status = "DISABLED" }` after the tag wait, version 2, and delete the point by hand).
  - saa-18: the describe in the first Connect line, run during the ready check from CloudShell, or the run's Ready check log: two `spot` instances (or fewer, if Spot was short: the test still passes, P9); no `ec2:spot-instances-request` in the tagging listing.
  - saa-17: the delivery stream created after the role wait; Firehose wrote `events/` files (`aws s3 ls` during the ready check, if timing allows; otherwise recorded as untested); no `/aws/kinesisfirehose/` or `/aws-glue/` log group made (`aws logs describe-log-groups --log-group-name-prefix /aws-glue` empty).
  - saa-16: the replica made in Ireland with no `AccessDenied` (P3); the AMI copy's time (raise `deploy_min` if the deploy took longer than 12 minutes); the private zone, health check and records made; Verify clean saw the zone and health check in us-east-1 and judged them gone; `aws ec2 describe-snapshots --owner-ids self --region eu-west-1 --filters Name=start-time…` shows no snapshot left from the copy; the next day, Cost Explorer's Route 53 line for the test, recorded.
  - saa-11: ElastiCache's `CreateReplicationGroup` and `CreateCacheSubnetGroup` with the tag; the ready check waited for the group `available`; the deploy and destroy times against 20 and 15.
  - saa-19: the cluster and node group `ACTIVE` within `deploy_min` 20 (else raise it, version 2); the destroy within 15; Verify clean found no untagged network interface or instance inside the lab VPC (A26: the VPC CNI's interfaces went with the node); `aws ec2 describe-security-groups --filters Name=tag:aws:eks:cluster-name,Values=lab-saa-19-eks --region eu-west-2` lists none; no `/aws/eks/` log group; Unblock listed the load balancers and deleted none.
  A failure: read the run's log, fix test-first on `fix/aws-labs-b3-<id>` (the lab's version rises if its folder changes; engine fixes need no bump), PR, CI green, merge, `npm run deploy-worker`, the bootstrap again if IAM changed, test again (A24). Pre-planned fixes: an `AccessDenied` on a change right after a create in Cognito, EFS, SQS, SNS, Lambda or Firehose (ruling P11) adds that service to `TAG_LAG_NAMED` with its `lab-*` name pattern (test-first in `aws-labs-iam.test.mjs`, `--render`, bootstrap); an `AccessDenied` on an API Gateway child's `DELETE`/`PATCH` (P2's inheritance is wrong) moves `apigateway:DELETE`/`PATCH` on child paths to a named exception the same way (`arn:aws:apigateway:*::/apis/*/*`); an `AccessDenied` on `dynamodb:*` in Ireland outside P3's statements, or on `ec2:CopyImage`'s snapshot ARN, is fixed in `NAMED_CREATES`/`CREATE_TAG_EXEMPT` the same way; untagged VPC CNI interfaces left in lab 19's VPC: add an `aws_eks_addon` "vpc-cni" with `configuration_values = jsonencode({ env = { ADDITIONAL_ENI_TAGS = jsonencode({ "cloudlabs-lab" = var.lab_id }) } })` (version 2). Anything that would touch the VPN server is a STOP. Record each deploy and destroy time and raise `deploy_min`/`destroy_min` (with a version bump) where the real time is longer.

- [ ] **Step 6: Leftovers and orphans, two hours on.** At least 90 minutes after the last test, after the Worker's next hourly AWS sweep, the Labs tab's leftovers list (KV `labs:orphans`) has no AWS entry. An Ireland DynamoDB table, an API Gateway stage or an EKS node group there means the tagging API keeps them past the grace: fix test-first in `worker/src/labs/orphans.ts` (skip that type once the safety net proves it gone) and deploy.

- [ ] **Step 7: Mark the versions released.** For each lab whose script test passed, press **Test** in Settings → Labs (Chrome) so `lab_release_tests` records it and the cards drop "Untested"; or, without the dashboard, note that the cards stay "Untested" until Steven presses Test.

- [ ] **Step 8: Record, recalibrate and clean up.** On `chore/aws-labs-b3-release`: commit `docs/labs/release-tests.md` and the shapes; make each lab's plan fixture match its recorded shape (`node --test scripts/test/lab-plans.test.mjs` names every difference; where the aws provider prints a batch 3 type in a way every fixture should follow, put it in `realistic.mjs` with a test, as batch 2's recalibration did); PR, merge when green. Record the month's AWS spend before and after. Update memories: the AWS labs memory (B3 live, Worker version, V answers), `labs-feature.md` (AWS labs 11–19 released or not, with spend), `golive-versions.md`, and `MEMORY.md`'s index lines.

---

## Carried forward

Batches 1 and 2's deferred items (ledgers `b1-ledger/deferred-and-rulings.txt`, `b2-ledger/deferred-and-rulings.txt`, `final-review.md`, and batch 2's own table) and what batch 3 does with each:

| Item | Batch 3 |
|---|---|
| Batch 1 Task 8 / batch 2 P1: apigateway's HTTP verbs left to batch 3 | **Done** (P2, Task 2) |
| Batch 1 Task 2: `aws_db_instance.publicly_accessible` not refused | **Done** (P16, Task 3) |
| Batch 1 Task 4: ElastiCache failed states not fail-fast | **Done** (P17, Task 4) |
| Batch 2 Task 3 M-6: SourceAccount/SourceArn on service-principal Allows | **Done for Lambda permissions** (P13); lab 13's queue policies name their topic by choice; a rule for every resource policy stays with batch 4 (CloudFront, Network Firewall and Lattice bring more) |
| Batch 2 final review M-2: spec tables describe batch 1 | **Done** (Task 16 Step 4 marks the two rows) |
| Ruling: Unblock's Lambda ENI wait moves into the safety net | Batch 4: no batch 3 Lambda runs in a VPC (labs 12, 13, 17 use the public endpoints) |
| Batch 1 Task 2 / final Minor 4: IPv6 "internet" only at `/0` | Batch 4, before lab 20 (no batch 3 lab uses IPv6) |
| Spec §6: lab 18 also reads the Standard Spot quota `L-34B43A08` | Batch 4 or later: the AWS feeds' worst case is already 28 calls against a run budget of 25 (batch 1 Task 7 minor); lab 18's warning over-counts on the On-Demand quota meanwhile (P9), and Task 16 Step 3 reads the Spot quota by hand |
| AWS sprite icons for API Gateway, Cognito, EFS, Glue, Athena, AMIs | Later: generic cards (P20); adding icons means re-running the pinned icon-pack extraction (batch 1 Task 9) |
| Batch 2 final review M-3 (a stack in a non-deletable in-progress state), M-4 (a failed CloudFront disable is not retried) | No batch 3 lab uses CloudFormation or CloudFront; batch 4's lab 26 (CloudFront) takes M-4 |
| Batch 2 final review M-5: the orphan sweep skips enabled KMS keys too | Ruled trade-off (A69); unchanged |
| Batch 2 Task 4 minors (unreadable stack skipped silently, ECS warnings per retry, deletes logged done on refusal, SSM `/` assumption, credential listings silent, OAC list first page only) | Low value; batch 3's handlers follow the existing patterns; none affects a batch 3 lab |
| Batch 2 Task 11 M-1: lab 10's Container Insights log group outlives the lab | Known residual (deleted by hand after soa-10's test); batch 3 makes no service log group (P7, P15) |
| Batch 1 Task 7 minors: `labPrices` broken refs can starve valid refreshes; `saveOrphans` `mine` not filtered by cloud; `resources.ts` ignores a truncated tagged page | Unchanged; batch 3 adds no price-feed or sweep path that worsens them (the resources panel reads one more region for lab 16 only) |
| Batch 1 Task 9 minor: live parents differ from planned for IGW/SG/EICE/RDS | Cosmetic; unchanged |
| Batch 1 Task 4 parked: five `lab-aws.yml` steps duplicate `lab.yml` | Steven's call (C20); the equality test holds them |
| Batch 1 Task 5 and Task 1, 3, 6, 10, 12, 13, 16 cosmetic and test-debt minors | Unchanged; none affects a batch 3 lab |
| Batch 1 final Minor 8: A30's unpeer and destroy run together | Watch item; batch 3 does not change it |
| Batch 1 final Minor 9: spec §7.5's "id as a parameter" wording | Spec wording only; left for the next spec edit outside a batch |
| New watch items (batch 3) | Lab 17's crawler without CloudWatch Logs rights (first run by Steven; fallback: grant `/aws-glue/crawlers` and record the residual); classic load balancers' `aws:ResourceTag` support for P8 (only matters if lab 19's deny ever fails); EFS automatic backups for an API-made file system (Task 17 Step 5) |

## Spec coverage (self-review)

| Spec item | Where |
|---|---|
| §12.2 rows 11–19: areas, level, type, tier, peer, D/X, S/M, prerequisites, key resources | Tasks 7–15 (`lab.yaml` and the per-lab tests pin each; lab 19 is the only expert lab) |
| §12.2 "Not built here": Savings Plans and Reserved Instances (lab 18) | Task 14 readme |
| §14 item 3: the secondary region (lab 16) | Tasks 1 (`AWS_DNS_LABS`, P5), 3 (provider and region rules), 4 (Ireland already iterated; replicas first), 5 (Worker reads), 12 (the lab, `realistic.mjs` `providerKey`) |
| §14 item 3: EKS (lab 19) | Tasks 2 (P8), 3 (P7 rules), 4 (node groups, clusters, Kubernetes load balancers), 6, 15 |
| §14 item 3: Spot (lab 18) | Tasks 2 (P10's service-linked role), 4 (ready check), 14 |
| §14 item 3: the data pipeline (lab 17) | Tasks 3 (P14, P15), 4 (streams, Firehose, Glue, Athena), 6, 13 |
| §4 secondary provider block, second resource group | Task 12 (`ireland.tf`; P5 on variable validation) |
| §5.1 ready check: RDS/ElastiCache, EKS | Task 4 (ElastiCache fail-fast, P17; EKS already there; Spot tolerance pinned) |
| §7.1 create/change lists, service-linked list, pass list | Task 2 (P1–P4, P8, P10; the pass list already holds eks, states, firehose, glue, events, s3) |
| §7.3 rules 1, 4–13 for batch 3's types | Task 3 |
| §7.4 public by nature: API Gateway (already), the EKS API endpoint | Tasks 3, 15, 16 Step 4 |
| §8.1–§8.3 for every new type, two regions | Task 4 |
| §15: EKS-made resources (security group, interfaces, `LoadBalancer` ELBs), Lambda VPC interfaces, slow deletes | Tasks 2, 4, 15 (P7, P8); Lambda VPC interfaces carried (no lab needs them); EKS, Multi-AZ RDS and AMI copy times recorded in Task 17 |
| §15: Route 53 zone charge | Task 17 Step 5 (Cost Explorer for lab 16) |
| §11 spend: ≤ £15 for the project | Global Constraints; Task 17 Step 1 and its expected spend |
| §17: plan rulings copied as A83 on | Task 16 Step 4 |
