# cloudlabs AWS labs: design

Date: 2026-10-15. Status: Steven approved Part 1 (the curriculum, "That looks good") and Part 2 (the engine, "Just build it")
in conversation, with a standing go to plan, build, merge and deploy all four batches, create the IAM role and boundary,
request the quota increases, activate the cost tag and spend up to **£15** on real-AWS release tests. Stops: a surprise, spend
beyond £15, or a change to the VPN server itself. This spec is the record and the builders' brief. Details the decisions left
open are decided here and listed as rulings A1 on (§17).

Builds on `2026-10-04-labs-design.md` (the Azure labs spec, "the main spec": binding, with its rulings 1–72), the AZ-700 suite
spec `2026-10-06-labs-az700-design.md`, and the AWS specs `2026-10-14-aws-vpn-design.md` and `2026-10-15-aws-insights-design.md`.
Grounded in `main` at 6d0c602. Internal names stay `wg-admin` where they already are (role names, `config.workflow`); user-facing
text says cloudlabs. **(V)** marks an AWS fact to verify with a live call or the official page at build time; the batch report
records the answer.

## 1. Intent

**AWS hands-on labs in cloudlabs, built on the same exam-curriculum structure as the Azure labs.** Three AWS exams, each the
sister of an Azure one: SOA-C03 (CloudOps Engineer, like AZ-104), SAA-C03 (Solutions Architect, like AZ-305) and ANS-C01
(Advanced Networking, like AZ-700). **31 labs**, numbered 01–31 across the AWS set. Each lab is deployed and destroyed exactly as
an Azure lab is: the Worker dispatches a GitHub Actions workflow, Terraform builds it with its state in R2, the dashboard shows
a live log and the same pipeline steps, and a timer tears it down.

Goals: every official domain of the three exams has hands-on labs; each lab shows its cost per hour and per session before
deploy, priced from AWS's own price list; the one monthly budget covers AWS labs too; a lab always goes back to £0 (timer,
maximum lifetime, budget guard, tag-based safety net, orphan sweep); a lab never touches the VPN server, IAM outside its own
path and prefix, or billing; Azure labs keep working unchanged.

Non-goals, unchanged from the main spec §1: **not guided learning.** No checks, tasks, hints, quizzes or probes. A lab is a
readme (what it deploys, a diagram, things to try, AWS documentation links), and break-fix labs have a collapsed "What was
broken". The learning features are lab history, a note per session and the coverage map by skill area. Also out of scope:
running a lab in any region but London and Ireland, multi-account anything, and changes to the VPN server.

## 2. How it fits the existing system

```
                         ┌──────────────── Cloudflare ────────────────┐
 Steven ─ Access ─────▶  │ Worker (cloudlabs.clydeford.net)           │
                         │  /api/v1/labs/*   one catalogue, two clouds │
                         │  RunLock "singleton" (VPN), "lab:<id>"      │
                         │  watchman */5: timers, budget, orphans      │
                         └──┬───────────────────┬───────────────────┬──┘
           dispatch wg-aws.yml   dispatch lab.yml (Azure labs)  dispatch lab-aws.yml (AWS labs)
                            │                   │ unchanged         │  OIDC → /api/callback/lab-secrets
                            ▼                   ▼                   ▼  OIDC → wg-admin-labs (build)
 AWS account (eu-west-2)                                               OIDC → wg-admin-deploy (peer/unpeer only)
   vpc-wg 10.50.0.0/16 (wg-admin=vpn) ◀── VPC peering + routes ──▶ lab VPCs in slot 10.64.x.0/18
   rt-wg: route <slot> → pcx                                       tag cloudlabs-lab=<id> on everything
   headend masquerades tunnel traffic                              IAM: /cloudlabs-lab/lab-<id>-*  (boundary)
                                                                   Ireland (eu-west-1) for DR and multi-region labs
 state: R2 labs/<id>/terraform.tfstate (both clouds)        cost: Cost Explorer grouped by tag cloudlabs-lab
```

Azure labs, `lab.yml`, `lab-scope.mjs`, `lab-safety-net.sh` and every Azure path keep their behaviour. AWS labs share the
catalogue, `lab_sessions`, `lab_runs`, the slot pool, the locks, the timers, the budget guard, the live log, history, notes and
the coverage map. What differs is the cloud: a new sister workflow, an AWS rule set for lint and scope, AWS clean-up scripts, a
new IAM role and boundary, and the Worker's AWS reads.

**Connectivity rule (decision 5):** "Peer to gateway" works only when the VPN server runs in the **same cloud** as the lab. An
AWS lab with an Azure server, or an Azure lab with an AWS server, runs unconnected and says so. AWS peering is a VPC peering
connection between the lab's VPC and the headend VPC 10.50.0.0/16, with routes on both sides. The headend already masquerades
tunnel traffic to anything outside 10.50.0.0/16 (`infra/cloud-init.yaml.tftpl:80`, verified), so the lab sees the headend's VPC
address and VPC peering's no-transit rule does not matter. **No server change.**

## 3. Lab definition

### 3.1 Folder and names

Same layout as the main spec §3.1: `labs/<id>/{lab.yaml, readme.md, terraform/}`, plus `labs/_template-aws/` (the AWS
template, skipped by `labFolders` like `_template`).

- **Ids:** `^(az(104|305|700)|soa|saa|ans)-\d{2}-[a-z0-9]+(-[a-z0-9]+)*$` in every copy (ruling A1). `soa-` is SOA-C03,
  `saa-` SAA-C03, `ans-` ANS-C01. AWS ids are at most **30** characters (IAM names have 64, ruling A2); still never a prefix
  of another lab's id.
- **Numbers** are unique **within a cloud** (ruling A3): AWS 01–31 may repeat Azure numbers.
- **What a lab owns in AWS:** everything tagged `cloudlabs-lab = <id>`; IAM roles, instance profiles, customer policies and
  (lab 07 only) users at path `/cloudlabs-lab/` named `lab-<id>-*`; S3 buckets named `cloudlabs-<name_prefix>-*`; and, for the
  few types that cannot carry tags, names starting `lab-<id>-` (CloudWatch dashboards, CloudFront functions and origin access
  controls, KMS aliases `alias/lab-<id>-*`, the Config recorder and delivery channel; ruling A4).
- **name_prefix** for AWS labs is `a` + lab number + 5 random lowercase characters (`a05k3x9q`), so AWS globally unique names
  never collide with an Azure lab's (ruling A5).

### 3.2 `lab.yaml` for AWS (example: lab 03)

```yaml
id: soa-03-auto-scaling
version: 1
cloud: aws                         # azure (the default) | aws; must agree with the id's prefix
title: "Auto Scaling behind an Application Load Balancer"
summary: >-
  A launch template and an Auto Scaling group across two Availability Zones behind an internet-facing ALB, with
  target tracking, a scheduled action and a lifecycle hook, so you can watch AWS replace and scale instances.
exam: SOA-C03                      # SOA-C03 | SAA-C03 | ANS-C01 for AWS labs
skill_areas: [soa.reliability, soa.deployment, saa.resilient]
level: associate
type: explore
prerequisites: [soa-01-cloudwatch] # same-cloud labs only
cost:
  items:
    - name: "EC2 t4g.micro, Linux (2 running)"
      gbp_h: 0.0071
      qty: 2
      aws_price: { service: AmazonEC2, unit: Hrs, filters: { instanceType: t4g.micro, operatingSystem: Linux, tenancy: Shared, preInstalledSw: NA, capacitystatus: Used } }
    - name: "EBS gp3 root volume, 8 GiB"
      gbp_h: 0.0008
      qty: 2
      aws_price: { service: AmazonEC2, unit: GB-Mo, gb: 8, filters: { productFamily: Storage, volumeApiName: gp3 } }
    - name: "Application Load Balancer, hourly"
      gbp_h: 0.0199
      whole_hours: true            # AWS bills a started hour as a whole one (V)
      aws_price: { service: AWSELB, unit: Hrs, filters: { productFamily: "Load Balancer-Application", usagetype: "{usage}-LoadBalancerUsage" } }
    - { name: "ALB capacity units, light test traffic", gbp_h: 0.0060 }
    - name: "Public IPv4 addresses on the ALB (2 AZs)"
      gbp_h: 0.0038
      qty: 2
      aws_price: { service: AmazonVPC, unit: Hrs, filters: { group: VPCPublicIPv4Address, usagetype: "{usage}-PublicIPv4:InUseAddress" } }
    - { name: "EC2 Instance Connect Endpoint", gbp_h: 0 }
  pricey: null
timing: { deploy_min: 6, destroy_min: 6, session_h: 2, max_h: 6 }
capacity: { instance_types: [t4g.micro, t4g.micro, t4g.micro, t4g.micro] }   # one entry per instance at the ASG's maximum
regions: { secondary: null }       # null | eu-west-1
connectivity: { peering: optional, dns_link: false, subnets_used: 1 }
identity:
  creates: [role]                  # any of role, user (user: lab 07 only); [] for none
  roles: []                        # Azure role assignments: always [] for AWS labs
  governance: false                # always false for AWS labs
```

Field rules for `cloud: aws` (checked by `validateLab`; ruling A6):
- `exam` is one of the AWS exams and matches the id; `skill_areas` names only AWS areas, at least one of the primary exam's
  (a cross-cloud tag is refused); `prerequisites` are AWS labs.
- **Cost items** take `aws_price` instead of `retail` (`retail` is refused in an AWS lab, `aws_price` in an Azure lab):
  `service` (the Price List service code), `unit` (`Hrs`, or `GB-Mo` with `gb`, the size), `filters` (TERM_MATCH attribute
  values). The feed adds `regionCode` itself from the session's region (or the secondary region for `region: secondary`
  items). A `usagetype` value may hold `{usage}`, replaced by the region's usage-type prefix (`EUW2` for London, `EU` for
  Ireland, V; ruling A7). A filter set must match **exactly one** product with an OnDemand USD price in that unit
  (`labs-verify --aws-prices` proves it). Items with no hourly or GB-month price (requests, capacity units, per-analysis
  charges) are authored only. An `aws_price` whose filters name an `instanceType` must have that type in
  `capacity.instance_types`, as `retail.sku` must be in `vm_sizes`. Optional `whole_hours: true` marks an item AWS bills by
  the started hour (§9).
- **Capacity:** `instance_types` (EC2 types from the allow-list in §7.3) replaces `vm_sizes`; `vm_sizes` is refused.
- **Regions:** the session's region is always `config.aws.region` (eu-west-2); `secondary` is null or `eu-west-1`.
- **Connectivity:** `dns_link` must be false (ruling A8: the deploy role has no Route 53 rights, and the headend's resolver
  does not forward to lab zones, so linking them would be a server change); `subnets_used` counts the /20s of the slot the lab's Terraform takes, as ruling 56.
- **Identity:** `creates` lists `role` when the lab makes IAM roles or instance profiles, `user` only in `soa-07-iam-kms`
  (`AWS_IAM_USER_LABS`).

### 3.3 `readme.md`

Same required headings and parser as the main spec §3.3 and ruling 2: **What it deploys**, **Things to try** (3–6 bullets),
optional **Not built here** (AZ-700 ruling 43), **Learn more** (links to `docs.aws.amazon.com`). Break-fix labs add
**Symptom** and a closed `<details><summary>What was broken</summary>`. The AWS footer (ruling A9):

> Everything this lab builds carries the tag `cloudlabs-lab = <id>` and is removed at tear-down. Anything you create by hand is
> removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can
> delete them.

The readme says where to find things in the console: the lab's resource group `lab-<id>` (AWS Resource Groups) in each region.

## 4. Terraform contract for AWS labs

