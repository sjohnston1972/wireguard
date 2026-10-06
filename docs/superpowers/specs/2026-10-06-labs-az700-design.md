# wg-admin Labs: the AZ-700 suite (design)

Date: 2026-10-05 (planned for 2026-10-06). Status: scope **pre-approved by Steven 2026-10-05**; the details below are decided
here, and the two scope exceptions (§6) were approved by Steven on 2026-10-05. Builds on `docs/superpowers/specs/2026-10-04-labs-design.md` (the main
spec, binding, with decisions A and B, §16 and §17 rulings 1–37) as integrated on `feat/labs-b3` (52a8fcc). The plan is
`docs/superpowers/plans/2026-10-06-labs-az700-plan.md`. **(V)** marks a fact to check live or on the official page during the
build; the area reports record the answer.

## 1. Intent

AZ-700 (Designing and Implementing Microsoft Azure Networking Solutions) becomes the third exam on the Labs tab, after AZ-104
and AZ-305: **14 new labs** (31–44) and **6 existing labs tagged for AZ-700 as well** (no rebuild), so every AZ-700 skill
area has hands-on labs, and the few things that cannot be built for pennies (ExpressRoute, DDoS Network Protection, BYOIP,
Defender for Cloud) are explained in the nearest lab's readme. The same engine, the same safety model, the same £0 promise.

Non-goals (unchanged from main spec §1): no guided learning, checks or quizzes. No App Service, no preview SKU, no change to
the gateway, `wg.yml`, D1 schema or Worker routes beyond what §4 lists.

## 2. The outline (Microsoft Learn study guide, "Skills measured as of July 27, 2026", read 2026-10-05)

