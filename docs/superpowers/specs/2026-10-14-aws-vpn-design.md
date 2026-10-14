# wg-admin on AWS (project 1: the VPN server): design

Date: 2026-10-14. Status: Steven approved Section 1 (what you get) and Section 2 (how it is built) in conversation, plus the
autonomy ruling in §11. This written spec awaits his review. Plan: to follow in `docs/superpowers/plans/`.

## 1. Intent

wg-admin can build its WireGuard headend in **AWS as well as Azure**. Steven picks the cloud each time he deploys. There is
still **one** headend at a time, one dashboard, one `wg.clydeford.net`, one server key and one set of clients: a phone does not
know or care which cloud answered.

Every lifecycle feature Azure has today works the same on AWS: deploy, self-test, ready alert, heartbeat, live log, hibernate
and resume (warm standby), the forgotten-standby limit, auto-destroy timer, idle limit, cost guard, phone alert buttons, firewall
rules, published ports, SSH-from-home, the workload subnet and the optional test VM.

This is project 1 of 3. Project 2 is AWS insights (CloudWatch, CloudTrail, Pricing, Service Quotas, boot log). Project 3 is an
AWS labs curriculum. Each gets its own spec.

## 2. Decisions (Steven may change these)

1. **One headend at a time.** Switching clouds needs nothing deployed. A hibernated (standby) headend counts as deployed. The
   deploy dialog explains why the other cloud is unavailable rather than silently greying it out.
2. **Region `eu-west-2` (London).** The admin keys' default region (`us-east-1`) is irrelevant to the headend.
3. **Instance `t4g.micro` (ARM), Ubuntu 24.04.** The agent is plain shell, so it is architecture neutral. If anything on the
   boot path turns out x86-only, fall back to `t3.micro`; that is a variable change, not a redesign.
4. **The AWS network reuses the Azure address plan.** The VPC is `AZURE_VNET_CIDR` (10.50.0.0/16) and the workload subnet is
   `WORKLOAD_SUBNET` (10.50.2.0/24). Clients' `AllowedIPs` therefore stay valid on either cloud, and no client needs a new
   config. The client option "+ Azure VNet" is relabelled **"+ Cloud network"**; the stored field stays `azure_vnet`.
5. **One monthly budget (£10) across both clouds.** The cost guard counts both. The Cost page splits the spend by cloud.
6. **Live cost is estimated; the real figure is fetched once a day.** AWS Cost Explorer charges $0.01 per request, so the
   watchman uses hours × rate (as the cost guard already does) and the real month-to-date figure is refreshed once a day
   (about 30p a month).
7. **Demo mode stays Azure-only** in this project. The picker is hidden in demo mode.
8. **Labs stay Azure-only.** Lab peering with the headend's network is an Azure feature. While an AWS headend is live, a lab
   deploy that wants the headend says "connect needs an Azure headend" and runs unconnected.
9. **The Azure insights panels show "AWS insights coming soon"** while an AWS headend is live. They keep their stored Azure
   history and do not poll Azure.

## 3. The cloud seam (Worker)

The Worker talks to Azure in six places today (`worker/src/azure.ts`, used by `runs.ts`, `standby.ts`, `monitor.ts`,
`published.ts` and `api/lifecycle.ts`). These become one interface with two adapters:

| Operation | Azure adapter (today's code, moved) | AWS adapter (new) |
|---|---|---|
| `view()`: power state, public IP | VM instance view | EC2 `DescribeInstances` |
| `inventory()`: what exists | resource group listing | Resource Groups Tagging API, tag `wg-admin=vpn` |
| `power("hibernate" \| "resume")` | ARM deallocate / start | EC2 `StopInstances` / `StartInstances` |
| `setSshAllowedCidr(cidr)` | NSG rule | security group ingress rule |
| `setPublishedPorts(rules)` | NSG rules | security group ingress rules |
| `costMonthToDate()` / breakdown | Cost Management | Cost Explorer (`us-east-1` endpoint), cached daily |

- Layout: `worker/src/cloud/index.ts` (interface plus `cloudFor(env, deployment)`), `cloud/azure.ts`, `cloud/aws.ts`. Callers
  ask the seam and never import an adapter. `worker/src/azure.ts` keeps only what insights and labs still need (`arm`,
  `armToken`, `costTimeframe`).
- AWS requests are signed with SigV4 via `aws4fetch` (small, Workers-native, no Node APIs).
- The deployment record gains a `cloud` column (`'azure' | 'aws'`, default `'azure'`). A migration backfills `'azure'`, so live
  data does not change. The seam reads the cloud from the record, never from a global setting, so a hibernated Azure headend
  is still resumed through Azure.
- `PublishedNsgRule` is renamed `EdgeRule`. The same rule list drives either adapter.

## 4. Building the headend (Terraform and the workflow)

- `infra/` stays the Azure root. `infra/aws/` is a new root: a VPC with IPv6, a public subnet, the workload subnet with a route
  for the tunnel subnet via the headend's network interface, an internet gateway, a security group, an Elastic IP, and an EC2
  instance with **source/destination check off** (it routes between tunnel, VPC and internet). There is an optional test
  instance (`t4g.nano`) in the workload subnet. Everything is tagged `wg-admin=vpn`.
- Shared boot content: the cloud-init template and `infra/agent/*` serve both clouds. The cloud-specific parts become template
  variables:
  - admin user: `azureuser` on Azure, `wgadmin` on AWS
  - the platform resolver: `168.63.129.16` on Azure, the VPC resolver on AWS. The Azure private-zone forwards are emitted on
    Azure only.
  - the metadata-service paths for scheduled maintenance (`wg-vitals.sh events`). AWS reports these at
    `meta-data/events/maintenance/scheduled` over IMDSv2.
  - the agent's `keep_out` list
- `wg.yml` gets a `cloud` input. It selects the Terraform root, the login and the safety net.
- **Terraform state:** same R2 bucket, key `wg-admin/aws/terraform.tfstate`.

### 4.1 Snags found in the code, and their fixes

1. **User-data size.** AWS caps user data at 16 KB. Azure allows 64 KB, and today's boot payload is about 27 KB once its
   gzipped parts are base64-encoded. On AWS the user data is a small bootstrap. The agent scripts and the firewall rule set
   travel as a **boot bundle**: the workflow writes it to R2 under the run id, and the VM fetches it from the Worker
   (`GET /api/agent/bundle`) with the per-deploy agent token it already holds for heartbeats. Azure keeps today's embedded
   path unchanged. A size test, mirroring `cloud-init-size.test.ts`, holds the AWS bootstrap under 12 KB.
2. **Credential collision.** The R2 state backend reads `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, the same variables the
   AWS provider would use. On AWS runs, the R2 keys are passed to the backend with `-backend-config` (access and secret key), and
   the AWS provider gets its credentials from the OIDC role through a named profile. The two never share environment variables.
3. **Routing in AWS.** AWS drops forwarded traffic unless the instance's source/destination check is off, and the workload
   subnet needs an explicit route for the tunnel subnet. Both are in the Terraform. The test VM's ping through the tunnel is the
   proof (§9).

## 5. Logins (least privilege)

Created once by Claude from Steven's machine with the local admin keys, using a small Terraform root,
`infra/aws-bootstrap/`. Its state lives in R2 at `wg-admin/aws-bootstrap/terraform.tfstate`. **The admin keys never leave the
machine.**

| Identity | How it signs in | Allowed |
|---|---|---|
| `wg-admin-deploy` (IAM role) | GitHub OIDC. The trust policy accepts only `repo:sjohnston1972/wireguard:ref:refs/heads/main`. No stored keys. | EC2/VPC create, modify and delete in `eu-west-2`. Destructive actions are conditioned on the `wg-admin=vpn` tag. |
| `wg-admin-worker` (IAM user) | Access keys stored as Worker secrets `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | `ec2:Describe*`; start, stop and security-group-rule edits on tagged resources only; `tag:GetResources`; `ce:GetCostAndUsage`. Nothing else. |

- The bootstrap also creates the GitHub OIDC provider in IAM (if absent) and an **AWS Budgets alarm** that emails at £15. That
  alarm is independent of wg-admin.
- Cost Explorer must be enabled on the account. The bootstrap checks it, and enables it if needed.
- New Worker settings: `AWS_REGION` (default `eu-west-2`), `AWS_INSTANCE_TYPE`, `AWS_HOURLY_RATE_GBP`,
  `AWS_STANDBY_RATE_GBP`. The setup checklist lists the AWS secrets as optional. Until they are set, the picker shows AWS as
  "not set up".

## 6. Lifecycle on AWS

| Step | Behaviour |
|---|---|
| Deploy | `wg.yml` with `cloud=aws` runs Terraform apply. cloud-init fetches the boot bundle, brings up WireGuard and runs the self-test. The first heartbeat completes the run. |
| Hibernate | The Worker calls `StopInstances` directly, with no GitHub run (as Azure deallocate does). The disk and Elastic IP are kept. |
| Resume | `StartInstances`. The first heartbeat completes it. |
| Standby limit, timer, idle limit, cost guard | Unchanged logic, through the seam. Rates come from the AWS settings. |
| Tear down | Terraform destroy. **Safety net:** if destroy fails, the workflow deletes anything still tagged `wg-admin=vpn` in `eu-west-2` (instances, EIPs, volumes, security groups, subnets, IGW, VPC, in dependency order) and reports what it removed. That mirrors today's delete-the-resource-group-by-name step. |
| DNS | Unchanged: `wg.clydeford.net` points at the Elastic IP (and the instance's IPv6). |

Estimated rates, to be confirmed against the AWS price list while building and set as the defaults: running about £0.011/h
(instance plus the public IPv4 charge) and standby about £0.005/h (an 8 GB gp3 disk plus the idle Elastic IP).

## 7. Dashboard changes

- **Deploy dialog:** an Azure / AWS choice that remembers the last pick (UI prefs). It shows each cloud's region, size and
  estimated rate.
- **Cloud badge** on Overview, Clients, Firewall and Cost while a headend exists.
- **Settings → Deployment:** one block per cloud.
- **Cost page:** spend split by cloud. AWS figures show "estimated" until the daily real figure arrives.
- **Insights panels:** the "AWS insights coming soon" state (§2.9).
- Wording: user-facing "Azure" copy that really means "the cloud" becomes neutral, for example "+ Cloud network". Azure-only
  features keep saying Azure.

## 8. Error handling

- AWS API failures surface the same way Azure ones do today: the run's live log, a failed-run alert, and the dashboard's
  existing error banner. The AWS adapter maps AWS error codes to the same small set of outcomes the Azure adapter returns
  (not found, unauthorised, throttled, other).
- `view()` failing never blocks auto-destroy or the cost guard. They fall back to the deployment record, as the Azure path does.
- Missing AWS secrets: AWS is unselectable in the picker, and every AWS code path returns "not configured" rather than throwing.

## 9. Testing

- **Unit:** the AWS adapter against recorded AWS responses (fixtures, as `worker/test/fixtures/azure/`), plus the SigV4 request
  shape.
- **Lifecycle:** `worker/test/harness.ts` gains a faked AWS beside the faked Azure. `lifecycle.test.ts` runs its full sequence
  (deploy, secrets, callback, heartbeat, heads-up, expiry, hibernate, resume, standby limit, drift, tear down) **once per cloud**.
- **Size:** the AWS bootstrap stays under 12 KB. The Azure custom-data test is unchanged.
- **Terraform:** `npm run tf-validate` covers `infra/aws/` and `infra/aws-bootstrap/`.
- **Speed:** targeted tests while building, one full gate (`npm test` plus typecheck) at the end. CI covers the rest.

### 9.1 Live proof (real spend, inside the £3 cap)

1. After the seam refactor ships: a real **Azure** deploy, hibernate, resume and tear down on the live site, to prove nothing
   regressed.
2. A real **AWS** cycle: deploy, check the self-test passes, check a client connects and reaches the test VM, hibernate, resume,
   tear down.
3. Afterwards, check the account: nothing tagged `wg-admin=vpn` remains and no unattached EIP or volume exists in
   `eu-west-2`.

## 10. Order of work

1. **Seam refactor (Azure only, no behaviour change).** Add the `cloud` column, `worker/src/cloud/`, and move the Azure code
   behind the seam. All existing tests pass. Merge, deploy, then the live Azure cycle (§9.1.1). This ships on its own.
2. **AWS bootstrap:** logins, OIDC provider, budget alarm, Cost Explorer check.
3. **AWS adapter** plus the faked AWS in the harness and the lifecycle tests for both clouds.
4. **`infra/aws/`, the boot bundle, the template variables, and `wg.yml` with `cloud` input and safety net.**
5. **Dashboard:** picker (hidden behind a flag), badges, settings, cost split, insights placeholder, wording.
6. **Live AWS cycle** (§9.1.2–3), then remove the flag so the picker shows on the live site.

## 11. Approvals

Standing approval (2026-10-14): Claude may create the AWS logins and budget alarm, merge, deploy, and run real test cycles up
to **£3 combined Azure and AWS spend** without stopping, and stops only for something unexpected. This begins once this spec and
the implementation plan are approved. It does not cover projects 2 or 3.

## 12. Out of scope

AWS insights (project 2), AWS labs (project 3), AWS in demo mode, running both clouds at once, moving a live headend between
clouds without a tear down, and regions other than `eu-west-2`.