**Variables** the pipeline fills (`LAB_TF_VARS_AWS`; a lab declares only those it uses, CI refuses others): `lab_id`,
`name_prefix`, `region`, `secondary_region`, `address_space` (the /18 slot), `gateway_cidr` (the headend VPC, 10.50.0.0/16,
from the Worker's `AZURE_VNET_CIDR`; ruling A10), `peered` (bool), `admin_password` (sensitive, per session),
`ssh_public_key`, `tags` (`cloudlabs-lab = <id>`, `cloudlabs-session = <session id>`, `project = cloudlabs`). Azure's
`resource_group_name`, `gateway_vnet_id` and `upn_domain` do not exist for AWS labs.

**Providers** (`labs/_template-aws/versions.tf`): Terraform 1.14.6, `hashicorp/aws ~> 6.0`, and only as needed `random`,
`time`, `tls`, `archive`; the template's `s3` backend block unchanged (R2 settings by file, §5). Every `aws` provider block is
exactly:

```hcl
provider "aws" {
  region = var.region
  default_tags { tags = var.tags }
}
provider "aws" {                    # only in a lab with regions.secondary
  alias  = "secondary"
  region = var.secondary_region
  default_tags { tags = var.tags }
}
```

A third alias, `region = "us-east-1"`, exists only for a WAF web ACL with scope CLOUDFRONT (lab 26), and `region =
"us-west-2"` only for Global Accelerator (lab 26; V that its API answers only in us-west-2). No credentials, profiles,
`assume_role`, endpoints or account settings in any provider block. A lab with `regions.secondary` refuses an empty
`secondary_region` or one equal to `region` (variable validation, as ruling 25).

**Every lab has:**
- **`aws_resourcegroups_group` "lab"** named `lab-<id>`, query `TAG_FILTERS_1_0` = `{ResourceTypeFilters:
  ["AWS::AllSupported"], TagFilters: [{Key: "cloudlabs-lab", Values: [<id>]}]}`. Free. It is the console link (§10). A lab with
  a secondary region makes a second one there (same name; groups are regional).
- **Addresses** only from `cidrsubnet(var.address_space, …)`: each VPC a /20 of the slot, subnets /24s or smaller;
  `var.gateway_cidr` is the one other CIDR a lab may write (security-group rules and, when peered, routes the pipeline
  adds). IPv6 is Amazon-provided only.
- **A free S3 gateway endpoint** in every VPC with instances, so Amazon Linux 2023 installs packages from its S3-hosted
  repositories with no NAT gateway (V for AL2023's repositories in both regions; ruling A11). A lab adds a NAT gateway only
  where it teaches one or needs general internet (labs 10, 11, 19, 20, 21, 25, 27).
- **An EC2 Instance Connect Endpoint** (`aws_ec2_instance_connect_endpoint`, free) in each VPC that holds instances, at most
  two per lab, with its own security group (egress TCP 22 to the VPC) and instance security groups allowing TCP 22 from it.
  This is console SSH with no public IP on any instance.

**Instances:** Amazon Linux 2023 arm64 (`t4g.*`) from the public SSM parameter
`/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64` (x86 `t3.*` only where the lab compares
architectures); `http_tokens = "required"` (IMDSv2); no public IP except the "public by nature" list (§7.4); `volume_tags`
carry the lab's tags (default tags do not reach root volumes, as `infra/aws/main.tf` found); cloud-init makes the user
**`labadmin`** with `var.admin_password` (sudo, `ssh_pwauth: true`) and, where the lab serves a page, a systemd unit running
`python3 -m http.server`. The password is in the instance's user data, readable only by the account's admins, and dies with
the session (ruling A12). Launch templates carry `tag_specifications` for `instance`, `volume` and `network-interface` with
the lab's tags; Auto Scaling groups also carry a `cloudlabs-lab` tag with `propagate_at_launch = true`.

**Outputs:** `private_ips` (name → address), `connect` (short strings, §10), optional `users` (lab 07: name → console sign-in
user), `peer_vpc_id` (the VPC the pipeline peers to the headend; the hub in multi-VPC labs), `peer_route_table_ids` (the lab
route tables that get the route back to `gateway_cidr`), and optional `files` (name → text, sensitive: lab 31's client
certificate and key; ruling A13).

## 5. Workflow `.github/workflows/lab-aws.yml`

A sister of `lab.yml` with **the same 16 step names as `LAB_STEPS`**, so the steps UI, "step 7/16" and the live log work
unchanged. `lab.yml` is untouched apart from Parse payload refusing an AWS lab. Same `workflow_dispatch` inputs (`action`,
`payload`), same payload keys (`region` is eu-west-2, `secondary_region` null or eu-west-1), same `run-name` ("lab <action>
<id> <run id>"), same concurrency group and timeout formula (`2 × (deploy + destroy) + 20`, cap 150).

**Credentials, per step, never in workflow env:**
- **R2 by file**, as `wg-aws.yml`: Terraform init writes `$RUNNER_TEMP/r2.hcl` (umask 077: bucket, access and secret key,
  endpoint) and runs `terraform init -backend-config="$RUNNER_TEMP/r2.hcl" -backend-config="key=labs/<id>/terraform.tfstate"`.
  R2 keys never sit in `AWS_*` variables while AWS credentials exist. Back up state, which has no AWS credentials, keeps its
  R2 environment as `lab.yml` does.
- **AWS by OIDC:** `infra/ci/aws-lab-creds.sh <role-arn>` fetches a fresh GitHub token (audience `sts.amazonaws.com`, as
  `aws-token.sh`), calls `aws sts assume-role-with-web-identity --duration-seconds 10800` and exports the session's three
  `AWS_*` values for that step only, masked (ruling A14: one apply can outlast an hour). The role is `wg-admin-labs`
  (`secrets.AWS_LABS_ROLE_ARN`) for steps 6–8 and 11–14, and the existing **`wg-admin-deploy`** (`secrets.AWS_DEPLOY_ROLE_ARN`)
  for steps 9 and 10 only. Never `ARM_*`, never `LAB_UPN_DOMAIN`, never the Cloudflare DNS token or the WireGuard key.

| # | Step | Runs on | AWS behaviour |
|---|---|---|---|
| 1 | Check out, Parse payload | all | `lab-parse.sh` with `LAB_WORKFLOW_CLOUD=aws`: refuses an id that fails the regex, a lab whose `cloud` is not aws, and a stale version |
| 2 | Collect run secrets | all | unchanged; the Worker hands an AWS run's secrets only to a token from `lab-aws.yml` on main (§6) |
| 3 | Start live log | all | unchanged |
| 4 | Wait for earlier run of this lab | all | lists `lab-aws.yml` runs whose title has the lab id; ≤ 10 min |
| 5 | Terraform init | D X T | `lab-lint.mjs --cloud aws` on the lab's text first (§7.2); then init with `r2.hcl` |
| 6 | Plan and scope check | D T | `wg-admin-labs`; `terraform plan -out`, `show -json`, `LAB_PLAN_SHAPE` line, `node infra/ci/lab-scope-aws.mjs` (§7.3) |
| 7 | Apply | D T | `lab-tf-run.sh apply`; retries only on AWS transient errors (throttling, `RequestLimitExceeded`, 5xx, dropped connection; never `AccessDenied` or a 4xx), after a fresh plan that passes the scope check |
| 8 | Ready check | D T | `infra/ci/lab-ready-aws.sh`: every tagged item's real state (§5.1), polling up to `deploy_min` |
| 9 | Peer | D P T | `wg-admin-deploy`; asks `/api/callback/lab-peer` (begin); on go: finds `vpc-wg` and `rt-wg` by their `wg-admin=vpn` and `Name` tags, creates the VPC peering lab VPC → `vpc-wg`, accepts it, tag it `cloudlabs-lab=<id>` and `Name=lab-<id>-headend`, route slot → pcx in `rt-wg` (replace if one exists), route `gateway_cidr` → pcx in each `peer_route_table_ids`; then end |
| 10 | Unpeer | X U T | `wg-admin-deploy`; deletes the `rt-wg` route for the slot only if it points at this lab's pcx, the lab-side routes if the lab still exists, then every pcx tagged for the lab; also removes any blackhole route in `rt-wg` inside the lab pool |
| 11 | Unblock | X T | `infra/ci/lab-unblock-aws.sh`: turns off what stops a delete (§8.1); never fails the run |
| 12 | Destroy | X T | `terraform destroy -lock-timeout=5m`, `continue-on-error` |
| 13 | Safety net | X T | `infra/ci/lab-aws-safety-net.sh <id>`: deletes everything still tagged for the lab, in dependency order, plus IAM by path and prefix and the named untaggable items (§8.2) |
| 14 | Verify clean | X T | the same script with `--verify`: each candidate's real state by per-service describe; outputs `clean` and `leftovers` |
| 15 | Back up state | all | unchanged (newest 5 under `labs/<id>/backups/`; state reset once verified clean) |
| 16 | Finish live log, Report result | all | unchanged, with `peer_vpc_id` in place of `peer_vnet_id` and `files` stripped from `LAB_RESULT` |

A failed deploy is destroyed after 15 minutes, and Safety net and Verify clean run even with no state, so an orphan clean-up
is a destroy run, exactly as the main spec §5.

### 5.1 Ready check

Candidates are the lab's tagged ARNs (`tag:GetResources` in the lab's regions). Known types must reach their ready state:
instances `running` with both status checks `ok` (still `initializing` at `deploy_min` passes with a warning; `impaired`
fails); load balancers `active`; RDS and ElastiCache `available`; NAT gateways, VPC endpoints, transit gateways and their
attachments `available`; VPN connections `available` (tunnels may be down until the lab's router configures itself);
Client VPN endpoints `available`; EKS clusters and node groups `ACTIVE`; ECS services with running = desired; Network
Firewall `READY`; CloudFront `Deployed`; Global Accelerator `DEPLOYED`; VPC Lattice `ACTIVE`; Resolver endpoints
`OPERATIONAL`. Anything else counts as ready by existing. As ruling 36, a type is added to a "no state" list only test-first,
on release-test evidence.

## 6. Worker changes

- **Contract (`shared/labs.ts`, its copy in `scripts/lib/labs.mjs`, `lab-parse.sh`):** `LabCloud = "azure" | "aws"`;
  `LabDef.cloud` (labs-build fills `azure` when absent); `LabExam` adds `"SOA-C03" | "SAA-C03" | "ANS-C01"`; `LAB_EXAMS` =
  AZ-104, AZ-305, AZ-700, SOA-C03, SAA-C03, ANS-C01; `EXAM_CLOUD` (exam → cloud); `examOfId` and `cloudOfId` read the new
  prefixes; `LabCostItem.aws_price`; `LabDef.capacity` becomes `{ vm_sizes: string[]; instance_types: string[] }` (the build
  fills the missing one with []); `LAB_TF_VARS_AWS`; `AWS_LAB_REGIONS = ["eu-west-2", "eu-west-1"]`; `LAB_TAG =
  "cloudlabs-lab"`; `AWS_IAM_USER_LABS`, `AWS_CONFIG_LABS` (lab 02), `AWS_GLOBAL_LABS` (labs 09 and 26, whose CloudFront, Route 53 and WAF calls go to us-east-1, and lab 26 also
  and us-west-2). The test that keeps the copies equal covers the new constants. The catalogue sorts by `LAB_EXAMS`, then
  number; the number rule is per cloud.
- **Engine (`worker/src/labs/engine.ts`):** `deployLab` takes the region from `config.aws.region` for an AWS lab and refuses
  any other; `namePrefix` takes the lab (`a` for AWS). `awsHeadend()` and `onAws()` become **`headendCloud()`** (the cloud of
  a headend that is not destroyed, else null) and **same-cloud rules**: a deploy may peer, `peerLab` and `rePeerLabs` act only
  when the lab's cloud equals the headend's; otherwise the lab runs unconnected with "AWS labs connect only to an AWS server
  (the server is in Azure)" or its mirror. A required-peering lab or a release test that peers is refused with the same
  sentence, as today.
- **Dispatch (`net.ts`):** `LAB_WORKFLOWS = { azure: "lab.yml", aws: "lab-aws.yml" }`; `dispatchLab`, `findLabRun`, the
  watch's refresh and `cancelRun` pick the workflow by `cloudOfId(lab_id)`, so no column is added to `lab_runs`.
- **Callbacks (`callbacks.ts`, `oidc.ts`):** `/api/callback/lab-secrets` accepts tokens from `lab.yml` or `lab-aws.yml` on main
  and refuses one whose workflow does not match the run's lab cloud. `/api/callback/lab-peer` answers go only when the
  headend is running or in Standby **and in the lab's cloud**, under the same gateway lock (`peer:<run id>`, 10 minutes);
  `dns_link` is always false for AWS. When a `wg-aws.yml` apply or destroy is dispatched, AWS sessions with peering `on` become
  `disconnected` (its apply rewrites `rt-wg`, whose routes are inline; ruling A15) and the existing "Re-peer" offer appears
  when the server is Running.
- **Orphans (`orphans.ts`):** hourly and read-only, beside the Azure listings: `tag:GetResources` with the `cloudlabs-lab` key
  in eu-west-2, eu-west-1, us-east-1 and us-west-2; IAM `ListRoles`, `ListInstanceProfiles`, `ListPolicies` (Local) and
  `ListUsers` with `PathPrefix=/cloudlabs-lab/`; Config `DescribeConfigurationRecorders` and CloudWatch `ListDashboards`
  (prefix `lab-`) in both lab regions: 12 calls. The lab is the tag's value or the name's id (`labIdOf`). The tagging API keeps
  deleted items for about an hour (V), so an AWS name counts only after **90 minutes** unseen by a live session (ruling A16).
  Notes, KV `labs:orphans`, Clean up and slot release are as the main spec §7.5.
- **Cost (`cost.ts`):** the daily lab cost pull adds one Cost Explorer call (`GetCostAndUsage`, DAILY, UnblendedCost, unfiltered,
  `GroupBy` TAG `cloudlabs-lab`, same time frame as Azure's, about $0.01). Rows `cloudlabs-lab$<id>` with a charge become
  `lab_cost_days` rows with `rg = "aws:<id>"` and `gbp = usd × config.aws.usdToGbp` (no migration; ruling A17). Its own KV
  marker `labs:cost_day_aws`. Untagged spend (API requests, data transfer) is not attributed; the account's AWS Budgets alarm
  sees it.
- **Prices:** a new AWS insights feed **`aws.labPrices`** (cadence 60 minutes, at most 5 calls a run, inside the shared run
  budget) refreshes each distinct `aws_price` reference in each region it is used, oldest first, when its row is older than 3
  days (`GetProducts` with the item's filters plus `regionCode`, `{usage}` filled in). Rows go to `aws_prices` with `item =
  "lab:" + the first 16 hex characters of SHA-256 of the canonical reference`. `labs/prices.ts` reads `aws_prices` for an AWS
  lab: `Hrs` is per hour, `GB-Mo` is × `gb` ÷ 730; under 7 days old it replaces `gbp_h`, and the line's source reads "aws".
- **Budget:** no rule change. `budgetFigures` already counts every running lab's estimate and `lab_cost_days`, now including
  the `aws:` rows; at 100% the guard tears down **every** lab, AWS ones included, and never the server (decision B).
- **Capacity:** the `aws.capacity` feed widens to every catalogue `instance_types` value and both lab regions (8 calls a day).
  An AWS lab's warning sums its `instance_types` vCPUs, the running AWS labs' and the headend's against the On-Demand Standard
  quota (`L-1216C47A`); lab 18 also reads the Standard Spot quota (`L-34B43A08`, V).
- **Release tests:** unchanged route and table; `scripts/lab-release-test.mjs` dispatches the lab's own workflow.
- **Catalogue and API:** `LabCard.cloud` and `LabDetail.cloud`. `GET /labs/:id` for AWS returns `consoleUrl` (the Resource
  Groups console page of `lab-<id>`, one per region; V for the URL form
  `https://<region>.console.aws.amazon.com/resource-groups/group/lab-<id>?region=<region>`) in place of `portalUrl`, and its
  resources from `tag:GetResources` (type from the ARN, name from the `Name` tag). `GET /labs/coverage` iterates all six exams.
  `GET /labs/:id/secret` also returns `files` (lab 31). `GET /labs/:id/topology` for AWS: `tag:GetResources` plus tag-filtered
  EC2 describes (VPCs, subnets, instances, route tables, peering connections, transit gateway attachments, NAT gateways, VPC
  endpoints) and ELBv2 `DescribeLoadBalancers`: at most 14 calls, cached 30 s.
- **Permissions check** (Settings → Labs → Check permissions) adds three AWS ticks: "AWS labs role" (`iam:GetRole
  wg-admin-labs`), "Lab boundary" (`iam:GetPolicy wg-admin-lab-boundary`) and "Cost tag active"
  (`ce:ListCostAllocationTags`; a warning, not a blocker). Until the first two tick, AWS labs say "AWS labs are not set up
  yet: run the AWS bootstrap, then Check permissions" and Deploy is disabled.
- **Migration `0025_lab_files.sql`:** `lab_runs.files_json` (nullable), cleared when the session ends, like `admin_password`
  (ruling A13). Nothing else in D1 changes.
- **Worker IAM user (`infra/aws-bootstrap/main.tf`):** two new read-only statements. `LabsLook`: `ec2:Describe*`,
  `elasticloadbalancing:Describe*`, `config:DescribeConfigurationRecorders`, `cloudwatch:ListDashboards`, in both lab regions.
  `LabsGlobalLook`: `iam:ListRoles`, `iam:ListInstanceProfiles`, `iam:ListPolicies`, `iam:ListUsers`, `iam:GetRole`,
  `iam:GetPolicy`, `ce:ListCostAllocationTags`. The existing `tag:GetResources` and `ce:GetCostAndUsage` cover the rest.
  The existing `Look` and `Insights` statements' region conditions gain eu-west-1 (the capacity feed's second region). Nothing
  that creates, changes or deletes.

## 7. Identity, permissions and enforcement

### 7.1 The `wg-admin-labs` role (in `infra/aws-bootstrap/`, applied with `scripts/aws-bootstrap.mjs` and the local admin keys)

**Trust:** the existing GitHub OIDC provider; `aud = sts.amazonaws.com`; `sub = repo:sjohnston1972@87701935/wireguard@1381942334:
ref:refs/heads/main` (the same immutable subject as `wg-admin-deploy`). If STS accepts a condition on the token's
`job_workflow_ref` claim (V), the trust also pins `.github/workflows/lab-aws.yml@refs/heads/main`; if not, any workflow on main
can assume it, as for the deploy role. `max_session_duration = 10800`. The bootstrap writes the GitHub secret
`AWS_LABS_ROLE_ARN`.

The policy is stated by statement (Sid, effect, what, where). `ACCT` is the account id, `LAB_REGIONS` eu-west-2 and eu-west-1,
`BOUNDARY` `arn:aws:iam::ACCT:policy/wg-admin-lab-boundary`; IAM resources are shortened, so `role/…` means
`arn:aws:iam::ACCT:role/…`.

| Sid | Effect | Actions | Resources | Conditions |
|---|---|---|---|---|
| `LabServices` | Allow | `<service>:*` for each service of the allow-list below | `*` | `aws:RequestedRegion` in LAB_REGIONS |
| `LabBuckets` | Allow | `s3:*` | `arn:aws:s3:::cloudlabs-*`, `arn:aws:s3:::cloudlabs-*/*` | none (S3 has no bucket ABAC in Terraform's calls, V; ownership is the name) |
| `BucketList` | Allow | `s3:ListAllMyBuckets`, `s3:GetBucketLocation` | `*` | none |
| `GlobalServices` | Allow | `cloudfront:*`, `route53:*`, `wafv2:*`, `globalaccelerator:*`, `tag:GetResources` | `*` | `aws:RequestedRegion` in us-east-1, us-west-2 (V for which region each signs) |
| `Identity` | Allow | `sts:GetCallerIdentity`, `iam:Get*`, `iam:List*` | `*` | none |
| `LabRolesBounded` | Allow | `iam:CreateRole`, `PutRolePermissionsBoundary`, `AttachRolePolicy`, `DetachRolePolicy`, `PutRolePolicy`, `DeleteRolePolicy` | `role/cloudlabs-lab/lab-*` | `iam:PermissionsBoundary = BOUNDARY` |
| `LabRolesOther` | Allow | `iam:DeleteRole`, `TagRole`, `UntagRole`, `UpdateRole`, `UpdateAssumeRolePolicy`, `CreateInstanceProfile`, `DeleteInstanceProfile`, `AddRoleToInstanceProfile`, `RemoveRoleFromInstanceProfile`, `TagInstanceProfile`, `CreatePolicy`, `DeletePolicy`, `CreatePolicyVersion`, `DeletePolicyVersion`, `TagPolicy` | `role/cloudlabs-lab/lab-*`, `instance-profile/cloudlabs-lab/lab-*`, `policy/cloudlabs-lab/lab-*` | none |
| `Lab07Users` | Allow | `iam:CreateUser`, `PutUserPermissionsBoundary`, `AttachUserPolicy`, `DetachUserPolicy`, `PutUserPolicy`, `DeleteUserPolicy` (bounded); `DeleteUser`, `TagUser`, `CreateLoginProfile`, `DeleteLoginProfile` | `user/cloudlabs-lab/lab-soa-07-*` | bounded ones: `iam:PermissionsBoundary = BOUNDARY` |
| `PassLabRoles` | Allow | `iam:PassRole` | `role/cloudlabs-lab/lab-*` | `iam:PassedToService` in the pass list below |
| `ServiceLinkedRoles` | Allow | `iam:CreateServiceLinkedRole` | `*` | `iam:AWSServiceName` in the service-linked list below |
| `DenyVpnServer` | Deny | `*` | `*` | `aws:ResourceTag/wg-admin = vpn` |
| `DenyVpnTag` (two statements, as conditions in one would both have to hold) | Deny | `*` | `*` | first: `aws:RequestTag/wg-admin` not null; second: `ForAnyValue:StringEquals aws:TagKeys` = `wg-admin` |
| `DenyDefaultVpc` | Deny | `ec2:*` | the two default VPC ARNs (looked up by the bootstrap), and `*` with `ArnEquals ec2:Vpc` = either of them | none beyond the resource match (Describe calls carry no VPC, so they still answer) |
| `DenyAccountAndBilling` | Deny | `organizations:*`, `account:*`, `billing:*`, `aws-portal:*`, `payments:*`, `budgets:*`, `cur:*`, `ce:Create*`, `ce:Update*`, `ce:Delete*`, `iam:*AccountPasswordPolicy`, `iam:*AccountAlias`, `iam:CreateAccessKey`, `iam:*OpenIDConnectProvider*`, `iam:*SAMLProvider*`, `iam:*VirtualMFADevice`, and the account settings (ruling A51: EC2's account-wide settings, SSM's service settings and default patch baseline) | `*` | none |
| `DenyIamOutsideLab` | Deny | `iam:Create*`, `Delete*`, `Put*`, `Attach*`, `Detach*`, `Update*`, `Tag*`, `Untag*`, `Add*`, `Remove*`, `Set*`, `PassRole` | NotResource: the four lab ARN patterns above and `role/aws-service-role/*` (so `CreateServiceLinkedRole` still works) | none |
| `DenyBoundaryRemoval` | Deny | `iam:DeleteRolePermissionsBoundary`, `iam:DeleteUserPermissionsBoundary` | `*` | none |
| `DenyOtherRoles` | Deny | `sts:AssumeRole*` | `*` | none |
| `DenyOtherRegions` | Deny | NotAction: `iam:*`, `sts:*`, `cloudfront:*`, `route53:*`, `wafv2:*`, `globalaccelerator:*`, `tag:GetResources`, `s3:ListAllMyBuckets` | `*` | `aws:RequestedRegion` not in LAB_REGIONS |
| `CreateNeedsLabTag` | Deny | the create list in `lab-abac.json` | `*` | `aws:RequestTag/cloudlabs-lab` is null |
| `ChangeNeedsLabTag` | Deny | the change list in `lab-abac.json` | `*` | `aws:ResourceTag/cloudlabs-lab` is null (for EC2 also `ec2:CreateAction` is null, so tag-on-create still works) |
| `KeepLabTag` | Deny | `ec2:DeleteTags`, `tag:UntagResources`, each service's `Untag*` | `*` | `ForAnyValue aws:TagKeys` contains `cloudlabs-lab` |

**Service allow-list** (`LabServices`): ec2, elasticloadbalancing, autoscaling, application-autoscaling, ssm, cloudwatch,
logs, events, scheduler, sns, sqs, states, lambda, apigateway, dynamodb, cognito-idp, rds, elasticache, backup,
backup-storage, kms, secretsmanager, config, cloudformation, ecr, ecs, eks, kinesis, firehose, glue, athena, route53resolver,
elasticfilesystem, network-firewall, vpc-lattice, acm, wafv2, resource-groups, tag, access-analyzer, servicequotas (reads).
Not on it, so refused by default: everything else, including organizations, ram, fms, directconnect, networkmanager, shield,
verifiedaccess, acm-pca, guardduty, securityhub, macie2, outposts.

**Pass list** (`iam:PassedToService`): ec2, lambda, ecs-tasks, eks, states, config, backup, ssm, firehose, glue,
vpc-flow-logs, apigateway, events, scheduler, s3 (replication), cloudformation, `.amazonaws.com` each.
**Service-linked list** (`iam:AWSServiceName`): elasticloadbalancing, autoscaling, rds, elasticache, ecs, eks, eks-nodegroup,
network-firewall, globalaccelerator, backup, config, transitgateway, vpc-lattice, ssm, ec2-instance-connect,
`.amazonaws.com` each (V each name). Service-linked roles are AWS's shared, free roles: created on first use, never deleted
by a lab, and ignored by the sweep (ruling A18).
**Attachable AWS managed policies** (checked at plan, §7.3; the boundary caps them anyway): AmazonSSMManagedInstanceCore,
CloudWatchAgentServerPolicy, AmazonEKSClusterPolicy, AmazonEKSWorkerNodePolicy, AmazonEKS_CNI_Policy,
AmazonEC2ContainerRegistryReadOnly, AmazonECSTaskExecutionRolePolicy, AWSLambdaBasicExecutionRole,
AWSLambdaVPCAccessExecutionRole, AWS_ConfigRole, AWSBackupServiceRolePolicyForBackup,
AWSBackupServiceRolePolicyForRestores, AmazonSSMAutomationRole, AWSGlueServiceRole (exact ARNs with their paths, V).

**The ABAC lists (`infra/aws-bootstrap/lab-abac.json`):** written by `scripts/aws-labs-abac.mjs` from AWS's machine-readable
Service Authorization Reference (V for its address), committed and pinned by a test. The **create list** is every action of
an allow-listed service whose resource types accept `aws:RequestTag/${TagKey}` (ec2 `RunInstances` only on its instance,
volume and network-interface resources); the **change list** is every non-read action whose resource types accept
`aws:ResourceTag/${TagKey}`. Only those actions are listed, so a service or action without tag support is never blocked by
an absent key; it is covered instead by the plan-time tag rule (§7.3) and, for S3, by the bucket name. `scripts/aws-bootstrap.mjs`
ends with **`iam simulate-principal-policy`** cases (allowed: create a tagged VPC, a bounded lab role; refused: an untagged
VPC, anything on a `wg-admin=vpn` resource, a role without the boundary, a role outside the path, an access key, a third
region) and fails loudly if any answer differs (ruling A19).

### 7.2 The `wg-admin-lab-boundary` policy

Every lab role and lab 07 user carries it, so nothing a lab creates can exceed it, whatever policy the lab attaches.
- **Allow** (`*` resources, `aws:RequestedRegion` in LAB_REGIONS): the workload set: ec2, ssm, ssmmessages, ec2messages,
  cloudwatch, logs, events, sns, sqs, states, lambda, dynamodb, kms, secretsmanager, s3, ecr, ecs, eks, elasticloadbalancing,
  autoscaling, kinesis, firehose, glue, athena, config, backup, rds, elasticfilesystem, vpc-lattice-svcs;
  plus `sts:GetCallerIdentity`.
- **Deny:** all IAM writes (`iam:Create*`, `Delete*`, `Put*`, `Attach*`, `Detach*`, `Update*`, `Add*`, `Remove*`, `Set*`,
  `Tag*`, `Untag*`, `PassRole`, `CreateAccessKey`), `sts:AssumeRole*`, organizations, account, billing, budgets and cost
  writes, the account settings the role is denied (ruling A51), anything on a resource tagged `wg-admin=vpn` or any request setting or removing the `wg-admin` key, and any region
  outside LAB_REGIONS.
- **Deny, as the role does (ruling A48):** `ec2:CreateTags` outside a create (`ec2:CreateAction` null) on anything not
  already tagged `cloudlabs-lab`; `ec2:DeleteTags` with no tag keys (it would strip every tag); the VPC fabric actions
  (routes, route table associations, network ACL entries and associations, security group rules, security group, VPC and
  subnet changes, internet gateway attachment, CIDR association, peering) on network ACLs, route tables, security groups and
  VPCs not tagged `cloudlabs-lab`, so a lab's own Lambda, EC2, SSM or Config remediation role cannot touch the VPN server's
  VPC's untagged default security group, network ACL or main route table; and `ec2:*` but `ec2:Describe*` on the two default
  VPCs and anything inside them.

### 7.3 Enforcement

Two layers, as the main spec §8.4: the text before `terraform init`, the plan before apply. Both read `lab.yaml`'s `cloud`.

**`infra/ci/lab-lint.mjs --cloud aws`** (before init, and in `labs-check`): providers by full source address
`registry.terraform.io/hashicorp/{aws,random,time,tls,archive}`; no provisioners, modules, import blocks, other backends, cloud
blocks, `*.tf.json`, `*.tfvars` or CLI configuration; no `data "tls_certificate"` (it fetches a URL) and no `archive_file`
reading outside `path.module`; literal CIDRs only `0.0.0.0/0` and `::/0`; none of the headend's names (`vpc-wg`, `snet-wg`,
`rt-wg`, `sg-wg`, `igw-wg`, `nic-wg`, `pip-wg`, `vm-wg`, `osdisk-wg`, `rt-workloads`, `snet-workloads`, `sg-workloads`,
`vm-test`, `osdisk-test`: every `Name` in `infra/aws/main.tf`, ruling A50; the tag key `wg-admin`); provider blocks only as §4. CloudFormation
templates (lab 06, `terraform/cfn/*.yaml`) are read too: no `Transform`, macros, nested stacks, custom resources or IAM types,
no literal CIDRs.

**`infra/ci/lab-scope-aws.mjs`** (a sibling of `lab-scope.mjs`, same CLI, same output, run on `terraform show -json`). Rules,
one per refused resource, the first that applies:

1. `provider`: a provider not on the list, or an aws provider with credentials, endpoints, `assume_role*`, profiles, or a
   region other than the session's, the secondary (only in a lab with one), us-east-1 (only `aws_wafv2_web_acl` with
   scope CLOUDFRONT, in `AWS_GLOBAL_LABS`) or us-west-2 (only `aws_globalaccelerator_*`, same labs).
2. `provisioner`, 3. `import`: as Azure.
4. `type`: a resource type not on `AWS_TYPES` (the allow-list in `lab-scope-aws.mjs`: every type the 31 labs use, each with
   one line on why it stays inside the lab), or a data source not on `AWS_DATA` (AMI and SSM lookups only under
   `/aws/service/`, availability zones, caller identity, region, partition, IAM policy documents, AWS-managed prefix lists,
   `archive_file`). No data source may look up a VPC, subnet, route table, security group or instance. A Config recorder
   and delivery channel only in `AWS_CONFIG_LABS` (one recorder per region per account).
5. `never` (readme-only, cost or contract): `aws_dx_*`, `aws_networkmanager_*`, `aws_organizations_*`, `aws_ram_*`, `aws_fms_*`,
   `aws_shield_*`, `aws_verifiedaccess_*`, `aws_acmpca_*`, `aws_route53domains_*`, `aws_ec2_host`, capacity reservations and
   blocks, `aws_guardduty_*`, `aws_securityhub_*`, `aws_macie2_*`, `aws_iam_service_linked_role`, `aws_iam_access_key`,
   `aws_iam_account_*`, `aws_budgets_*`, `aws_ce_*`; dedicated tenancy; BYOIP pools.
6. `tag`: every resource whose plan has `tags_all` must carry `cloudlabs-lab = <id>` there; `aws_instance` also in
   `volume_tags` (`root_block_device.tags` never stands in: ruling A49); launch templates in `tag_specifications` for instance, volume and network-interface; Auto Scaling groups
   as §4; ECS services `propagate_tags = "SERVICE"`; RDS `copy_tags_to_snapshot = true`; Backup plans' rules
   `recovery_point_tags`; CloudFormation stacks' tags (V that CloudFormation copies stack tags to what it makes).
7. `untaggable`: types that cannot carry tags must be named `lab-<id>-*` (dashboards, CloudFront functions, origin access
   controls, cache and origin-request policies, KMS aliases, the Config recorder and delivery channel).
8. `iam`: roles, instance profiles and customer policies at path `/cloudlabs-lab/` named `lab-<id>-*`; roles and users with
   `permissions_boundary = BOUNDARY`; users and login profiles only in `AWS_IAM_USER_LABS`; attachments only of the managed
   list above or the lab's own policies; no inline or customer policy with an `iam:` action, `"*"` action or `NotAction`;
   trust policies naming only AWS service principals or the lab's own roles in the lab's own account (the plan's caller
   identity, else the role's boundary's; no other account, no wildcard, no federated principals: ruling A52).
9. `gateway`: any reference to the headend: its names, the `wg-admin` key or value, a VPC, route table or peering not made by
   this lab (peering and transit gateway resources only between the lab's own VPCs, by reference), `aws_vpc_peering_connection_accepter`;
   and any instance target that selects every instance, the headend's too (ruling A50): a wildcard id (`InstanceIds = ["*"]`,
   `instance_id = "*"`), a `tag-key` target, or a wildcard tag value, in SSM associations, EventBridge run-command targets,
   maintenance window targets and the like.
10. `address`: a VPC, subnet or secondary CIDR outside `var.address_space` or overlapping another of the lab's; a route
    destination other than the slot's addresses, `var.gateway_cidr`, `0.0.0.0/0`, `::/0` or the lab's own prefix lists; a
    customer IPv6 pool other than lab 20's own IPAM pool.
11. `public`: a public IPv4 on an instance, launch template, EIP association or subnet `map_public_ip_on_launch`, except the
    "public by nature" list (§7.4).
12. `lingering`: the mandatory no-lingering settings: `aws_db_instance` and `aws_rds_cluster` `skip_final_snapshot = true`,
    `deletion_protection = false`, `delete_automated_backups = true`; `aws_s3_bucket` `force_destroy = true`, no
    `aws_s3_bucket_object_lock_configuration`; `aws_secretsmanager_secret` `recovery_window_in_days = 0`; `aws_kms_key`
    `deletion_window_in_days = 7`, no `bypass_policy_lockout_safety_check`, and a key policy granting the account root
    `kms:*`; log groups declared in Terraform for every Lambda, ECS task, API stage, flow log and query log, with
    `retention_in_days ≤ 7` and `skip_destroy` false; ECR `force_delete = true`; Backup vaults `force_destroy = true` (V)
    and no `aws_backup_vault_lock_configuration`; load balancers, DynamoDB tables and Network Firewall with deletion
    protection off; instances with `disable_api_termination` and `disable_api_stop` false; CloudFront `retain_on_delete =
    false`; Route 53 zones `force_destroy = true`; no `aws_glacier_vault_lock`; CloudFormation templates with no
    `DeletionPolicy` or `UpdateReplacePolicy` of `Retain`.
13. `size`: instance types only `t4g.nano`, `t4g.micro`, `t4g.small`, `t3.micro`, `t3.small` (`t4g.medium` for lab 19's node,
    V for memory); RDS `db.t4g.micro`; ElastiCache `cache.t4g.micro`; EBS ≤ 30 GiB, io2 ≤ 500 IOPS; Auto Scaling max ≤ 4;
    EKS node groups max ≤ 2; Fargate ≤ 0.5 vCPU per task; Kinesis provisioned 1 shard; Network Firewall one subnet mapping;
    NAT gateways ≤ 2.

A lab that needs a new type, data source, size or managed policy adds it to the list with its reason, as ruling 21.

### 7.4 Public by nature (AWS)

Never a public IPv4 on an instance, with two exceptions where the service needs it: lab 22's "on-prem" router (an Elastic IP,
because a customer gateway needs a public address; its security group admits UDP 500 and 4500 only from the two tunnel
outside addresses). Lab 25's appliance has no public address: it builds through the lab's NAT gateway. Accepted as public by nature:
internet-facing ALBs and NLBs serving one static page on port 80, NAT gateways, CloudFront distributions, Global Accelerator,
the Client VPN endpoint, API Gateway, public Route 53 zones. Never an inbound rule from the internet to SSH.

### 7.5 The risk, stated plainly

`wg-admin-labs` is a new role assumed only by GitHub workflows on `main`. **Within lab-tagged resources in London and Ireland
(and the few global pieces CloudFront, WAF for CloudFront, Route 53 and Global Accelerator need), it can create and delete
freely.** A bad change merged to `main` could run up cost until the budget guard tears labs down (and the account's AWS
Budgets alarm emails). It **cannot** touch the VPN server or anything tagged `wg-admin=vpn`, the default VPC, IAM outside
`/cloudlabs-lab/lab-*`, access keys, other roles, other regions, Organizations or billing. Two gaps are code, not IAM: S3 and
Route 53 have no reliable tag conditions for Terraform's calls, so buckets are owned by name (`cloudlabs-*`) and Route 53 is
allowed account-wide (the account holds no other hosted zones, V). AWS creates a VPC's default security group, network
ACL and main route table untagged; ruling A48 protects the headend VPC's: the role and the boundary add tags only at
create or to what already carries `cloudlabs-lab`, and change VPC fabric only where it carries it, and the scope check
refuses `aws_default_security_group`, `aws_default_network_acl`, `aws_default_route_table` and `aws_ec2_tag` with a plain
message. Two gaps stay with the plan-time scope check. A VPC id passed as a parameter is not an IAM resource (Route 53
`AssociateVPCWithHostedZone`, Route 53 Resolver associations, VPC Lattice VPC associations), so a lab naming the server's
VPC there is refused by the scope check's known-id rule, and the boundary allows no `route53`, `route53resolver` or
`vpc-lattice` writes, so nothing a lab creates can make one. And a lab role's trust policy is checked at plan time only
(the `iam` rule), which pins a role principal to the lab's own account (ruling A52). Account-wide settings that reach the
headend are denied to the role and the boundary alike: EC2's (Block Public Access, EBS encryption defaults and the like)
and SSM's (service settings, among them Default Host Management, which would make the headend SSM-managed, and the
default patch baseline; ruling A51); and the scope check refuses an instance target that selects every instance, or names
the headend (ruling A50). Mitigations: main-only trust, the boundary on every lab identity, the
scope check before any apply, the simulator cases at bootstrap, the orphan sweep.

## 8. Clean-up

**Order:** Unpeer → Unblock → `terraform destroy` → Safety net → Verify clean. Every step after Unpeer runs even when an
earlier one failed. Safety net and Verify clean need no state.

### 8.1 Unblock (`infra/ci/lab-unblock-aws.sh`)

Turns off what a learner can switch on and what stops a delete, for the lab's tagged resources only, never failing the run:
RDS, ELB, DynamoDB and Network Firewall deletion protection; EC2 termination and stop protection; CloudFormation termination
protection; the Config recorder stopped (lab 02); every recovery point in the lab's Backup vaults deleted, polling every 15 s
until the vaults are empty (at most `LAB_UNBLOCK_VAULT_WAIT_SECONDS`, 300); Client VPN connections terminated; Lambda VPC
network interfaces waited for (they release slowly, V up to 20 minutes, bounded by the job deadline). An S3 Object Lock or
legal hold a learner switched on by hand is a loud warning.

### 8.2 Safety net (`infra/ci/lab-aws-safety-net.sh`, AWS CLI and jq, no packages)

Candidates come from `tag:GetResources` (key `cloudlabs-lab`, value the lab id) in eu-west-2 and eu-west-1, and in us-east-1
and us-west-2 for `AWS_GLOBAL_LABS`; IAM by path and prefix; the named untaggable items. Each is deleted by its own service, in
dependency order, each delete issued then polled:

1. Workloads: CloudFormation stacks; EKS node groups, then clusters; ECS services (desired 0), then clusters; Auto Scaling
   groups (force delete); Lambda functions; API Gateway APIs; Step Functions; EventBridge rules (targets first) and Scheduler
   schedules; Kinesis streams and Firehose; Glue crawlers, tables, databases; Athena workgroups (recursive); Config rules,
   remediation configurations, delivery channel and recorder.
2. Edge and DNS: CloudFront distributions (disable, wait for Deployed, delete; slow, V up to 20 minutes), functions and origin
   access controls; Global Accelerator (disable, wait, delete); WAF web ACLs; Route 53 records, zones and health checks;
   Resolver rule associations, rules, endpoints, query log configs, DNS Firewall associations, rule groups and domain lists;
   VPC Lattice associations, services and networks.
3. Network services: Client VPN associations and endpoints; Network Firewall (then policies and rule groups); load balancers,
   then listener rules and listeners still there (most go with their load balancer), then target groups; VPC endpoint
   services and endpoints; RDS replicas, then instances, subnet and parameter groups, tagged
   snapshots; ElastiCache; EFS mount targets, then file systems; instances (terminate, wait); launch templates; NAT gateways
   (wait); Elastic IPs; VPN connections, virtual private gateways (detach), customer gateways; transit gateway peering and
   VPC attachments, route tables, transit gateways; VPC peering connections; traffic mirror sessions, targets, filters; flow
   logs; Reachability and Network Access Analyzer paths and scopes; IPAM pools, scopes and IPAMs; Instance Connect Endpoints.
4. VPC fabric: detached network interfaces, security groups (cross-references revoked first), subnets, route tables, network
   ACLs, internet and egress-only gateways, prefix lists, VPCs; then security group rules still there (most go with their
   group), revoked by id, never in the headend's VPC.
5. Data and the rest: S3 buckets (every version emptied); DynamoDB tables (replicas first); SQS, SNS; KMS keys (deletion
   scheduled, 7 days); secrets (forced); log groups; alarms and dashboards; SSM documents, associations and maintenance
   windows; Backup plans and vaults; ECR repositories (forced); Cognito user pools (domain first); ACM certificates; tagged
   AMIs (deregistered) and snapshots; resource groups.
6. IAM: instance profiles (roles removed), role policies detached and deleted, roles; lab 07's users (login profile and policies
   first); customer policies (old versions first). Only `/cloudlabs-lab/lab-<id>-*`.