| Key | Skill area (Learn's exact name) | Weight |
|---|---|---|
| `az700.core` | Design and implement core networking infrastructure | 25–30% |
| `az700.connectivity` | Design, implement, and manage connectivity services | 20–25% |
| `az700.delivery` | Design and implement application delivery services | 15–20% |
| `az700.private` | Design and implement private access to Azure services | 10–15% |
| `az700.security` | Design and implement Azure network security services | 15–20% |

## 3. Decisions

### 3.1 Multi-exam labs (ruling 39)

A lab may belong to more than one exam **without changing its id**:
- `lab.yaml` `exam` stays the **primary** exam and must still match the id prefix (`az104-` → AZ-104, `az305-` → AZ-305,
  `az700-` → AZ-700). Ids, resource groups, Entra names, state keys and history never change.
- `skill_areas` may name areas of **any** exam, as long as at least one belongs to the primary exam. No new key.
- `labs-build` computes `exams` (like `number`): the primary first, then every other exam whose area the lab lists, in the
  order AZ-104, AZ-305, AZ-700. `LabDef.exams` and `LabCard.exams` carry it.
- **Coverage** (`GET /labs/coverage`): one entry per exam in `LAB_EXAMS` (`["AZ-104", "AZ-305", "AZ-700"]`, shared), each
  area listing the labs that name it, so a tagged lab counts in each exam it belongs to (the route already works per area;
  only its hard-coded exam list changes).
- **Catalogue:** with no exam filter, cards are grouped by **primary** exam (each lab once) and a card in more than one
  exam shows a small chip, "Also AZ-700". With an exam filter, one group: every lab whose `exams` holds that exam, by number
  (so AZ-700 shows 13–17, 27 and 31–44). The modal's subtitle lists all of a lab's exams. Page subtitles say "AZ-104, AZ-305
  and AZ-700".

### 3.2 Numbering and the AZ-305 batch 4 shrink (rulings 40, 41)

Lab numbers are unique across exams (`labs-check`). AZ-305 batch 4 was never built, so its numbers are free to change:
- **AZ-305 batch 4 is three labs, renumbered 28–30:** `az305-28-three-tier` (was 31, redesigned, §3.3), `az305-29-aks`
  (was 32), `az305-30-messaging` (was 33). Their designs otherwise stand (§12.2 of the main spec).
- **Old 28, 29, 30 and 34 retire as AZ-305 ids** (never built, no history, no state) and become AZ-700 labs 38, 36, 43 and 35,
  each tagged `az305.infra` too (43 also `az305.data`).
- **AZ-700 is 31–44**, in outline order. The catalogue numbers run 1–44 with no gap except the parked lab 10.

### 3.3 Lab 28 three-tier without App Service or uksouth vCore (ruling 41)

App Service quota is 0 (P0v3, S1) and SQL vCore is 0 in uksouth. `az305-28-three-tier` becomes:
**Front Door Standard + WAF policy (custom rules; managed rule sets need Premium, readme) → web tier: a Container App with
external ingress → app tier: a Container App with internal ingress → data tier: Azure SQL Database Basic (DTU) with public
access off and a private endpoint**, all in one Container Apps **workload-profiles environment in a lab subnet** (consumption
profile) whose infrastructure group is `rg-lab-<id>-infra` (ruling 7 allows exactly this). Images from MCR (a hello page;
`mssql-tools` idle for `az containerapp exec` and `sqlcmd` over the private endpoint). Planning marker ££ (Front Door base
fee £0.036/h, WAF policy £0.005/h, SQL Basic £0.006/h, private endpoint £0.008/h, Container Apps consumption near £0 idle).
Built in the AZ-305 batch 4 plan, not here. (If Steven later raises App Service quota, a subscription setting, lab 10 and a
variant of 28 can come back.)

### 3.4 Reused labs, tagged (ruling 42)

| Lab | Adds | AZ-700 skills it covers |
|---|---|---|
| az104-13-vnets | `az700.core`, `az700.security` | VNets and subnets; NSGs, ASGs, effective rules |
| az104-14-peering-udr | `az700.core` | peering, UDRs, route tables |
| az104-15-dns | `az700.core` | public and private zones, VNet links |
| az104-16-lb-appgw | `az700.delivery` | Standard LB rules and probes; App Gateway v2 listeners, rules, settings |
| az104-17-netwatcher-fix | `az700.core`, `az700.security` | Network Watcher next hop, connection troubleshoot, IP flow verify |
| az305-27-multi-region | `az700.delivery` | Traffic Manager; Front Door Standard routing and origins |

Each gets a version bump (`skill_areas` and the readme change), one readme paragraph naming the AZ-700 skills it covers and a
"see also" to the AZ-700 lab that goes deeper, and a release test of the new version (pennies; §8).

### 3.5 Readme-only concepts (ruling 43)

An optional `## Not built here` heading (after Things to try, before Learn more) explains a skill that has no lab, with Learn
links. Placement:
- **ExpressRoute** (models, SKUs, peering types, Global Reach, FastPath, Direct, BFD, encryption) and **Azure Extended
  Network**: lab 36 (S2S VPN); lab 39 mentions ExpressRoute in a hub.
- **BYOIP custom IP prefixes**: lab 31 (public IP prefixes).
- **DDoS Network Protection and DDoS IP Protection**, **Defender for Cloud** network recommendations (Secure Score, attack
  path analysis, Cloud Security Explorer), **Azure Monitor for Networks**: lab 44 (monitoring and security).
- **RADIUS, Always On VPN, Azure Network Adapter**: lab 37 (P2S).
- **Third-party NVA in a vWAN hub**, **vWAN ExpressRoute/P2S gateways**: lab 39.

A new scope rule, `never`, refuses the types that would cost hundreds a month or need a contract or a registered range:
`azurerm_network_ddos_protection_plan` (Network Protection Plan £3.04/h, ~£2,220 a month), any `ddos_protection_mode =
"Enabled"` or `ddos_protection_plan_id` (IP Protection £0.21/h per IP), `azurerm_express_route_circuit*`,
`azurerm_express_route_port*`, `azurerm_express_route_gateway`, `azurerm_custom_ip_prefix`.

### 3.6 SKUs and subscription facts designed around

Facts (read-only checks, Steven, 2026-10-05): App Service quota 0; SQL vCore 0 in uksouth; `standardBSFamily` 10 vCPUs and
total 10 per region in uksouth and ukwest, DSv5 0; Standard public IPv4 20 per region, Basic public IPs 0 (retired); NAT
gateways 100; App Gateway Basic preview not registered; one Network Watcher per region in `NetworkWatcherRG`.

- **VMs:** `Standard_B1s` Ubuntu 24.04, S4 OS disk, no public IP (ruling 5), cloud-init only (no provisioners). A subnet
  whose VM installs a package (dnsmasq, FRR) or must reach the internet sets `default_outbound_access_enabled = true`
  explicitly (ruling 37); lab 31 sets it **false** on purpose.
- **VPN gateways: `VpnGw1AZ`** (Learn, "About gateway SKUs", 2026-06-11: VpnGw1–5 "are slated for migration and should not
  be used to create new VPN gateways"; Basic has no BGP, no custom IPsec/IKE policy, no OpenVPN, no Entra ID auth). Route-based,
  active-standby, Generation1, with a **Standard, zone-redundant** public IP (zones 1, 2, 3; new gateways must use Standard
  IPs). £0.1585/h each.
- **P2S with Entra ID** uses the **Microsoft-registered Azure VPN Client** audience `c632b3df-fb67-4d84-bdcf-b95ad541b5c8`
  (Learn, 2025-02-13: "you skip the previously required Azure VPN Client app manual registration ... you don't need to
  authorize the app"). **No consent, no app registration: not an identity change.** OpenVPN only. Tenant
  `https://login.microsoftonline.com/<tenant>/`, issuer `https://sts.windows.net/<tenant>/` from
  `data.azurerm_client_config`. The lab also makes one Entra user `lab-<id>-vpnuser` (existing Graph rights, prefix rule) so
  a working sign-in exists whatever Steven's own account type is.
- **Azure Firewall Basic** (£0.2981/h; also in a secured hub, "Basic Secured Virtual Hub Deployment" £0.2981/h) with a
  Basic firewall policy; never Standard or Premium.
- **App Gateway `WAF_v2`**, autoscale 0–2, a public IP it must own but **only a private listener** (ruling 5's pattern);
  TLS from a Key Vault **self-signed certificate** read by the gateway's user-assigned identity through a vault **access
  policy** (no RBAC role: the allowed list has no Certificates Officer, so access policies avoid an identity change).
- **Front Door Premium** (base fee £249.07 a month, £0.3412/h) for Private Link origins and managed WAF rules.
- **Bastion Basic** in lab 44 (the exam asks for the AzureBastionSubnet NSG rules; Developer is free but needs no subnet,
  is readme-only); £0.1434/h.
- **Container Instances, VMs, storage and internal load balancers** stand in for App Service everywhere.
- **Network Watcher:** never created (one per region already exists; a second is refused by Azure). Lab 44's flow log is a
  child of `NetworkWatcher_<region>` in `NetworkWatcherRG`: scope exception S2 (§6).

### 3.7 Long deploys (ruling 45)

VPN gateways take 30–45 minutes (two built in parallel in lab 36), a Virtual WAN hub about 30, a Route Server 15–60 (Learn
FAQ: "might take 30-60 minutes" beside a gateway). Planning figures: lab 36 45/25, lab 37 40/20, lab 39 35/30, lab 34 25/20.
- **Job timeout unchanged:** `2 × (deploy + destroy) + 20`, capped at 150. A test run is deploy + destroy once (about 70–85
  minutes for lab 36), so 150 holds with room for a slow gateway. No cap change.
- **The safety net's delete wait follows the lab:** `LAB_DELETE_WAIT_SECONDS` defaults to `max(1500, 90 × destroy_min)`
  (Parse payload exports it), still bounded by `LAB_JOB_DEADLINE` less 420 s.
- **£££ labs keep short lives:** session 2 h, max 3 h. `costMarker` makes 36, 37 and 39 £££ (deploy ≥ 30, and 39 also ≥
  £0.50/h); 34 becomes £££ if its release test measures a 30-minute deploy.
- The ready check polls up to `deploy_min` **after** apply; Terraform already waited for the gateways.

### 3.8 Special subnets in the slot (ruling 46)

Every address is `cidrsubnet(var.address_space, …)` of the lab's /18; "on-prem" and second-region VNets take a /20 of the
slot (main spec §4). Sizes: `GatewaySubnet` /27; `AzureFirewallSubnet` /26 and `AzureFirewallManagementSubnet` /26 (Basic
needs both); `AzureBastionSubnet` /26; `RouteServerSubnet` /26 (V: /27 accepted, kept /26); DNS Private Resolver inbound and
outbound subnets /28, each delegated to `Microsoft.Network/dnsResolvers`; a Private Link service's subnet with
`private_link_service_network_policies_enabled = false`; a virtual hub `address_prefix` /23 (minimum /24); the P2S client pool
a /24 of the slot outside every VNet. The pool test gains: a lab's VNets, hub prefix and client pool do not overlap each other.

### 3.9 Public by nature (ruling 50, extends ruling 5)

Accepted, as the services need them: VPN gateway, Route Server, firewall, Bastion and App Gateway public IPs; public load
balancer frontends serving one static page on port 80 (lab 40) and an outbound-only frontend (lab 31); Front Door endpoints
(lab 42). Never a public IP on a VM, never an inbound rule from the internet to SSH.

### 3.10 Private endpoint approval (ruling 51)

The pipeline never approves a private endpoint connection (no provider can; `az` would be a provisioner). Lab 42's first
Things-to-try bullet approves Front Door's pending connection on the Private Link service (an exam skill); until then Front
Door answers 502 and the readme says so. Lab 43's consumer endpoint to its own Private Link service is auto-approved
(`auto_approval_subscription_ids` the current subscription id, a GUID, never a path).

## 4. Engine changes (plan area Z0)

| Change | Where |
|---|---|
| AZ-700 exam and id prefix `az700`: `LAB_ID_RE` `^az(104|305|700)-\d{2}-[a-z0-9]+(-[a-z0-9]+)*$` in all nine copies (`shared/labs.ts`, `scripts/lib/labs.mjs`, `infra/ci/lab-scope.mjs`, `lab-parse.sh`, `lab-peer.sh`, `lab-ready.sh`, `lab-safety-net.sh`, `lab-state-reset.sh`, `lab-unblock.sh`) and a test keeping them equal; `LabExam` and `LAB_EXAMS`; `skill-areas.yaml` five areas | shared, scripts, infra/ci |
| Multi-exam (§3.1): computed `exams`, the relaxed area rule, coverage per `LAB_EXAMS`, catalogue grouping and filter, chip, subtitles | `scripts/lib/labs.mjs`, `shared/{labs,api}.ts`, `worker/src/api/labs.ts`, `worker/src/labs/cards.ts`, `web/src/views/labs/*` |
| `never` scope rule (§3.5) | `infra/ci/lab-scope.mjs` |
| Scope exception S1: subscription-scoped AVNM for lab 33 only (§6) | `infra/ci/lab-scope.mjs`, `shared/labs.ts` `AVNM_LABS` |
| Scope exception S2: flow logs in `NetworkWatcherRG` for lab 44 only; safety net, verify and orphan sweep find them (§6) | `lab-scope.mjs`, `lab-safety-net.sh`, `worker/src/labs/orphans.ts`, `FLOW_LOG_LABS` |
| Unblock section 7, network (§5) | `infra/ci/lab-unblock.sh` |
| Delete wait from `destroy_min` (§3.7) | `lab-parse.sh`, `lab-safety-net.sh` |
| Types and schema facts for every new resource type; ready-check no-state list stays evidence-driven (ruling 36) | `scripts/test/fixtures/labs/plans/{computed,schema-facts}.json`, `lab-ready.sh` |
| Prices: no feed change. Shared or non-regional meters are authored (ruling 2); `labs-verify --meters` proves the rest | `lab.yaml` only |

No D1 migration, no new route, no gateway change.

## 5. Teardown (ruling 49)

What stops a group delete in these labs, and the order unblock removes it in (a new section 7, after SQL, every item a
`::warning::` on refusal, never failing the run, each wait bounded and its list failure "unverified"):

1. **Virtual Network Manager:** for each network manager in the lab's groups and each region it deployed to, commit an empty
   configuration ("deploy None", Learn AVNM FAQ) for Connectivity, SecurityAdmin and Routing; poll the deployment status
   until nothing is Deployed or Deploying (`LAB_UNBLOCK_AVNM_WAIT_SECONDS`, default 600). Configurations still deployed block
   their own deletion and leave AVNM-made peerings.
2. **Private Link services:** delete every private endpoint connection on each (Front Door's managed one in lab 42, the
   consumer's in lab 43): a service with connections refuses deletion.
3. **VPN connections** (`Microsoft.Network/connections`), each waited for, before any gateway; then local network gateways
   are free to go.
4. **Virtual WAN, per hub:** routing intent, then hub virtual network connections, then any hub VPN, P2S or ExpressRoute
   gateway a learner added (each a 20–30 minute delete, waited for up to `LAB_UNBLOCK_VWAN_WAIT_SECONDS`, default 1800,
   still inside the job deadline), then the hub's firewall; the hub and the WAN go with the group.
5. **Route Server:** delete every BGP peer connection.
6. **Azure Firewall:** delete firewalls (VNet and hub), then firewall policies child-first (a base policy last).
7. **DNS Private Resolver:** forwarding-ruleset virtual network links, then rulesets, then outbound endpoints.
8. **Load balancers:** global-tier load balancers first (their backends are other groups' frontends), then clear any frontend's
   chain to a Gateway Load Balancer.

Plus, in the **safety net** (S2): flow logs named `lab-<id>-*` on each `NetworkWatcher_<region>` (the lab's region and
secondary region) are deleted after the group deletes, and Verify clean lists any left (`"<name> (flow log)"`, a failed list
"unverified: flow logs"). Nothing else in `NetworkWatcherRG` is ever touched.

## 6. Scope exceptions (both APPROVED by Steven 2026-10-05)

Both widen what lab Terraform may touch beyond `rg-lab-<id>*`. The pipeline service principal already has the rights
(Contributor on the subscription), so neither is an Azure permission change; both are changes to the safety model, named in
code for one lab each, like the governance labs.

**S1. A subscription-scoped Virtual Network Manager (lab 33).** AVNM scopes are a management group or a subscription only
(Learn FAQ); a lab management group holds no subscription and never will (scope rule `association`), so the only working scope
is the subscription. Allowed **only** for `az700-33-vnet-manager` (`AVNM_LABS`), and only when: `scope.subscription_ids` is
exactly `[data.azurerm_subscription.current.id]` and `management_group_ids` is unset; `cross_tenant_scopes` unset; network
group members are **static** and each `target_virtual_network_id` is the lab's own VNet; no dynamic membership (it needs a
subscription-scope Azure Policy, refused anyway); no `azurerm_network_manager_{scope,subscription,management_group}_connection`;
every configuration and deployment references the lab's own network groups. Effect: security admin rules and AVNM peerings
reach only the lab's VNets; `vnet-wg` is never a member. Risk named: a hand-added member (Steven's own action) could be any
VNet in the subscription; the readme warns never to add `vnet-wg`.
If declined: lab 33 is not built; AVNM becomes readme-only in lab 38.

**S2. Flow logs in `NetworkWatcherRG` (lab 44).** A VNet flow log is a child of the region's Network Watcher, which lives in
`NetworkWatcherRG`; one watcher per region per subscription, so a lab cannot make its own. Allowed **only** for
`az700-44-flow-logs-bastion` (`FLOW_LOG_LABS`), only `azurerm_network_watcher_flow_log`, only with `resource_group_name =
"NetworkWatcherRG"`, `network_watcher_name = "NetworkWatcher_${var.region}"`, `name` starting `lab-<id>-`, `target_resource_id`
the lab's VNet, `storage_account_id` the lab's account, and traffic analytics pointing at the lab's workspace. The safety net
and Verify clean find them by name (§5); the hourly orphan sweep lists flow logs too (one more ARM call, V: the resources list
returns `Microsoft.Network/networkWatchers/flowLogs`, else one call per region). Learn: deleting an NSG deletes its flow
log; (V) the same for a deleted VNet, so the safety net is a backstop.
If declined: lab 44 keeps IP flow verify, NSG diagnostics and Bastion; flow logs become readme-only.

No identity change is needed by any AZ-700 lab: role assignments none; one Entra user (lab 37) under the existing Graph
rights; P2S Entra auth needs no consent (§3.6).

## 7. Curriculum

### 7.1 Skill areas (`labs/skill-areas.yaml` gains)

`az700.core` Design and implement core networking infrastructure · `az700.connectivity` Design, implement, and manage
connectivity services · `az700.delivery` Design and implement application delivery services · `az700.private` Design and
implement private access to Azure services · `az700.security` Design and implement Azure network security services.

### 7.2 The AZ-700 labs (same columns as main spec §12.2)

Cost markers from `costMarker` on the planning £/h (ruling 13): £ under £0.05/h, ££ under £0.50/h, £££ from £0.50/h or a
30-minute deploy. Peer: off / opt / req. Session and max are hours. Times and prices are planning figures (Retail Prices API,
GBP, uksouth, 2026-10-05); release tests replace the times. Areas: core, conn(ectivity), deliv(ery), priv(ate), sec(urity),
plus other exams' keys.

| # | Id | Title | Areas | Lvl | Type | £ | Peer | Deploy | Sess/max | Identity |
|---|---|---|---|---|---|---|---|---|---|---|
| 31 | az700-31-ip-nat-outbound | Public IP prefixes, NAT Gateway and outbound rules | core | A | explore | ££ (0.092) | opt | 6 | 2/4 | none |
| 32 | az700-32-dns-resolver | Hybrid DNS with DNS Private Resolver | core | A | explore | ££ (0.396) | opt | 10 | 2/4 | none |
| 33 | az700-33-vnet-manager | Virtual Network Manager: hub-and-spoke and security admin rules | core, sec | A | explore | ££ (0.067) | opt | 10 | 2/4 | none · S1 |
| 34 | az700-34-route-server | Route Server with a BGP router VM | core | E | explore | ££ (0.365; £££ if deploy ≥ 30) | opt | 25 | 2/3 | none |
| 35 | az700-35-forced-tunnel-fix | Break-fix: hub-spoke routing fault (forced tunnelling) | core, az305.infra | A | break-fix | £ (0.021) | opt | 6 | 2/4 | none |
| 36 | az700-36-s2s-vpn | Site-to-site VPN between two VNets, one as on-prem | conn, az305.infra | A | explore | £££ (0.346, 45 min) | opt | 45 | 2/3 | none |
| 37 | az700-37-p2s-vpn | Point-to-site VPN with Entra ID sign-in | conn | A | explore | £££ (0.173, 40 min) | opt | 40 | 2/3 | user |
| 38 | az700-38-hub-firewall | Hub-spoke with Azure Firewall and Firewall Manager policy | sec, core, az305.infra | A | explore | ££ (0.333) | opt | 15 | 2/3 | none |
| 39 | az700-39-vwan-secured-hub | Virtual WAN with a secured hub | conn, sec | E | explore | £££ (0.518) | off | 35 | 2/3 | none |
| 40 | az700-40-lb-advanced | Load Balancer: cross-region, Gateway LB, inbound NAT, outbound rules | deliv | E | explore | ££ (0.125) | opt | 10 | 2/4 | none |
| 41 | az700-41-appgw-waf | Application Gateway WAF_v2: TLS, rewrites, WAF policy | deliv, sec | A | explore | ££ (0.377) | opt | 12 | 2/3 | none |
| 42 | az700-42-frontdoor-private | Front Door Premium: rules, caching, WAF, Private Link origin | deliv, sec, priv | E | explore | ££ (0.371) | off | 15 | 2/3 | none |
| 43 | az700-43-private-link | Private Link service, private endpoints, service endpoint policies | priv, az305.infra, az305.data | A | explore | ££ (0.056) | opt | 8 | 2/4 | none |
| 44 | az700-44-flow-logs-bastion | VNet flow logs, IP flow verify and Bastion | sec, core | A | explore | ££ (0.183) | opt | 12 | 2/4 | none · S2 |

Plus the six tagged labs of §3.4 (13–17, 27). Per-lab builds, prices and things to try: the plan's "The fourteen labs".

## 8. Cost, budget and release tests

**Steven's monthly budget is £10** (Settings), shared with the gateway. A 2-hour session of a £££ lab, billed from deploy to
the end of destroy, costs about: lab 39 £1.60 (3.1 h × £0.518), lab 36 £1.10 (3.2 h × £0.346), lab 34 £1.00, lab 37 £0.55.
So **£10 covers about six to nine £££ sessions with nothing else spent that month**; the ££ labs cost £0.10–£1.00 a session.
**Recommendation: set the budget to £30 for the AZ-700 study month** (main spec §15 item 1 already suggests £30): two
sessions of each £££ lab (about £8.50), one or two of each ££ lab (about £8), the gateway, and headroom; back to £10 after.
The budget guard still tears down every lab at 100% (decision B).

**Release tests:** Steven approved **up to £15** for this suite, including one retry for the cheap labs, the dashboard pass
after deploy (which marks versions released) and the soaks; merge and deploy without stopping. The plan's Integration step
7 gives per-lab likely and worst figures: about **£2.61 likely and £4.86 worst per full pass** of all 20 labs (worst: every billed hour rounded up), so two passes, one retry of each cheap lab, one
£££ retry and the soaks come to about £13.16 worst and £6.70 likely, under £15. A projected overrun is a STOP. Release tests through `lab-release-test.mjs` bypass the
dashboard's guard but land in the month's actual spend; the plan checks the month-to-date figure first, and if the dashboard
pass would cross £10 it is a STOP for Steven to raise the budget (a setting change).

## 9. Rulings to add to the main spec §17 (38 on)

Already copied into the main spec's §17 by this commit, under "Rulings from the AZ-700 suite (38 on)".

38. **AZ-700 is the third exam.** Ids `az700-NN-slug`; `LAB_ID_RE` is `^az(104|305|700)-\d{2}-[a-z0-9]+(-[a-z0-9]+)*$` in every
    copy (a test keeps the nine equal); `LabExam` adds `"AZ-700"`, `LAB_EXAMS = ["AZ-104", "AZ-305", "AZ-700"]`; skill areas
    `az700.core`, `az700.connectivity`, `az700.delivery`, `az700.private`, `az700.security` with Learn's names (outline of July
    27, 2026).
39. **A lab may belong to several exams** (§3.1): `exam` is the primary and matches the id; `skill_areas` may name any
    exam's areas, at least one the primary's; `exams` is computed (primary first, then AZ-104, AZ-305, AZ-700 order); coverage
    counts the lab in each; the catalogue groups by primary with an "Also …" chip and an exam filter matches any of `exams`.
40. **Numbering:** AZ-305 batch 4 is `az305-28-three-tier`, `az305-29-aks`, `az305-30-messaging`. The unbuilt AZ-305 ids 28
    (hub-spoke-fw), 29 (s2s-vpn), 30 (private-link) and 34 (forced-tunnel-fix) retire; their labs are AZ-700 38, 36, 43 and 35,
    tagged `az305.infra` (43 also `az305.data`). AZ-700 is 31–44.
41. **Lab 28 three-tier** is Front Door Standard + WAF custom rules → Container Apps web (external) and app (internal) in a
    workload-profiles environment in a lab subnet, infrastructure group `rg-lab-<id>-infra` → SQL Basic (DTU) with a private
    endpoint and public access off. No App Service, no vCore in uksouth.
42. **Tagged labs** (13, 14, 15, 16, 17, 27) get the AZ-700 areas of §3.4, a readme paragraph naming the AZ-700 skills, a
    version bump and a release test of that version. No rebuild.
43. **Readme-only concepts** go under an optional `## Not built here` heading in the nearest lab (§3.5). A new scope rule,
    `never`, refuses DDoS protection plans and DDoS IP protection on a public IP, ExpressRoute circuits, ports and gateways,
    and custom IP prefixes. As built (Z0): `never` comes right after `immutability` in `RULES`; it refuses
    `azurerm_network_ddos_protection_plan`, `azurerm_custom_ip_prefix`, every `azurerm_*express_route*` type, a public IP with
    `ddos_protection_mode = "Enabled"` or a `ddos_protection_plan_id`, a VNet with a `ddos_protection_plan` block and a
    `azurerm_virtual_network_gateway` of `type = "ExpressRoute"`.
44. **VPN gateways are `VpnGw1AZ`**, route-based, active-standby, with Standard zone-redundant public IPs; never Basic or
    non-AZ VpnGw1–5. P2S uses OpenVPN and Entra ID with the Microsoft-registered audience
    `c632b3df-fb67-4d84-bdcf-b95ad541b5c8` (no consent; not an identity change); the client pool is a /24 of the slot.
45. **Long deploys:** the timeout formula and its 150 cap stay; `LAB_DELETE_WAIT_SECONDS` defaults to `max(1500, 90 ×
    destroy_min)` within the job deadline; £££ labs are session 2 h, max 3 h. As built: Parse payload exports
    `LAB_DELETE_WAIT_SECONDS` (and `LAB_REGION`, `LAB_SECONDARY_REGION`); the safety net computes the same default from
    `LAB_DESTROY_MIN` when it is run without it.
46. **Special subnets** are sized as §3.8, all from the slot; a lab's VNets, hub prefix and P2S pool never overlap.
47. **Scope exception S1** (§6): a subscription-scoped Virtual Network Manager, for `az700-33-vnet-manager` only
    (`AVNM_LABS`), static lab members only. *Approved by Steven 2026-10-05.* As built: in lab 33 only the eight AVNM types it
    needs (manager, network group, static member, connectivity and security admin configurations, admin rule collection
    and rule, deployment); the manager's scope is exactly the current subscription (from `data.azurerm_subscription` with no
    `subscription_id`, or `data.azurerm_client_config`), no management group or cross-tenant scope, `scope_accesses`
    Connectivity and SecurityAdmin only; a network group of VNets (`member_type` unset or `VirtualNetwork`) filled by static
    members whose `target_virtual_network_id` is `azurerm_virtual_network.<name>.id` (a reference, never a literal); every
    configuration, rule collection and deployment points only at the lab's own manager, groups, configurations and VNets by
    reference; no policy assignment in lab 33 and no `addToNetworkGroup` policy in any lab (dynamic membership); any
    `azurerm_network_manager*` in another lab is refused (`outside-scope`, messages start `S1:`).
48. **Scope exception S2** (§6): `azurerm_network_watcher_flow_log` in `NetworkWatcherRG` on `NetworkWatcher_<region>`, named
    `lab-<id>-*`, for `az700-44-flow-logs-bastion` only (`FLOW_LOG_LABS`); the safety net, Verify clean and the orphan sweep
    find them by name. *Approved by Steven 2026-10-05.* As built: in lab 44 only, `resource_group_name = "NetworkWatcherRG"`
    (any case), `network_watcher_name = "NetworkWatcher_${var.region}"` (the plan's value must equal the session's region's),
    `name` starting `lab-<id>-`, `target_resource_id` the lab's own VNet and `storage_account_id` its own account (by
    reference), no `network_security_group_id`, traffic analytics only to the lab's own workspace; every other resource in
    `NetworkWatcherRG` (a watcher of its own included) stays refused, and a flow log in any other lab is refused (`S2:`). The
    content suite lets only that resource of that lab name `NetworkWatcherRG`. The orphan sweep's eighth listing is
    `GET /subscriptions/<s>/resources` filtered to `Microsoft.Network/networkWatchers/flowLogs` (V at lab 44's release test).
49. **Unblock knows networks** (§5): AVNM deploy-None, Private Link service connections, VPN connections, Virtual WAN hub
    children, Route Server peers, firewalls before policies, resolver links and rulesets, global and gateway load balancer
    links, in that order, never failing the run. As built: `lab-unblock.sh` section 7, sub-steps 7a-7h; the types whose CLI is
    an extension (AVNM, Virtual WAN, Azure Firewall, DNS Private Resolver) go through `az rest` (api-version 2024-05-01, the
    resolver 2022-07-01), so nothing is installed on the runner; every `az rest` delete is read back until Azure answers not
    found, bounded by `LAB_UNBLOCK_NET_WAIT_SECONDS` (default 600; hub gateways `LAB_UNBLOCK_VWAN_WAIT_SECONDS`, 1800); AVNM
    commits an empty configuration per type and region that has one deployed, then waits until nothing is deployed or
    deploying (`LAB_UNBLOCK_AVNM_WAIT_SECONDS`, 600; a status it cannot read is "unverified").
50. **Public by nature, extended** (§3.9): gateway, Route Server, firewall, Bastion and App Gateway public IPs; public load
    balancer frontends serving a static page; Front Door endpoints. Never a VM public IP. As built: the content suite's test 5
    lets an `azurerm_public_ip` belong (by `azurerm_public_ip.<name>.id`) to an Application Gateway, a VPN gateway, a Route
    Server, a firewall, Bastion, a load balancer or a NAT gateway association, never a NIC; test 6 checks every VNet, virtual
    hub prefix and P2S client pool in the plan fixture is inside the slot and none overlap (ruling 46).
51. **No pipeline approval of private endpoint connections.** Lab 42's readme starts by approving Front Door's connection;
    lab 43's consumer endpoint is auto-approved by subscription id.
52. **App Gateway TLS comes from a Key Vault self-signed certificate** read through vault access policies (the pipeline's
    own, to create it, and the gateway identity's `Get` on secrets); the vault follows ruling 30 (no purge protection, purged on
    destroy).
53. **Budget:** £10 covers about six to nine 2-hour £££ sessions with nothing else spent; Steven is advised to set £30 for
    the AZ-700 study month. The guard is unchanged.
54. **Authored prices (ruling 2) for AZ-700:** shared meters `S2S Connection`, `P2S Connection`, `Basic Gateway` (VPN,
    Bastion and Route Server share it), `Standard Fixed Cost` and `Standard Capacity Units` (App Gateway v2 and WAF v2 share
    them); non-regional rows (NAT Gateway, Load Balancer, AVNM, Route Server, DNS Private Resolver, Front Door, Private
    Endpoint: regions Global, "", or "Zone N"); tiered rows (VNet flow logs collected, first 5 GB free). `retail` candidates,
    each proven by `labs-verify --meters` (V): `VpnGw1AZ`, `Basic Deployment`, `Basic Secured Virtual Hub Deployment`,
    `Standard Hub Unit`, `Standard IPv4 Static Public IP`, `Standard Static IP Addresses`, `Global IPv4 Static Public IP`,
    `{ sku: Standard_B1s }`, `S4 LRS Disk`.
55. **Bastion is Basic** in lab 44, with the documented AzureBastionSubnet NSG; Developer (free, no subnet, one VM, no
    peering) is a readme comparison.
56–61. **The integrator's rulings** (2026-10-06): `subnets_used` counts every /20 taken (34: 3, 37: 2, 39: 3) and lab 37's
    client pool is derived from the slot; service subnets set default outbound access on; lab 36's `try()` on the far BGP
    address; lab 40's NSGs allow port 80 only; lab 43 peers `vnet-consumer`; lab 41's certificate goes with the vault purge.
    Full text in the main spec's §17.

## 10. Risks

| Item | Status |
|---|---|
| S1 and S2 | Safety-model exceptions, each one lab, approved by Steven 2026-10-05 (§6); built as narrow as the scope check can make them. |
| Two VPN gateways in one lab | 45-minute deploy measured by the release test; a gateway slower than 150 minutes total fails the job, the destroy still runs, and the next sweep cleans. |
| Front Door base fee | Learn bills each hour or part hour a profile exists (lab 27's finding); a daily minimum would make lab 42's worst case £8.20 a day (V, Review Focus). |
| VPN gateway billing | Billed by the hour; a 45-minute deploy and 25-minute destroy bill two hours. |
| AVNM-made peerings | Removed only by deploy-None; unblock step 1. |
| Gateway Load Balancer NVA | A Linux VXLAN pass-through from cloud-init (V: the commands); if traffic does not flow, the chain still deploys and the readme says how to fix. |
| Private DNS zone names | Lab 43's `privatelink.blob.core.windows.net` clashes with lab 6 on `vnet-wg`; the Worker's existing rule (one lab links a zone name at a time) answers it. |
| Budget | Release tests add about £3–6 to October's actual; the dashboard pass may need a higher budget (STOP). |