Deletes poll every `LAB_DELETE_POLL_SECONDS` (30) and stop by `LAB_JOB_DEADLINE` less 420 s, as ruling 22; anything still
there is a warning, "left behind".

### 8.3 Verify clean

The Resource Groups Tagging API keeps showing terminated and deleted items for about an hour (V), so it only **finds**
candidates; each one's **real state** is read by its own describe (an instance `terminated`, a NAT gateway `deleted`, a VPC or
bucket not found, a KMS key `PendingDeletion` counts as clean; a security group rule, listener or listener rule is read by its
own id or ARN, and not found is clean). Plus: IAM listed by path and prefix; the Config recorder by
name; and, while any lab VPC still exists, every network interface and instance inside it, tagged or not, so a hand-made
untagged instance is reported by name ("untagged inside lab VPC: i-…") instead of silently blocking the VPC. Service-linked
roles and AWS-managed resources are never leftovers. Outputs `clean` and `leftovers` exactly as `lab-safety-net.sh --verify`.

### 8.4 Orphan sweep

As §6 (hourly, read-only, 12 AWS calls, 90-minute grace). Clean up is a `lab-aws.yml` destroy run for that lab id. A clean
sweep releases the slots of `ended_dirty` AWS sessions.

## 9. Cost and budget

- **Estimate:** £/h = Σ `gbp_h × qty`, with `aws_price` refreshing each item from AWS's list price (USD × `config.aws.usdToGbp`,
  0.75 today) when under 7 days old; otherwise the authored figure and the modal says so. List prices before free tier,
  credits and VAT. Many AWS hourly charges bill a started hour as a whole hour (NAT gateways, load balancers, transit gateway
  attachments, VPN, Client VPN; V each), so a short session costs at least one hour of them: items marked `whole_hours:
  true` are counted per started hour in the modal's per-session figure and in a session's estimate (ruling A20).
- **Per-use charges** that no estimate can know (a Reachability Analyzer analysis, about £0.075 each; Network Access Analyzer
  per interface analysed; Logs Insights and Athena per GB scanned; a Glue crawler run, about £0.05) are named in the readme
  beside the Things to try that cause them.
- **Actuals:** the daily Cost Explorer pull by tag (§6), shown as "actual" the day after a session ends, split over that day's
  sessions by duration, as the main spec §9.4. Tags reach Cost Explorer only after the tag is activated and about a day after
  that (V).
- **Budget guard:** unchanged; one monthly budget for both clouds and both kinds of work. At 100% every lab is torn down, AWS
  ones included, deploying ones cancelled first; the server never. "Deploy anyway" only skips the warning (decision B).
- **Warnings** in the deploy modal: budget, capacity (§6), pricey, slow, not available, as the main spec §9.2.
- **Card markers** come from `costMarker` on the estimate, unchanged (£ under 5p/h, ££ under 50p/h, £££ from 50p/h or a
  30-minute deploy). The curriculum's planning tiers (§12) use the decisions' rough bands and can differ from the card
  (ruling A21).

## 10. Dashboard changes

- **Header:** title "Labs" (was "Azure Labs"); subtitle `LABS_SUBTITLE` = "Hands-on Azure (AZ-104, AZ-305, AZ-700) and AWS
  (SOA-C03, SAA-C03, ANS-C01) environments: pick a lab, deploy it, learn by doing."
- **Cards:** an **AWS** badge on every AWS card (Azure cards unchanged). Number labels read "Lab 5" for Azure and "AWS 5" for
  AWS; "run before" badges use the same form (ruling A22).
- **Filters:** a **Cloud** filter (All, Azure, AWS) above Exam; the exam list shows the chosen cloud's exams. With no exam
  filter, cards group by primary exam in `LAB_EXAMS` order, so Azure first, then AWS.
- **Coverage map:** six exams under two headings, Azure and AWS, each exam's domains as rows (§12.1).
- **Lab modal, AWS:** no region picker (London; the lab's secondary region named when it has one); "Peer to gateway" offered
  only when the server is in AWS, otherwise "Runs unconnected: AWS labs connect only to an AWS server"; resources panel from
  tags with **Open in AWS console** (the `lab-<id>` resource group, one link per region); private addresses; `connect` lines;
  `labadmin` password, lab 07's user and lab 31's files behind **Show** (files with a Download button each).
- **Connect lines** (lab outputs): `aws ec2-instance-connect ssh --instance-id <id> --os-user labadmin --connection-type eice`
  (works anywhere, through the lab's Instance Connect Endpoint; the CLI asks for the password), and while peered `ssh
  labadmin@10.64.x.y` and `curl http://10.64.x.y`.
- **Topology:** `KindDef` gains `awsTypes` (tagging-API resource types) and AWS Terraform types; a region **lane** stands where
  Azure draws the resource group. AWS types map onto existing kinds where the meaning matches (VPC → `vnet`, subnet →
  `subnet`, instance → `vm`, Auto Scaling group → `vmss`, ALB/NLB/GWLB → `loadBalancer` with the type as its sku, NAT gateway →
  `natGateway`, VPC endpoint → `privateEndpoint`, endpoint service → `privateLinkService`, security group → `nsg`, route table
  → `routeTable`, Elastic IP → `publicIp`, customer gateway → `localNetworkGateway`, virtual private gateway and VPN connection
  → `vpnGateway`, Network Firewall → `firewall`, firewall policy → `firewallPolicy`, WAF web ACL → `wafPolicy`, Route 53 zones
  → `dnsZone` / `privateDnsZone`, Resolver endpoint → `dnsResolver`, Resolver rule → `dnsRuleset`, CloudFront → `frontDoor`,
  Global Accelerator → `trafficManager`, EKS → `aks`, ECS service → `containerApp`, S3 → `storage`, RDS → `sqlServer`, KMS →
  `keyVault`, ECR → `registry`, Backup vault → `recoveryVault`, IAM role → `managedIdentity`); new kinds where none fits:
  `transitGateway` (attachments folded in, edges per attachment), `internetGateway`, `lambda`, `dynamodb`, `messaging`
  (SQS, SNS, EventBridge, Step Functions), `cache` (ElastiCache), `stream` (Kinesis, Firehose), `lattice`, `clientVpn`;
  anything else `generic`. VPC peering draws as Azure peering does; the WireGuard gateway node links to the peered VPC. Icons
  come from a second sprite, `icons/aws.svg`, from AWS's official Architecture Icons (V the licence's diagram use), and
  `labs-diagrams` draws each AWS lab's readme diagram from its planned topology as for Azure.
- **Elsewhere:** Activity lists AWS lab runs with the lab's title (GitHub link to `lab-aws.yml`); the running-labs widget and the
  running strip show the AWS badge; the Cost "Labs" panel includes AWS labs' actuals and estimates; Settings → Labs shows the
  AWS permission ticks (§6).

## 11. Keeping labs honest

- **`npm run labs-check`** (CI, no cloud calls) for AWS labs: the schema and field rules of §3.2; ids, numbers per cloud,
  prerequisites in the same cloud; readme headings and the AWS footer; `terraform fmt -check`, `init -backend=false`,
  `validate` with the AWS providers pinned; `lab-lint.mjs --cloud aws`; `lab-scope-aws.mjs --hcl` (the HCL early warning);
  `labs-tf`'s offline mock plan (`terraform test` with a mocked aws provider) checked by `lab-scope-aws.mjs --plan`; the pool
  and `subnets_used`; `aws_price` references well formed; the six-exam skill-area file. Worker unit tests: same-cloud peering,
  dispatch by cloud, secrets refused across workflows, AWS orphan matching and grace, cost rows by tag, price references,
  capacity sums; script tests: scope rules with one evil plan per rule, lint, the ABAC list pin, the IAM pin of both
  policies.
- **`npm run labs-verify`** (network, never in `npm test`): every readme link answers 200; **`--aws-prices`** asks the Price List
  API (Steven's local keys, read only) for every `aws_price` in eu-west-2 and, where used, eu-west-1, and fails when a
  reference matches no product or more than one, or an authored `gbp_h` is more than 25% from AWS's.
- **Release test on real AWS:** Settings → Labs → **Test** (or `scripts/lab-release-test.mjs`) runs `action: test` once per
  lab version: deploy, ready check, peer and unpeer when the lab can peer and the server is running in AWS, destroy, verify
  clean. Recorded in `lab_release_tests`; a version is released when its test passes with `clean: true`; untested versions
  stay deployable, marked "Untested". Each release test records its plan's shape (ruling 35).
- **Spend:** release tests of all 31 labs are estimated at **£8–10** including retries; **cap £15** across the four batches.
  One full pass of all 31 is about £2.40 likely and £4 worst (each hourly item billed one whole hour). Before each batch's
  tests the plan checks the month's AWS spend; a projected overrun of £15 is a stop for Steven.

## 12. Curriculum

### 12.1 Skill areas (`labs/skill-areas.yaml` gains; the exact domain names of the AWS exam guides, read 2026-10-15)

| Key | Exam | Domain (exact name) | Weight |
|---|---|---|---|
| `soa.monitoring` | SOA-C03 | Monitoring, Logging, Analysis, Remediation, and Performance Optimization | 22% |
| `soa.reliability` | SOA-C03 | Reliability and Business Continuity | 22% |
| `soa.deployment` | SOA-C03 | Deployment, Provisioning, and Automation | 22% |
| `soa.security` | SOA-C03 | Security and Compliance | 16% |
| `soa.networking` | SOA-C03 | Networking and Content Delivery | 18% |
| `saa.secure` | SAA-C03 | Design Secure Architectures | 30% |
| `saa.resilient` | SAA-C03 | Design Resilient Architectures | 26% |
| `saa.performance` | SAA-C03 | Design High-Performing Architectures | 24% |
| `saa.cost` | SAA-C03 | Design Cost-Optimized Architectures | 20% |
| `ans.design` | ANS-C01 | Network Design | 30% |
| `ans.implementation` | ANS-C01 | Network Implementation | 26% |
| `ans.operations` | ANS-C01 | Network Management and Operation | 20% |
| `ans.security` | ANS-C01 | Network Security, Compliance, and Governance | 24% |

The exam names shown are "AWS Certified CloudOps Engineer - Associate", "AWS Certified Solutions Architect - Associate" and
"AWS Certified Advanced Networking - Specialty". A lab may tag areas of other AWS exams (ruling 39); never an Azure exam's.

### 12.2 The labs

Areas use the key without the exam prefix for the lab's own exam and the full key for another exam's. Tier is the approved
planning band (£ about 10p/h or less, ££ about 20–40p/h, £££ 45p/h or more) with the planning £/h at London list prices;
release tests replace times and prices. Peer: off / opt. D/X: deploy and destroy minutes; S/M: session and maximum hours.
Level: F foundation, A associate, E expert.

| # | Id | Title | Areas | Lvl | Type | Tier (£/h) | Peer | D/X | S/M | Prereq | Key resources |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 01 | soa-01-cloudwatch | CloudWatch: agent, custom metrics, alarms, Logs Insights | monitoring | F | explore | £ (0.03) | opt | 4/3 | 2/6 | – | t4g.micro with CloudWatch agent, log group and metric filter, alarms, dashboard, EventBridge rule → SNS, logs and monitoring endpoints |
| 02 | soa-02-systems-manager | Systems Manager and Config auto-remediation | monitoring, deployment, security | A | explore | £ (0.05) | opt | 6/4 | 2/6 | 01 | 2 instances, SSM endpoints, Run Command, Patch Manager baseline, State Manager association, Config recorder (made and deleted by the lab) with `restricted-ssh` and SSM Automation remediation |
| 03 | soa-03-auto-scaling | Auto Scaling behind an Application Load Balancer | reliability, deployment, saa.resilient | A | explore | £ (0.05) | opt | 6/6 | 2/6 | 01 | launch template, ASG over 2 AZs (2–4), target tracking, scheduled action, lifecycle hook, instance refresh, internet-facing ALB |
| 04 | soa-04-backup | Backup, snapshots, S3 versioning and replication | reliability, saa.resilient | A | explore | £ (0.01) | opt | 5/5 | 2/6 | – | Backup plan and vault, EBS volume with snapshot and restore, S3 versioning, lifecycle, same-region replication |
| 05 | soa-05-rds | RDS MySQL: Multi-AZ failover, read replica, insights | reliability, monitoring, saa.performance | A | explore | £ (0.05) | opt | 20/15 | 2/4 | – | db.t4g.micro Multi-AZ, read replica, parameter group, snapshots, Performance Insights (V on t4g.micro), client instance |
| 06 | soa-06-cloudformation | CloudFormation inside Terraform | deployment | A | explore | £ (0.01) | off | 4/4 | 2/6 | – | a stack from `cfn/stack.yaml` (allow-listed types), change sets, drift detection, stack policy |
| 07 | soa-07-iam-kms | IAM, permission boundaries and KMS | security, saa.secure | A | explore | £ (0.01) | off | 3/3 | 2/6 | – | lab roles and one console user under the boundary, Access Analyzer (external), customer key and key policy, secret with Lambda rotation |
| 08 | soa-08-vpc-fix | Break-fix: VPC connectivity troubleshooting | networking, monitoring, ans.operations | A | break-fix | £ (0.01) | opt | 5/4 | 2/4 | – | app and data VPCs peered, web and db instances, flow logs to CloudWatch; Reachability Analyzer by hand |
| 09 | soa-09-route53-cloudfront | Route 53 routing and CloudFront in front of S3 | networking, ans.design | A | explore | £ (0.01) | off | 8/12 | 2/4 | – | public zone `<name_prefix>.labs.clydeford.net` (not delegated), health checks, failover and weighted records, CloudFront with OAC to a private bucket |
| 10 | soa-10-containers | Containers: ECR and ECS Fargate behind an ALB | deployment, monitoring | A | explore | £ (0.10) | opt | 8/6 | 2/4 | 03 | ECR repository, ECS cluster with Container Insights, Fargate service (2 tasks) behind an ALB, NAT gateway |
| 11 | saa-11-three-tier | Three-tier web app across two AZs | resilient, performance | A | explore | £ (0.13) | opt | 20/15 | 2/4 | 03, 05 | ALB, ASG (2), RDS MySQL Multi-AZ, ElastiCache, NAT gateway |
| 12 | saa-12-serverless-api | Serverless API with Cognito sign-in | secure, resilient, performance | A | explore | £ (0.00) | off | 4/3 | 2/6 | – | API Gateway HTTP API, JWT authoriser on a Cognito user pool, Lambda, DynamoDB on demand |
| 13 | saa-13-decoupling | Decoupling: queues, fan-out, events, workflows | resilient | A | explore | £ (0.00) | off | 4/3 | 2/6 | 12 | SQS with DLQ, SNS fan-out to two queues, EventBridge bus and rule, Step Functions with a Lambda step |
| 14 | saa-14-storage | Storage choices: S3 classes, EFS, EBS gp3 and io2 | performance, cost | A | explore | £ (0.02) | opt | 5/4 | 2/6 | – | bucket with Intelligent-Tiering and lifecycle, EFS with mount targets, gp3 and io2 volumes on one instance |
| 15 | saa-15-data-security | Data security: KMS, bucket and endpoint policies | secure, soa.security | A | explore | £ (0.01) | opt | 3/3 | 2/6 | 07 | customer key, SSE-KMS bucket, bucket policy, S3 gateway endpoint with policy, instance to test from |
| 16 | saa-16-dr-pilot-light | Pilot-light DR across London and Ireland | resilient, soa.reliability | A | explore | £ (0.02) | opt | 12/12 | 2/4 | 04 | S3 cross-region replication, DynamoDB global table, private-zone failover records on a CloudWatch-alarm health check (V), AMI copied to Ireland |
| 17 | saa-17-data-pipeline | Streaming data pipeline to Athena | performance | A | explore | £ (0.02) | off | 5/5 | 2/4 | – | Kinesis Data Streams (1 shard), producer Lambda on a schedule, Firehose to S3, Glue crawler, Athena workgroup |
| 18 | saa-18-cost-compute | Cost-optimised compute: Spot, Graviton and x86 | cost, performance | A | explore | £ (0.02) | opt | 5/5 | 2/4 | 03 | mixed-instances ASG (On-Demand base, Spot above, t4g and t3), price comparison in the readme |
| 19 | saa-19-eks | EKS with a managed node group | performance | E | explore | £ (0.14) | opt | 20/15 | 2/3 | 10 | EKS cluster, one-node managed group (t4g.medium, V), NAT gateway, a sample deployment reached by port-forward |
| 20 | ans-20-vpc-design | VPC design: dual stack, IPAM, prefix lists, egress | design, implementation | A | explore | £ (0.05) | opt | 5/5 | 2/4 | – | dual-stack VPC, secondary CIDR, IPAM free tier with a pool from the slot (V), prefix lists, NAT gateway, egress-only internet gateway |
| 21 | ans-21-transit-gateway | Transit Gateway: segmentation and central egress | design, implementation | E | explore | ££ (0.17) | opt | 8/8 | 2/4 | 20 | TGW, 3 VPCs (2 spokes, egress), segmented route tables, blackhole route, appliance mode, NAT in the egress VPC |
| 22 | ans-22-s2s-vpn | Site-to-site VPN with BGP to a pretend data centre | implementation, operations, design | E | explore | £ (0.05) | opt | 12/10 | 2/3 | 20 | VGW, customer gateway, VPN connection (2 tunnels, BGP), "on-prem" VPC with a strongSwan and FRR router on Ubuntu with an EIP |
| 23 | ans-23-hybrid-dns | Hybrid DNS with Route 53 Resolver | design, implementation, security | E | explore | ££ (0.38) | opt | 8/8 | 2/3 | 20 | inbound and outbound endpoints, forwarding rule, "on-prem" DNS server on EC2 (dnsmasq), private hosted zone, DNS Firewall, query logging |
| 24 | ans-24-privatelink | PrivateLink: endpoints and endpoint services | design, implementation, security, saa.secure | E | explore | £ (0.05) | opt | 6/6 | 2/4 | 20 | provider VPC with NLB and endpoint service, consumer VPC with interface endpoint and private DNS, gateway endpoint with policy |
| 25 | ans-25-load-balancing | Load balancing in depth: ALB, NLB and GWLB | design, security | E | explore | £ (0.13) | opt | 10/8 | 2/3 | 03 | ALB rules and weighted target groups with an imported self-signed certificate, NLB with static EIPs, TLS and proxy protocol, GWLB with a GENEVE appliance (V build time) |
| 26 | ans-26-edge | Edge: CloudFront, WAF and Global Accelerator | design, security, soa.networking | E | explore | £ (0.04) | off | 12/15 | 2/3 | 09 | CloudFront with an origin group (failover), CloudFront Function, WAF web ACL (us-east-1), Global Accelerator to instances in London and Ireland |
| 27 | ans-27-network-firewall | Network Firewall in an inspection VPC | security, design | E | explore | £££ (0.46) | opt | 15/15 | 2/3 | 21 | TGW in appliance mode, inspection VPC with Network Firewall (one AZ), stateful and stateless rule groups, 2 spokes, NAT |
| 28 | ans-28-flow-logs-fix | Break-fix: flow logs, mirroring and analyzers | operations, security, soa.networking | E | break-fix | £ (0.05) | opt | 6/5 | 2/4 | 08 | client and service VPCs, NLB, flow logs to CloudWatch and to S3 with an Athena table, traffic mirror target and filter |
| 29 | ans-29-multi-region | Multi-region: inter-region TGW peering | design, implementation | E | explore | ££ (0.20) | opt | 15/12 | 2/3 | 21 | a TGW and VPC in London and in Ireland, TGW peering attachment and static routes, VPC peering between the same VPCs to compare |
| 30 | ans-30-vpc-lattice | VPC Lattice service network with auth policies | design, security | E | explore | £ (0.05) | opt | 6/5 | 2/4 | 24 | service network, two services with instance targets in two VPCs, IAM auth policy, a client signing with SigV4 |
| 31 | ans-31-client-vpn | AWS Client VPN with certificates, compared with WireGuard | implementation, security | E | explore | £ (0.12) | opt | 10/8 | 2/3 | – | Client VPN endpoint with mutual certificate auth (CA, server and client from `tls`, imported to ACM), split tunnel, authorisation rules, a target instance |

**Break-fix faults** (readme Symptom; "What was broken" collapsed): lab 08, the web instance cannot reach the database on TCP
3306 across the peering: (1) the data VPC's route table has no route back to the app VPC, (2) the database subnet's network ACL
has no outbound rule for ephemeral ports, (3) the database security group allows 3306 from the wrong /24. Lab 28, clients
reach the service through the NLB intermittently or not at all while health checks pass: (1) the targets' security group
admits only the NLB subnets, but client IP preservation means packets arrive from client addresses, (2) the service subnet's
network ACL drops return traffic to the client range, which flow logs show as an accepted inbound and a rejected outbound
record.

**Not built here** (readme-only, in the nearest lab; `never` rule refuses the types):
- **Direct Connect** (VIFs, LAG, MACsec, Direct Connect gateway, SiteLink) and **accelerated VPN**: lab 22.
- **Cloud WAN** and **RAM sharing of a transit gateway**: lab 21.
- **Organizations and SCPs**: lab 07. **Firewall Manager**: lab 27.
- **Shield Advanced**: lab 26. **Verified Access**: lab 31.
- **StackSets**: lab 06. **EKS** (as a comparison): lab 10. **Savings Plans and Reserved Instances**: lab 18.

Coverage: every domain of the three exams has at least two labs (soa.security three; saa.cost two; ans.operations three).

## 13. Account changes (approved)

Made with the local admin keys by `scripts/aws-bootstrap.mjs` (a new `--labs` part), each read back and reported:
- **Service Quotas:** VPCs per region to **20** and EC2-VPC Elastic IPs to **10**, in eu-west-2 and eu-west-1 (both 5 today,
  verified 2026-10-15). Also read, and raised only if below: Running On-Demand Standard vCPUs to 32 and EC2 Instance Connect
  Endpoints per region to 10 in both regions (V current defaults; ruling A23).
- **Cost allocation tag `cloudlabs-lab`** activated (`ce:UpdateCostAllocationTagsStatus`) once a tagged resource exists, so it
  runs after B1's first release test; the bootstrap prints whether it is active.
- **IAM:** the `wg-admin-labs` role, the `wg-admin-lab-boundary` policy, the Worker user's new read statements, and the GitHub
  secret `AWS_LABS_ROLE_ARN`. The default VPC (172.31.0.0/16) is left alone and protected by `DenyDefaultVpc`.

## 14. Delivery

Four batches. Each is built, merged, deployed, and then every lab in it passes a real-AWS release test with `clean: true`
before the next batch starts. The role trusts only `main`, so labs land on main marked "Untested" and are tested from there;
fixes follow as small PRs with a version bump (ruling A24). Targeted tests while building, one full gate at the end of each
batch, CI covers the rest.

1. **B1: engine + labs 01–05.** Contract and `lab.yaml` rules, labs-build and labs-check, `labs/_template-aws`, the six-exam
   skill areas, `lab-aws.yml`, `aws-lab-creds.sh`, `lab-lint.mjs --cloud aws`, `lab-scope-aws.mjs`, `lab-ready-aws.sh`,
   `lab-unblock-aws.sh`, `lab-aws-safety-net.sh`, the AWS peer script, `lab-parse.sh` and `lab-transient.mjs` changes; the
   bootstrap (role, boundary, ABAC lists and their script, simulator cases, Worker read statements, quotas, cost tag); the
   Worker (cloud through the engine, dispatch by cloud, same-cloud peering, secrets by workflow, orphans, cost by tag,
   `aws.labPrices`, capacity, permission ticks, API fields); the web (header, badge, cloud filter, coverage map, AWS modal,
   console links, connect lines, topology kinds, the AWS sprite); `labs-verify --aws-prices`; README setup steps. The B1 test
   cycle also destroys the AWS headend once while lab 01 is peered, to answer whether AWS deletes a VPC that has a peering
   connection (V; §15).
2. **B2: labs 06–10.** The CloudFormation template reader (lab 06), lab 07's user, login profile and files, the us-east-1
   plumbing for CloudFront and Route 53 (lab 09), ECS (lab 10).
3. **B3: labs 11–19.** The secondary region (lab 16), EKS (lab 19), Spot (lab 18), the data pipeline (lab 17).
4. **B4: labs 20–31.** Transit gateways, VPN, Resolver, PrivateLink, GWLB, Global Accelerator and us-west-2, Network Firewall,
   traffic mirroring, inter-region peering, Lattice, Client VPN and migration `0025_lab_files.sql`.

Each batch's PR contains its labs (folder, `labs/_learning/<id>.yaml`, planned topology and readme diagrams), the engine
parts first needed by them, their tests and fixtures, and its plan's rulings copied into this spec's §17.

## 15. Risks and open questions

| Item | Status |
|---|---|
| Role blast radius (§7.5) | Accepted by Steven with decision 2. The tag and name rules plus the boundary are AWS-enforced; the headend VPC's untagged defaults and Route 53 rely on code. |
| ABAC gaps | Some actions do not accept tag keys; only listed actions are guarded (§7.1). A real create that fails on the tag guard is fixed in `lab-abac.json` and re-simulated. |
| Peering and headend destroy | (V) whether `DeleteVpc` on `vpc-wg` succeeds with an active peering connection (AWS is believed to delete the peering with the VPC). If it does not, a "Remove lab peerings" step in `wg-aws.yml` destroy is needed: that touches the server's workflow, so it is a **stop for Steven**. |
| Hand-made untagged resources | Not deletable by the role; named as leftovers so Steven can delete or tag them (footer, §8.3). The session ends `ended_dirty` until clean. |
| Tagging API lag | Deleted items listed for about an hour (V); Verify clean uses real describes, the sweep a 90-minute grace. |
| Slow deletes | CloudFront distributions (disable, then delete, V up to 20 minutes), Lambda VPC interfaces, RDS Multi-AZ. Destroy times from release tests; job timeout cap 150 holds (lab 05's is 90). |
| EKS-made resources | The cluster's own security group and interfaces are made by EKS untagged and removed with the cluster; a Kubernetes `LoadBalancer` service would make an untagged ELB, so lab 19's readme uses port-forward and Unblock deletes ELBs tagged `kubernetes.io/cluster/<name>` (V). |
| Partial-hour billing | Hourly items bill whole hours (V each); estimates round them up per session. |
| Price matching | A Price List filter set may match several products; `labs-verify --aws-prices` refuses that, and `{usage}` prefixes are V per region. |
| Quotas | VPC and EIP increases approved; vCPU and Instance Connect Endpoint defaults V. A refused increase limits how many labs run at once, not the design. |
| Global services | CloudFront and Route 53 sign in us-east-1, Global Accelerator in us-west-2 (V); only `AWS_GLOBAL_LABS` may use them. |
| KMS pending deletion | A key waits 7 days to delete; whether it is billed meanwhile is V. Verify clean counts it clean. |
| Route 53 zone charge | Zones deleted within 12 hours are believed not to be charged (V). |
| Lab 25 appliance | The GWLB appliance builds AWS's open-source GENEVE handler at boot through the NAT gateway (V build time inside `deploy_min`). |
| Lab 05 Performance Insights | Availability on db.t4g.micro is V; the readme falls back to CloudWatch Database Insights standard mode if not. |
| Cost tag delay | Activation needs a tagged resource and takes up to a day; actuals show "estimate" until then. |
| AWS Budgets alarm | The account alarm is $19 (about £15); release tests plus the server could trip it in a heavy month. It only emails. |

Open questions for Steven: none block B1. The headend-destroy question is answered by B1's test and stops only if a server
workflow change turns out to be needed.

## 16. Decisions Steven may want to change

1. **Regions:** London for every lab, Ireland as the only second region.
2. **One budget** for both clouds, servers and labs; at 100% every lab goes. Suggested: £30 for an AWS study month.
3. **Same-cloud peering only;** cross-cloud labs run unconnected.
4. **The account alarm** stays at $19; consider $40 while working through the AWS labs.
5. **Instance types:** Graviton `t4g` by default; x86 only where a lab compares.
6. **Login:** `labadmin` with the session password, SSH through an EC2 Instance Connect Endpoint; no public IPs on instances.
7. **Hand-made resources:** removed only if tagged `cloudlabs-lab = <id>` (the role cannot touch untagged things).
8. **Lab 09's zone** is a non-delegated `labs.clydeford.net` subdomain in Route 53; Cloudflare DNS is not changed.
9. **Release tests from main** after each batch merges (labs are "Untested" until their test passes).
10. **Header title** "Labs" for both clouds.
11. **Ids** `soa-NN-slug`, `saa-NN-slug`, `ans-NN-slug`, numbered 01–31 within AWS (Azure keeps 1–44; numbers may repeat across clouds).

## 17. Rulings

Details decided in this spec that `decisions.md` left open, each with its reason. Where a later plan differs, its rulings are
copied here and win.

- **A1. One id pattern for both clouds,** `^(az(104|305|700)|soa|saa|ans)-\d{2}-…$`, in every copy. Keeps one catalogue and
  one parser; the prefix names the exam and so the cloud.
- **A2. AWS ids at most 30 characters.** IAM role names stop at 64; `lab-<id>-` must leave room for a useful suffix.
- **A3. Lab numbers are unique per cloud.** The decisions number AWS 01–31 while Azure uses 1–44.
- **A4. Untaggable types are owned by name `lab-<id>-*`.** The tag is the ownership rule, and a few types cannot carry one;
  the name gives the safety net and sweep a second, equally narrow key.
- **A5. AWS name prefixes start `a`.** Globally unique AWS names never collide with an Azure lab of the same number.
- **A6. `cloud` is optional (default azure) but must agree with the id;** AWS labs use `aws_price` and `instance_types`, and
  the Azure fields are refused there. One schema with clear per-cloud rules; no silent mixing.
- **A7. `{usage}` placeholder in `usagetype` filters.** AWS usage types carry a region prefix, and one reference must price in
  both regions.
- **A8. `dns_link` is false for AWS labs.** The deploy role has no Route 53 rights and the headend's resolver does not
  forward to lab zones; adding either would change the server.
- **A9. AWS readme footer names the tag.** AWS has no resource-group container that deletes its contents.
- **A10. New Terraform variable `gateway_cidr`.** Lab security groups must admit the headend's address while literal CIDRs
  stay refused.
- **A11. A free S3 gateway endpoint in every VPC with instances.** Amazon Linux 2023's package repositories are on S3, so
  most labs need no NAT gateway.
- **A12. The session password travels in user data.** It is per-session, random and readable only by the account's admins;
  a hashed password would force instance replacement on every plan.
- **A13. Optional output `files`, stored on the run (`lab_runs.files_json`) and cleared at session end.** Lab 31's client
  key must reach Steven's PC; it gets the same handling as the admin password.
- **A14. Per-step STS sessions of 3 hours.** A long apply (EKS, CloudFront, Network Firewall) can outlast the default hour.
- **A15. An AWS server apply or destroy marks AWS-peered labs disconnected.** `rt-wg` keeps its routes inline, so the
  server's Terraform removes the lab route; Re-peer restores it.
- **A16. AWS orphans need 90 minutes.** The tagging API lists deleted items for about an hour.
- **A17. AWS lab costs go in `lab_cost_days` with `rg = "aws:<id>"`.** No migration, and the budget sums them unchanged.
- **A18. Service-linked roles are created on demand and never deleted.** They are shared and free, and deleting one could
  break another lab or the server.
- **A19. The ABAC action lists are generated and pinned, and the bootstrap runs simulator cases.** A hand-written list of
  hundreds of actions would drift; the simulator proves the guards before any lab runs.
- **A20. Cost items may say `whole_hours: true`, and session estimates count them per started hour.** AWS bills those
  hours whole; the per-hour figure on the card is unchanged.
- **A21. Card markers keep `costMarker`'s thresholds;** the curriculum's tiers are the approved planning bands. Changing the
  thresholds would move Azure cards.
- **A22. AWS card numbers read "AWS 5".** Numbers repeat across clouds (A3).
- **A23. vCPU and Instance Connect Endpoint quotas are raised only if below 32 and 10.** Three labs with two VPCs each, plus
  the server, can exceed low defaults; covered by the standing go for quota increases.
- **A24. Batches merge before their release tests.** The role trusts only `main`, as decided.
- **A25. Peering uses `wg-admin-deploy` unchanged.** Its policy already allows peering and routes in eu-west-2, and it owns
  the headend; the lab role is denied anything tagged `wg-admin=vpn`, so it could not accept the peering anyway.
- **A26. Verify clean looks inside lab VPCs for untagged instances and interfaces.** They would otherwise block the VPC
  delete without a name Steven could act on.
- **A27. Lab 09's public zone is a non-delegated `<name_prefix>.labs.clydeford.net`.** A real-looking name Steven owns,
  queried by asking the zone's own name servers, with no change to Cloudflare.
- **A28. Lab 08 and lab 28 faults** are as §12.2: three and two faults, each visible with the tool the lab teaches.
- **A29. IAM policy size.** AWS caps a managed policy at 6,144 characters (whitespace excluded) and a role at 10 attached
  managed policies, so the role's policy is several managed policies and the ABAC create and change lists are compressed:
  `scripts/aws-labs-abac.mjs` folds actions into wildcards (`ec2:CreateVpc*`) only where every action the wildcard matches
  is in the same list, and splits the lists over as many policies as needed. A test asserts each rendered policy stays
  under 6,000 characters and the role under 10 policies. If they still do not fit, the change list falls back to
  per-service `Delete*`/`Modify*`/`Update*`/`Terminate*` wildcards (all accept `aws:ResourceTag` on the services that
  matter), the plan-time tag rule (§7.3) covering the rest.
- **A30. AWS server tear-down with peered labs.** Before the Worker dispatches an AWS server destroy (or a cloud switch away
  from AWS), it unpeers every AWS lab that is peered, using the existing Unpeer run, and marks them "disconnected". The
  server's workflow `wg-aws.yml` is not changed. B1's release test confirms whether AWS would also refuse to delete a VPC
  with an active peering; either way this order makes it moot.

### Rulings from the batch 1 plan (A31 on)

- **A31. `gateway_cidr` travels in the AWS dispatch payload.** The Worker sends its `config.vnetCidr` (default
  `10.50.0.0/16`); Parse payload validates and defaults it; the Azure payload never carries it. A10 needs the value from
  the Worker, which "same payload keys" (§5) could not give.
- **A32. Peer and Unpeer ask STS for 3,600-second sessions.** `wg-admin-deploy` has a one-hour maximum, so A14's three
  hours applies to `wg-admin-labs` steps only.
- **A33. Lab 03 makes no IAM,** so its `identity.creates` is `[]`; §3.2's `[role]` was illustrative.
- **A34. Lab 05 runs MySQL 8.4 with Performance Insights off and no log exports.** 8.0 left standard support on
  2026-07-31 and bills Extended Support; Performance Insights is not offered for MySQL on db.t4g.micro (checked
  2026-10-15); log exports would make untagged log groups. The readme points to CloudWatch Database Insights instead.
- **A35. On diagrams an EC2 Instance Connect Endpoint draws as `bastion`,** and the lab's `aws_resourcegroups_group`
  (one per region) is the container where Azure draws the resource group (§10's region lane).
- **A36. A tagged resource of a type with no handler is never counted clean.** The ready check knows every §5.1 type;
  the scope allow-list, the safety net and Verify clean cover batch 1's types, and Verify clean names any other as
  "no handler for <type>", so a later batch adds the handler test-first.
- **A37. The AWS orphan sweep is its own hourly step** (`sweepAwsOrphans`, KV `labs:sweep-aws`), because one watch run's
  20 calls cannot hold both sweeps; each sweep rewrites only its own cloud's entries in `labs:orphans` and releases only
  its own cloud's `ended_dirty` slots.
- **A38. A peer run without Terraform outputs finds the lab VPC by tag** (`cloudlabs-lab = <id>` and `cloudlabs-peer =
  hub`, else the lab's only VPC), and Peer refuses a VPC that does not carry the lab's tag before any write.
- **A39. API additions:** `LabCard.cloud`; `LabDetail.cloud`, `.secondaryRegion`, `.consoleUrls`, `.connect`;
  `LabPermissions.awsRole/awsBoundary/awsCostTag`; blocker kind `aws_setup`; cost source `aws`; topology status `no_aws`.
- **A40. The scope rule `size` caps RDS storage at 30 GiB with no storage autoscaling.**
- **A41. A30's unpeer runs carry the reason `server tear-down`;** when one settles, the session's peering becomes
  `disconnected`, so Re-peer is offered, not `off`.
- **A42. Labs write IAM documents with `jsonencode()`,** never `data "aws_iam_policy_document"`, so the scope check reads
  literal documents in the plan.
- **A43. The `wg-admin-labs` trust uses `aud` and `sub` only,** as `wg-admin-deploy` does; a `job_workflow_ref`
  condition is not used because STS's support for it is unconfirmed.
- **A44. An AWS lab's capacity warning adds the vCPUs of AWS lab sessions requested after the capacity reading**, plus the
  AWS headend's type when no AWS headend instance exists; earlier sessions are already in "used".
- **A45. Lab instance security groups always admit `var.gateway_cidr`,** so Peer can come after deploy without a new
  apply; it is unreachable until the lab is peered.
- **A46. The ABAC lists:** an action is a create when its condition keys include `aws:RequestTag/${TagKey}` (scoped to the
  resource types it makes, per service: EC2, ElastiCache and Kinesis list request tags per resource type; `RunInstances`
  is checked on instance and volume only, because Terraform never tags the primary network interface); it is a change
  when every resource type it names accepts `aws:ResourceTag/${TagKey}`, none is AWS-owned, and it is not a create.
- **A47. A price item's `instanceType` must be one of `capacity.instance_types` only for `service: AmazonEC2` items,**
  so RDS and other services' instance classes can be priced.

- **A48. Tagging only at create; VPC fabric changes need the lab tag, in the role and the boundary.** The role could
  otherwise put `cloudlabs-lab` on an untagged item that is not a lab's (the VPN server's VPC's default network ACL) and then
  change it, or add rules to that VPC's untagged default security group, and a bounded lab role could do the same directly.
  Both `wg-admin-labs` and `wg-admin-lab-boundary` deny `ec2:CreateTags` outside a create on anything not already tagged
  `cloudlabs-lab`, `ec2:DeleteTags` with no keys, and the VPC fabric actions (§7.2) on network ACLs, route tables, security
  groups and VPCs without the lab tag; the boundary also denies `ec2:*` but describes on the default VPCs, as the role does.
  The VPN server is not changed. Labs never adopt a VPC's defaults: the scope check refuses `aws_default_*` and
  `aws_ec2_tag`. The bootstrap's simulator asks both the role and the boundary (§7.1, ruling A19).

### Rulings from the final review of batch 1 (A49 on)

- **A49. Instances tag their volumes with `volume_tags`, never `root_block_device.tags`** (reverses preflight C18 for lab 04).
  The provider applies `root_block_device.tags` after launch, so `RunInstances` would carry no volume request tag and
  `CreateNeedsLabTagRunInstances` would refuse it. Where a separately attached volume must not cycle tags, the instance
  uses `volume_tags = var.tags` and that volume carries only the provider's `default_tags`, so both set the same tags;
  lab 04's backup selection then names its data volume by ARN. The scope rule and `commonAwsProblems` accept
  `volume_tags` only, and the bootstrap's simulator asks about a launch with an untagged volume.
- **A50. The headend's every name, and no instance target that selects every instance.** The scope check's and the lint's
  name lists are every `Name` in `infra/aws/main.tf` (`vm-wg` among them: an SSM association could otherwise target
  `tag:Name = vm-wg`); a wildcard id, a `tag-key` target or a wildcard tag value in any `{ key, values }` target is refused.
- **A51. SSM's account settings are denied** to the role and the boundary with EC2's: every write on the reference's
  `servicesetting` type (`UpdateServiceSetting`, `ResetServiceSetting`; Default Host Management is one) and
  `RegisterDefaultPatchBaseline`. The reference has no SSM setting write without a resource type. Steven confirms once
  that Default Host Management is off in eu-west-2 (`aws ssm get-service-setting --setting-id
  /ssm/managed-instance/default-ec2-instance-management-role`).
- **A52. A lab role's trust names roles in the lab's own account only:** the plan's caller identity (else the role's
  boundary's) account; any other account or a wildcard is refused, and the message never prints an account id.
- **A53. Verify clean and the safety net handle security group rules, listeners and listener rules:** each is read by its
  own describe (not found is clean); they go with their group or load balancer, and one still there is deleted by its id or
  ARN (rules before listeners before target groups; security group rules after the fabric, never in the headend's VPC).
- **A54. `ec2:CreateNetworkInterface` is exempt from the lab-tag-on-create rule.** EC2 Instance Connect Endpoints (and later services that place interfaces in a lab subnet) create their network interface with the caller's credentials and no tags. The VPN-server and default-VPC denies still keep interfaces out of those networks, and Verify clean names any untagged interface left inside a lab VPC (A26).
