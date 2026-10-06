# wg-admin Labs: design

Date: 2026-10-04. Status: Steven approved the design in conversation; this written spec awaits his review. Details left open are
decided here and listed in §15. Grounded in `main` at 13dd06c (`wg.yml`, `infra/`, `worker/src/{runs,github,lock,monitor,budget,
firewall}.ts`, `insights/`, `shared/widgets.ts`); conventions as in the observability and Azure insights specs. **(V)** marks an
Azure fact to verify with a live call or the official page at build time; the batch report records the answer.

## 1. Intent

Labs are **on-demand Azure environments for AZ-104, then AZ-305 study**. Each one is deployed and destroyed by wg-admin the same
way as the WireGuard gateway: the Worker dispatches a GitHub Actions workflow, Terraform builds it with its state in R2, the
dashboard shows a live log, and a timer tears it down. The gateway stays the base connectivity: a lab can peer to it so tunnel
clients reach the lab's private addresses.

Goals: 44 labs (§12) covering the official skill areas of AZ-104, AZ-305 and, since the AZ-700 suite (rulings 38–55),
AZ-700; each says its cost per hour and per session before
deploy, and the month's budget covers labs; a lab always goes back to £0 (timer, maximum lifetime, budget guard, safety-net
delete, orphan sweep); a lab never touches the gateway's resource group, any other group, or Entra objects without its prefix;
several labs can run at once, alongside the gateway, within budget.

Non-goals: this is **not a guided-learning product**. No automated checks, tasks, hints, solutions, "reset task", quizzes or probe
VM. The learning features are only lab history (date, duration, cost), an optional note per session, and a coverage map by exam skill
area. Later possibilities, not in scope: "Ask Claude" inside a lab, exam-style questions.

## 2. How it fits the existing system

```
                         ┌──────────────── Cloudflare ────────────────┐
 Steven ─ Access ─────▶  │ Worker (wg-admin.clydeford.net)            │
                         │  /api/v1/labs/*  lab_sessions, lab_runs    │
                         │  RunLock DO: "singleton" (gateway)         │
                         │              "lab:<id>"  (one per lab)     │
                         │  watchman */5: lab timers, budget, orphans │
                         └──────┬──────────────────────────┬──────────┘
            dispatch wg.yml     │                          │ dispatch lab.yml (lab id, version, run id, slot, peering…)
                                ▼                          ▼
                GitHub Actions: wg.yml          GitHub Actions: lab.yml ── OIDC ─▶ /api/callback/lab-secrets
                Terraform infra/                Terraform labs/<id>/terraform/
                state R2 wg-admin/…             state R2 labs/<id>/terraform.tfstate
                                │                          │
 Azure subscription             ▼                          ▼
   rg-wg-ondemand: vnet-wg 10.50.0.0/16, vm-wg ◀── peering (both sides) ──▶ rg-lab-<id>: lab VNets in slot 10.64.x.0/18
   tunnel 10.13.13.0/24, fd13:13::/64; home LAN 192.168.1.0/24 via home-site     (+ rg-lab-<id>-<suffix> made by Azure)
   Entra: lab-<id>-* users and groups only            governance labs: lab-<id>-* management groups, definitions
```

Lab and gateway runs are independent (workflow, concurrency groups, lock instances, state keys); the one shared object is `vnet-wg`
(peering), guarded in §7.6. Live logs reuse `infra/ci/live-log.mjs`, `live-log.sh` and `/api/callback/log` unchanged. Prices and
capacity reuse the insights feeds (`az_prices`, `az_capacity`, `capacityCheck`), extended in §9.

## 3. Lab definition

### 3.1 Folder

```
labs/
  skill-areas.yaml               the official skill areas of both exams (§12.1), keys used by lab.yaml
  az104-06-blob-security/
    lab.yaml                     read by the dashboard (bundled at Worker build) and by the pipeline
    readme.md                    what it deploys, diagram, things to try, Microsoft Learn links
    terraform/                   main.tf, variables.tf, outputs.tf, versions.tf; optional *.bicep
```

Lab id: `^az(104|305)-\d{2}-[a-z0-9-]+$` (`az700` too, and single hyphens: rulings 9 and 38), at most 40 characters, equal to the folder name, never a prefix of another lab's id.
Resource group: `rg-lab-<id>`. Azure-made groups the lab must name (AKS nodes, backup restore points, DR targets):
`rg-lab-<id>-<suffix>`. Entra users, groups, custom roles, policy definitions, management groups: `lab-<id>-<name>`.

### 3.2 `lab.yaml` (example: lab 6)

```yaml
id: az104-06-blob-security
version: 1                         # bump on any change to lab.yaml, readme.md or terraform/ (CI checks)
title: "Blob security: SAS, access policies, private endpoint"
summary: >-
  A storage account with a private container, a stored access policy and a private endpoint in a small VNet,
  so you can compare SAS, RBAC and network access side by side.
exam: AZ-104                       # AZ-104 | AZ-305
skill_areas: [az104.storage, az104.networking]   # keys from labs/skill-areas.yaml
level: associate                   # foundation | associate | expert
type: explore                      # explore | break-fix
prerequisites: [az104-05-storage]  # shown as a "run before" badge; never blocks Deploy
cost:
  items:                           # hourly estimate per resource; total = sum (gbp_h × qty)
    - { name: "Storage account, LRS hot, a few MB", gbp_h: 0.0001 }
    - { name: "Private endpoint", gbp_h: 0.0076, retail: { meter: "Standard Private Endpoint", unit: "1 Hour" } }
    - { name: "Private DNS zone", gbp_h: 0.0005 }
  pricey: null                     # or the name of the item that makes it pricey (shown on the card)
timing: { deploy_min: 4, destroy_min: 3, session_h: 2, max_h: 6 }
capacity: { vm_sizes: [] }         # each one checked against az_capacity (offered + vCPU quota)
regions: { secondary: null }       # e.g. ukwest for cross-region labs
connectivity: { peering: optional, dns_link: true, subnets_used: 1 }   # peering: off | optional | required
identity:
  creates: [group]                 # any of user, group; [] for none. Names always lab-<id>-...
  roles: [{ role: "Storage Blob Data Reader", scope: resource_group }]  # every role assignment, and where
  governance: false                # true only for the named governance labs (§8.3)
```

`timing`: typical deploy and destroy minutes (from release tests), suggested session (the default auto-destroy timer) and maximum
lifetime (a hard stop nothing overrides, ≤ 12 h). `dns_link` links the lab's private DNS zones to `vnet-wg` while peered (§7.6);
`subnets_used` is how many /20s of its /18 slot it uses (1–4). `retail` is optional: when present, the price feed (§9) refreshes
`gbp_h` from Azure's list price; a VM item takes `retail: { sku: Standard_B1s }` and also feeds `capacity.vm_sizes`.

### 3.3 `readme.md`

Required headings (CI checks): **What it deploys** (a list and a small text diagram), **Things to try** (3–6 bullets), **Learn
more** (Microsoft Learn links). Break-fix labs add **Symptom** and a collapsed `<details><summary>What was broken</summary>`.
Standard footer: "Anything you build by hand inside `rg-lab-<id>` is removed at tear-down. Entra users or groups you create by
hand are removed only if their name starts `lab-<id>-`."

### 3.4 Terraform contract

Variables filled by the pipeline (a lab declares only the ones it uses; CI refuses unknown `TF_VAR`s):
`lab_id`, `name_prefix` (`l` + lab number + 5 random lowercase characters, e.g. `l06k3x9q`, for globally unique names),
`resource_group_name`, `region`, `secondary_region`, `address_space` (the slot, e.g. `10.64.64.0/18`), `peered` (bool),
`gateway_vnet_id` (empty when not peered), `admin_password` (sensitive, per session), `ssh_public_key`, `upn_domain`, `tags`
(`project=wg-admin-labs`, `lab=<id>`, `session=<id>`).

Rules: the lab creates `rg-lab-<id>` itself and everything else inside it; every address comes from
`cidrsubnet(var.address_space, …)`; no provisioners, no `null`, `external`, `http` or `local` providers. Outputs: `private_ips`
(name to address), `peer_vnet_id` when peering is possible, optionally `connect` (short strings: "ssh azureuser@10.64.64.4").
Bicep-subject labs keep `.bicep` files in `terraform/`; the workflow compiles them with `az bicep build` and Terraform deploys the
JSON with `azurerm_resource_group_template_deployment` into the lab's group, so destroy and the scope check still apply.

## 4. Lab address pool

The gateway uses 10.13.13.0/24 (tunnel), 10.13.255.1/32 (loopback), 10.50.0.0/16 (vnet-wg, with 10.50.1.0/24 and the workloads
subnet 10.50.2.0/24), 192.168.1.0/24 (home LAN), fd13:13::/64 and fd50:50::/48 (`wrangler.toml`, `infra/variables.tf`).

**Lab pool: 10.64.0.0/13** (10.64.0.0 – 10.71.255.255), **32 slots of /18**, slot *n* = `10.64.0.0 + n × 16384`
(slot 0 10.64.0.0/18, slot 1 10.64.64.0/18, … slot 31 10.71.192.0/18). A lab holds one slot (`lab_slots`, §7.1) from deploy until
Azure is clean, so two labs never share addresses. Inside it, a lab carves up to four /20s (hub, spokes, "on-prem", second region)
or smaller subnets; the AKS lab puts its service CIDR in the last /20. IPv4 only. The pool overlaps none of the ranges above, nor
172.17.0.0/16 (Docker) or 168.63.129.16; a test proves it.

## 5. Workflow `.github/workflows/lab.yml`

`workflow_dispatch` inputs: `action` (`deploy` | `destroy` | `peer` | `unpeer` | `test`) and `payload` (JSON, nothing secret):
`lab_id`, `version`, `run_id`, `session_id`, `region`, `secondary_region`, `slot_cidr`, `name_prefix`, `peering` (bool),
`timeout_min`, `callback_url`, `secrets_url`. `run-name: "lab ${action} ${lab_id} ${run_id}"` so the Worker finds the run by title.

- **Concurrency:** `group: lab-${lab_id}-${action}`, `cancel-in-progress: false`, plus "Wait for any earlier run of this lab"
  (`lab.yml` runs whose title has the lab id), as `wg.yml` does. Labs never queue behind the gateway or each other.
- **Timeout:** `timeout-minutes: ${{ fromJSON(inputs.payload).timeout_min || 60 }}` (V: an input expression is accepted here;
  if not, a fixed 150). The Worker sets `2 × (deploy_min + destroy_min) + 20`, capped at 150: 30–60 for most labs, 130 for the
  VPN gateway lab (§14). A test run does both halves, hence the 2×.
- **Secrets per step**, as in `wg.yml`: `ARM_*` (the same service principal), R2 keys and `CLOUDFLARE_ACCOUNT_ID`,
  `SSH_PUBLIC_KEY`, and a new `LAB_UPN_DOMAIN`. Never the Cloudflare DNS token or the WireGuard key.

Steps (D deploy, X destroy, P peer, U unpeer, T test = D then X):

| # | Step | Runs on | What it does |
|---|---|---|---|
| 1 | Check out, Parse payload | all | refuses a lab id that fails the regex or has no folder, and a `version` that differs from `lab.yaml` (stale dashboard) |
| 2 | Collect run secrets | all | OIDC (`aud wg-admin`, workflow `lab.yml` on `main`) → `callback_token`, `admin_password`; masked |
| 3 | Start live log | all | unchanged shipper, same redaction |
| 4 | Wait for earlier run of this lab | all | ≤ 10 min; then a destroy goes ahead anyway (teardown first), anything else fails loudly |
| 5 | Terraform init | D X T | `infra/ci/lab-lint.mjs` on the lab's Terraform text first (§8.4); backend key `labs/<id>/terraform.tfstate`; `az bicep build` first if `*.bicep` exist |
| 6 | Plan and scope check | D T | `terraform plan -out`, `terraform show -json`, `node infra/ci/lab-scope.mjs` (§8.4); refuses before anything is built |
| 7 | Apply | D T | `terraform apply plan.out` |
| 8 | Ready check | D T | every resource in `rg-lab-<id>*` exists with `provisioningState = Succeeded`; polls up to `deploy_min` |
| 9 | Peer | D P T | if `peering`: ask the Worker (`/api/callback/lab-peer` begin); on "go", create both peerings (§7.6), then "end" |
| 10 | Unpeer | X U T | delete the `vnet-wg` side, then the lab side if the group still exists |
| 11 | Unblock | X T | remove what stops a group delete: resource locks, legal holds and unlocked immutability policies, backup protection (stop and delete data), Site Recovery replication (`infra/ci/lab-unblock.sh`) |
| 12 | Destroy | X T | `terraform destroy -lock-timeout=5m`; `continue-on-error`, like the gateway |
| 13 | Safety net | X T | delete `rg-lab-<id>*`; Entra users and groups starting `lab-<id>-`; governance labs also custom roles, policy assignments and definitions, and management groups (children first) starting `lab-<id>-` |
| 14 | Verify clean | X T | re-list all of 13; outputs `clean` and `leftovers` |
| 15 | Back up state | all | `labs/<id>/backups/`, newest 5; once verified clean, the state and any stale `.tflock` are removed (`lab-state-reset.sh`) |
| 16 | Finish live log, Report result | all | `{run_id, action, status, outputs: {private_ips, connect, clean, leftovers, deploy_seconds, destroy_seconds}}` |

A failed deploy is destroyed after 15 minutes (§7.4). Safety net and clean check run even when Terraform fails or the state is
missing, so an orphan cleanup (§7.5) is just a destroy run.

## 6. Gateway changes (`wg.yml`, `infra/`)

- **`wg.yml` destroy:** a new first step, "Remove lab peerings", deletes every peering and private DNS link on `vnet-wg`, then
  calls `/api/callback/lab-peerings-removed`. Labs keep running; their sessions show peering "disconnected".
- **Gateway deploy:** on reaching Running, the Overview and the ready push offer "Re-peer 2 labs" for sessions that asked for
  peering; one press dispatches a `peer` run per lab.
- **Tunnel DNS (`cloud-init.yaml.tftpl`):** dnsmasq forwards `core.windows.net`, `database.windows.net`, `azurewebsites.net`,
  `vaultcore.azure.net`, `documents.azure.com`, `servicebus.windows.net` and `internal` to Azure DNS (168.63.129.16), so tunnel-DNS
  clients resolve private endpoints via lab zones linked to `vnet-wg` (Azure DNS answers public names too). Next gateway deploy.
- **No NAT change.** `wg-nat.sh` masquerades everything leaving eth0 except `vnet_cidr`, so peered lab traffic reaches the lab from
  the gateway VM's VNet address. Labs need no routes back to the tunnel. The firewall sees the real client address first, because
  nftables `forward` runs before NAT.

## 7. Worker additions

### 7.1 Data model (migration `0020_labs.sql`)

Tables are `WITHOUT ROWID` where they suit it, times are ISO UTC, and nothing is added to `runs`: its `action` CHECK allows only
`apply` and `destroy`, and SQLite cannot alter a CHECK.

```sql
CREATE TABLE lab_sessions (
  id TEXT PRIMARY KEY, lab_id TEXT NOT NULL, lab_version INTEGER NOT NULL,      -- id "ls-<stamp>-<rand>"
  state TEXT NOT NULL,               -- deploying | running | failed | tearing_down | ended | ended_dirty
  test INTEGER NOT NULL DEFAULT 0, region TEXT NOT NULL, secondary_region TEXT, -- test 1 = release test
  slot INTEGER, cidr TEXT, name_prefix TEXT NOT NULL, peering TEXT NOT NULL,     -- off | waiting | on | disconnected
  requested_at TEXT NOT NULL, ready_at TEXT, ended_at TEXT, auto_destroy_at TEXT, max_until TEXT NOT NULL, warned_at TEXT,
  est_gbp_h REAL NOT NULL, est_gbp REAL,                                         -- estimate per hour; total on end
  end_reason TEXT,                   -- manual | timer | max | budget | failed | orphan | test
  outputs_json TEXT, leftovers_json TEXT, note TEXT
);
CREATE INDEX lab_sessions_lab ON lab_sessions (lab_id, requested_at DESC);
CREATE TABLE lab_runs (
  id TEXT PRIMARY KEY,               -- "lab-<action>-<stamp>-<rand>", also the run_live_log key
  session_id TEXT NOT NULL, lab_id TEXT NOT NULL, action TEXT NOT NULL,  -- deploy|destroy|peer|unpeer|test
  status TEXT NOT NULL, requested_at TEXT NOT NULL, requested_by TEXT, reason TEXT, started_at TEXT, finished_at TEXT,
  github_run_id INTEGER, github_run_url TEXT, callback_token_hash TEXT,
  admin_password TEXT,               -- cleared when the session ends, like runs.ssh_password
  payload_json TEXT, outputs_json TEXT, steps_json TEXT, error TEXT
);
CREATE TABLE lab_slots (slot INTEGER PRIMARY KEY, cidr TEXT NOT NULL, session_id TEXT, since TEXT) WITHOUT ROWID;  -- 32 rows seeded
CREATE TABLE lab_cost_days (day TEXT NOT NULL, rg TEXT NOT NULL, lab_id TEXT NOT NULL, gbp REAL NOT NULL, fetched_at TEXT NOT NULL, PRIMARY KEY (day, rg)) WITHOUT ROWID;
CREATE TABLE lab_release_tests (lab_id TEXT NOT NULL, version INTEGER NOT NULL, at TEXT NOT NULL, run_id TEXT NOT NULL,
  result TEXT NOT NULL, deploy_seconds INTEGER, destroy_seconds INTEGER, est_gbp REAL, leftovers_json TEXT,
  PRIMARY KEY (lab_id, version, at)) WITHOUT ROWID;
```

Slot reservation is one statement: `UPDATE lab_slots SET session_id = ?1, since = ?2 WHERE slot = (SELECT MIN(slot) FROM
lab_slots WHERE session_id IS NULL) AND session_id IS NULL RETURNING slot, cidr`. It is freed when the session ends clean; after
`ended_dirty`, only once the orphan sweep finds Azure clean. `run_live_log` stores lab runs by id; `livelog.ts` also accepts
`lab_runs` tokens. The catalogue is not in D1: `npm run labs-build` (run first by `deploy-worker`) turns every `lab.yaml` and
`readme.md` into `shared/labs.generated.json`, imported by the Worker and the app, so a new lab or version needs a Worker deploy.

### 7.2 API (`worker/src/api/labs.ts`, house style: `{ ok, message }` or `{ error: { code, message, field? } }`)

| Route | Does |
|---|---|
| `GET /labs` | catalogue cards with each lab's estimate (£/h), running session (if any), last session, last release test, slots in use |
| `GET /labs/:id` | readme (markdown), cost items and total with price source and age, warnings (§9.2), session and runs if running |
| `POST /labs/:id/deploy` | `{ hours, peer, region?, overBudgetOk?, capacityOk? }`; 422 `confirm_required` for budget or capacity warnings |
| `POST /labs/:id/extend` | `{ hours }`; refuses beyond `max_until` and says until when it can run |
| `POST /labs/:id/destroy` | `{ confirm: true }`; also cancels a deploy in progress first |
| `POST /labs/:id/peer` · `/unpeer` · `/test` · `/cancel` | a `peer` or `unpeer` run; a release test (§11.2); cancel the active GitHub run, then destroy |
| `PUT /labs/sessions/:sid/note` | `{ note }`, ≤ 2000 characters |
| `GET /labs/sessions?lab=&limit=` | history: date, duration, estimate and actual cost, note, end reason |
| `GET /labs/coverage` | per exam: skill areas, labs available, labs run (sessions of 15 minutes or more) |
| `POST /labs/orphans/cleanup` | `{ lab_id }`: a destroy run for leftovers (§7.5) |

The existing `GET /runs/:id` (Activity run drawer: steps, live log, GitHub log) reads `lab_runs` when the id starts `lab-`.
Outside Access, authenticated by token: `POST /api/callback/lab` (result), `POST /api/callback/lab-secrets` (OIDC; `claimsProblem`
gains an allowed-workflow argument, and only this route accepts `lab.yml`), `POST /api/callback/lab-peer` (begin and end),
`POST /api/callback/lab-peerings-removed` (from `wg.yml`, with the gateway run's callback token). `/api/act` gains one-time links
`lab-extend-1h:<session>` and `lab-destroy:<session>`. Types in `shared/api.ts`: `LabCard`, `LabDetail`, `LabSession`, `LabCoverage`.

### 7.3 Locks

`RunLock` works for any instance name, so a lab lock is `env.RUN_LOCK.idFromName("lab:<id>")`: no new class, no DO migration,
TTL `timeout_min + 15` minutes. One run per lab at a time; the gateway and other labs run alongside. The gateway's `"singleton"`
lock and snapshot are unchanged. Deploy also needs a free slot and fewer than `labs_max_running` (setting, default 3) labs live.

### 7.4 Timers and the watchman (`worker/src/labs/watch.ts`, called from `runScheduled`)

Every 5 minutes, in its own try/catch so a lab problem never delays the gateway's cost guard:
1. Refresh each active lab run from GitHub (missed callback heals), as `refreshActiveRun` does.
2. 15 minutes before `auto_destroy_at` or `max_until`: one push, "Lab 'Storage accounts' ends in 15 min", with **Extend 1h**
   (left out when `max_until` is under an hour away) and **Tear down**.
3. At `auto_destroy_at`: destroy (`timer`). At `max_until`: destroy (`max`); Extend can never move a timer past `max_until`.
4. **Cost guard:** still `running` or `tearing_down` 15 minutes after its deadline → destroy again, plus a watchman note. A
   `failed` session older than 15 minutes → destroy (`failed`).
5. **Budget:** at ≥ 100% (§9.3) every running lab is destroyed (`budget`), deploying ones cancelled first. Never the gateway.
6. Hourly: the orphan sweep (§7.5). Daily: lab costs from Cost Management (§9.4).

### 7.5 Orphan detection

Hourly, the Worker lists (7 calls, plus one GET per fixed custom role GUID in `labs/setup/allowed-roles.json`: the
subscription's list misses a role assignable only inside a group): resource groups starting `rg-lab-`; Entra users by
`userPrincipalName` and groups by `displayName` starting `lab-` (the fields the safety net deletes by); management groups,
custom role definitions and policy definitions/assignments starting `lab-`.
Anything not owned by a `deploying`, `running` or `tearing_down` session and older than 30 minutes becomes one watchman note per
lab ("Lab leftovers: rg-lab-az104-08-vms, lab-az104-01-identity-ann") on the Labs tab and the bell, with **Clean up**: a destroy
run for that lab id, parsed from the name if the lab has left the catalogue. Azure's own `NetworkWatcherRG` is ignored. A clean
sweep releases slots held by `ended_dirty` sessions.

### 7.6 Peering orchestration and the firewall Labs zone

- **Who peers:** step 9 of the lab run asks `/api/callback/lab-peer` (begin). The Worker answers **go** only if the gateway is
  running or in Standby and it can take the gateway's `singleton` lock as `peer:<lab run id>` for 10 minutes; otherwise **wait**,
  and the session's peering becomes `waiting`. That one lock means a peering change never races a gateway apply or destroy on
  `vnet-wg`. The run then creates `vnet-lab → vnet-wg` (allow virtual network access, allow forwarded traffic) and
  `vnet-wg → vnet-lab` (allow virtual network access) with `az network vnet peering create`, links any private DNS zones in
  `rg-lab-<id>` to `vnet-wg` when `dns_link` is set, and calls end, which releases the lock. Multi-VNet labs peer only their
  first VNet, the "hub" (output `peer_vnet_id`).
- **Later:** `waiting` and `disconnected` sessions are offered "Re-peer" when the gateway reaches Running (§6); an `unpeer` run
  removes both sides and the DNS links.
- **Clients:** the per-client "Azure route" switch now also puts 10.64.0.0/13 in AllowedIPs (`clientAllowedIps`). Clients with it
  on are flagged "config out of date: get config" once.
- **Firewall (`firewall.ts`):** a new zone `labs` ("Labs", v4 = the pool, no v6). The pool joins `privateV4`, so "internet" no
  longer matches lab addresses. A new default rule after position 20: "Clients to labs", clients → labs, any, allow. Existing
  installs get it through the draft/apply flow as a proposed rule, never silently. The gateway VM's NSG needs no change: peered
  address space is inside the `VirtualNetwork` service tag.

## 8. Identity, permissions and the risk

### 8.1 What the pipeline service principal gets (Steven's choice: reuse it)

The SP is already **Contributor on the whole subscription** (`.env.example`, `wg-admin-spec.md`). Contributor cannot write
anything under `Microsoft.Authorization` (role assignments, role definitions, policy, locks), and it has no Entra rights. Labs add:

1. **Custom role `wg-admin labs governance`**, assigned at subscription scope (a lab group does not exist until the lab deploys and
   is deleted after, so it cannot be scoped to one in advance). Actions: `Microsoft.Authorization/roleAssignments/write|delete`,
   `roleDefinitions/write|delete`, `policyDefinitions/*`, `policySetDefinitions/*`, `policyAssignments/*`, `policyExemptions/*`,
   `locks/*`; `Microsoft.Management/managementGroups/read|write|delete`. The assignment carries an **ABAC condition** that allows
   role assignments only for an allow-list of role definitions (Reader, Contributor, Storage Blob Data Reader/Contributor, Virtual
   Machine Contributor, Key Vault Secrets User/Officer, Monitoring Reader/Contributor, Network Contributor, Backup Operator, and
   custom roles named `lab-*`) and only to principal types User, Group and ServicePrincipal. It can never assign Owner, User Access
   Administrator or Role Based Access Control Administrator. (V: conditions on a custom role that holds these actions.)
2. **Microsoft Graph application permissions:** `User.ReadWrite.All`, `User.DeleteRestore.All` (V: least privilege for delete),
   and `Group.ReadWrite.All`, with admin consent. Graph offers nothing narrower than tenant-wide for creating users (V); the
   prefix rule is enforced in code (§8.4). Creating management groups needs the hierarchy setting "require write permissions"
   off, or `Management Group Contributor` at the root (V: which applies to Steven's tenant).

### 8.2 One-time setup (README gets these exact steps; Steven runs them as subscription Owner and Entra Global Administrator)

1. Azure portal → Subscriptions → (the subscription) → Access control (IAM) → Add → Add custom role → JSON tab → paste
   `labs/setup/governance-role.json` (the repo fills in the subscription id) → Create.
2. Same IAM page → Add role assignment → `wg-admin labs governance` → Members: the wg-admin service principal (the app name shown in
   Settings → Setup) → Conditions → "Allow user to only assign selected roles" → pick the list in §8.1 → principal types
   User, Group, Service principal → Review + assign.
3. Entra admin centre → App registrations → (the wg-admin app) → API permissions → Add → Microsoft Graph → Application →
   tick `User.ReadWrite.All`, `User.DeleteRestore.All`, `Group.ReadWrite.All` → Add → **Grant admin consent**.
4. Entra admin centre → Identity → Overview → Properties: copy the primary domain (`…onmicrosoft.com`) into `.env` as
   `LAB_UPN_DOMAIN`, then `npm run secrets`.
5. Dashboard → Settings → Labs → **Check permissions**: the Worker reads the role assignment and makes harmless Graph reads
   (`/users?$top=1`, `/groups?$top=1`), ticking each. Until all tick, Deploy is disabled with the reason for labs that need them.

### 8.3 Governance labs

Named in code, not in `lab.yaml` alone: labs 1, 2, 3, 20, 21. Only these may create subscription-level **definitions** (custom
roles, policy definitions, initiatives) and management groups, all named `lab-<id>-*`. Even they **never assign** a policy, lock or
role at subscription scope, and never move the subscription into a management group: assignments go to the lab's group or its own
management groups. A deny policy at subscription scope could otherwise break the next gateway deploy.

### 8.4 Enforcement (two layers)

- **Plan-time scope check (authoritative):** `infra/ci/lab-scope.mjs` reads `terraform show -json` and refuses the plan when any
  managed resource: is an `azurerm_resource_group` not named `rg-lab-<id>` or `rg-lab-<id>-*`; has a `resource_group_name` or `scope`
  outside those groups (governance types excepted as above, only for governance labs); is an `azuread_*` object whose display name,
  UPN or mail nickname does not start `lab-<id>-`; is a role assignment whose role is not on the allow-list; is a subscription or
  management-group association; locks an immutability policy (`state = "Locked"`); or comes from a disallowed provider. The only
  reference to `vnet-wg` allowed is `var.gateway_vnet_id` in a private DNS zone link. The only writes to `rg-wg-ondemand` are
  the pipeline's own peering and DNS-link steps (§7.6), never lab Terraform. Also refused (fix pass, 2026-10-05): any change
  that imports an existing object (`change.importing`; an adopted real user renamed `lab-<id>-x` would be deleted at
  tear-down); a provider whose **full** source address is not `registry.terraform.io/hashicorp/{azurerm,azuread,random,time}`;
  a lab custom role holding a wildcard action other than a wildcard read, or assignable anywhere but the lab's own group(s).
  A management group's `subscription_ids` is refused only when set in the configuration or known and non-empty (left unset,
  it is unknown in every real plan).
- **Before `terraform init` (lab.yml step 5):** `infra/ci/lab-lint.mjs` on the lab's Terraform text, because init downloads the
  providers the files name and plan (destroy too) already runs data sources with the pipeline's keys: the same provider
  allow-list (declared or implied, quoted or bare labels), no provisioners, `module` or `import` blocks, no backend other than
  the template's `s3`, no `cloud` block, no `*.tf.json`, `*.tfvars` or CLI configuration files.
- **CI lint (early warning):** the same rules on HCL (`hcl2json`), on every push, and `lab-lint.mjs` in `npm run labs-check`.

### 8.5 The risk, stated plainly

Steven chose to reuse the existing SP after being told the blast radius. Its secret lives in GitHub secrets and the Worker, used by
a public repository's workflow. With labs it can also **create and delete Entra users and groups tenant-wide**, write policy and
locks, create role definitions, and assign the allow-listed roles anywhere in the subscription. A leaked secret or a malicious
change merged to `main` could create users, give them Contributor, or delete non-admin users (Graph refuses it admin accounts, V).
The prefix and scope rules are code, not Azure boundaries. Mitigations: workflows reach Azure only from `main`; the scope check runs
before any apply; the ABAC condition blocks the dangerous roles; the orphan sweep catches strays. A dedicated lab SP is better (§15).

## 9. Cost estimation and budget

### 9.1 Estimate and prices (`insights/feeds/prices.ts`)

£/hour = Σ `gbp_h × qty`; per session = £/hour × chosen hours, shown on the card (per hour) and in the modal (both). A monthly fee
is converted at 730 hours (`HOURS_PER_MONTH`). Release tests record the real deploy time for the next lab version. The prices
feed gains the lab items: every `retail.sku` (VM sizes, merged into `sizesOfInterest`) and every `retail.meter`, stored in
`az_prices` as `item = 'lab:<meter>'`, for the configured region and each lab `secondary_region`, at most 3 pages a day as now.
With no price under 7 days old, the authored `gbp_h` is used and the modal says so. GBP list prices before discounts and VAT.

### 9.2 Warnings in the deploy modal (each allows "Deploy anyway", except the last)

- **Budget:** "This session would take the month to £X of £Y" when month total + session estimate > budget.
- **Capacity/quota:** `capacityCheck` per `capacity.vm_sizes` entry (vCPUs summed, plus the gateway's) says "may not be
  available", reading uncached regions on demand (`insights/ondemand.ts`). Other quotas (public IPs, VPN gateways) are not checked.
- **Pricey:** "Pricey: Azure Firewall, about £0.40/h". **Slow** (`deploy_min ≥ 15`): "Takes about 35 minutes to deploy and 20 to tear down".
- **Not available:** a lab whose permissions (§8.2) or slot pool or `labs_max_running` limit is not met. No override.

### 9.3 Budget guard

`budgetFigures` gains labs: `session` adds each running lab's `est_gbp_h × hours` to its timer; a lab still deploying (no timer
yet) counts for the hours chosen at deploy, and only to `max_until` when those are not known. `actual` comes from
Cost Management for the gateway's group **and** all `rg-lab-*` groups (the query filters on the gateway group today). The 80% push
is unchanged and now names lab spend; at 100%, labs are torn down (§7.4 step 5), the gateway is not, and Deploy (gateway or lab)
needs the existing "Deploy anyway". For a lab, "Deploy anyway" only skips the warning before the deploy: it never exempts the
lab from this guard (Steven's decision B, §14).

### 9.4 Per-lab spend

Daily, one Cost Management query grouped by `ResourceGroupName`, unfiltered, keeps rows starting `rg-lab-` in `lab_cost_days`.
Actuals arrive 8–24 hours late (V), so a session shows "estimate" until the day after it ends, then "actual" (a day's actual
for that lab, split over that day's sessions by duration).

## 10. Dashboard

**Labs tab** (new top-level tab after Cost; route `/labs`, `/labs/:id`, `/labs/history`). Same design system and the one-screen rule:
at 1100×600 the page never scrolls; the catalogue panel scrolls inside itself.

- **Running strip** (top, hidden when nothing runs): a chip per session with state (Deploying 3/16, Running, Tearing down), title,
  time left, cost so far, peering (on, waiting, off, disconnected), **Extend** (1h, 2h, to max) and **Tear down** (confirm dialog).
- **Filters** (left column): exam, skill area, level, type, "not run yet". **Catalogue** grouped AZ-104 then AZ-305 by number;
  a card shows title, summary (2 lines), level, £/h, typical deploy time, suggested session, the pricey marker (£, ££, £££, resource
  on hover), a "run before: Lab 5" badge, "Ran 2×", and "Untested v2" when the version has no passing release test.
- **Lab modal** (desktop modal; sheet on the phone). Not running: readme, cost items and totals, warnings, session length (default
  `session_h`, up to `max_h`), "Peer to gateway" (optional: a tick; required: forced on; off: hidden; "will peer when the gateway
  is next running" if it is not), region (default the Settings one), **Deploy**. Running: pipeline steps and live log (the Activity
  run panel), resources from ARM with a portal link to `rg-lab-<id>`, private IPs and `connect` lines, admin password and Entra user
  names behind **Show**, **Extend**, **Tear down**, the note box, and for break-fix the collapsed "What was broken".
- **Your labs** (`/labs/history`): sessions table (date, lab, duration, cost estimate/actual, end reason, note) and a coverage map:
  per exam, one row per skill area with labs run / labs available and small boxes per lab (filled when run).

**Integrations:**
- **Overview topology:** running labs as small boxes beside the Azure VNet, linked with a solid line when peered, dashed when
  waiting or disconnected. The status banner adds "· 2 labs running (£0.12/h)".
- **Activity:** lab runs in the run list with the lab's title and a "Labs" filter chip; watchman notes use existing kinds (no new
  event type, so no widget option list changes). **Cost:** a "Labs" panel with this month's spend per lab (actual plus running
  estimates). **Firewall:** the Labs zone in the zone list and rule pickers (§7.6).
- **Widget `overview.runningLabs`:** `defaultOff`, home row `r4`, suggests replacing `overview.costImpact` (weight 32). It shows
  running labs with time left, cost so far and Tear down.
- **Command palette:** "Deploy lab…" (opens the lab's modal), "Tear down lab…" (running labs), and each lab's title as a jump.
- **Settings → Labs:** `labs_max_running`, default peering, permissions check (§8.2), slots in use, release tests (§11.2).
- **Phone:** the Labs tab is the seventh bottom-bar icon. One screen: running labs with lights, time left and Extend / Tear down;
  "Catalogue" and "Your labs" open sheets; a lab opens as a sheet with Deploy.

## 11. Keeping labs honest

### 11.1 Static tests (`npm run labs-check`, in `ci.yml`, no cloud calls)

- `lab.yaml` against the schema in `shared/labs.ts`: id = folder, unique, not a prefix of another; skill areas exist; prerequisites
  exist and have no cycles; `max_h ≤ 12`, `session_h ≤ max_h`; cost items non-empty; `pricey` names an item.
- `version` bumped when the lab's folder changed against `main`; `terraform fmt -check` and `terraform init -backend=false &&
  terraform validate` per lab (providers pinned as in `infra/`); HCL scope lint (§8.4); no literal CIDR outside `cidrsubnet`.
- Pool: 32 slots, no overlap with each other, the tunnel, loopback, vnet-wg, home LAN or Docker; a lab's `subnets_used` fits its slot.
- Readme has the required headings; break-fix readmes have Symptom and a closed `<details>`.
- Worker unit tests: slot reservation under races, timers and max lifetime, Extend refusal, budget teardown (labs yes, gateway no),
  orphan matching (prefixes, ignore list, 30-minute grace), the scope check against fixture plans (including one evil plan per rule),
  OIDC workflow allow-list per route, migration 0020.

### 11.2 Real-Azure release test (once per lab version)

Settings → Labs → **Test** (or `POST /labs/:id/test`) runs `action: test`: deploy, ready check (resources exist and every
`provisioningState` is Succeeded), peer and unpeer when the lab allows peering and the gateway is running, destroy, verify clean.
Recorded in `lab_release_tests` (deploy and destroy times, estimated cost). A version is **released** when its test passes with
`clean: true`; untested versions stay deployable, marked "Untested".

## 12. Curriculum

### 12.1 Skill areas (`labs/skill-areas.yaml`; names from Microsoft's study guides, (V) against the current outlines)

- **AZ-104:** `az104.identity` Manage Azure identities and governance · `az104.storage` Implement and manage storage ·
  `az104.compute` Deploy and manage Azure compute resources · `az104.networking` Implement and manage virtual networking ·
  `az104.monitor` Monitor and maintain Azure resources.
- **AZ-305:** `az305.identity` Design identity, governance, and monitoring solutions · `az305.data` Design data storage solutions ·
  `az305.continuity` Design business continuity solutions · `az305.infra` Design infrastructure solutions.
- **AZ-700** (outline "Skills measured as of July 27, 2026"; ruling 38): `az700.core` Design and implement core networking
  infrastructure · `az700.connectivity` Design, implement, and manage connectivity services · `az700.delivery` Design and
  implement application delivery services · `az700.private` Design and implement private access to Azure services ·
  `az700.security` Design and implement Azure network security services.

A lab may list skill areas of several exams (ruling 39); it then counts in each exam's coverage, and its `exam` (the id's
prefix) stays the primary.

### 12.2 The labs

Cost markers: £ pennies an hour, ££ up to about 50p an hour, £££ about £1 an hour or more, or a long deploy. Peer: off / opt /
req. Session and max are hours. G = governance lab. Times and SKUs are planning figures; release tests replace them.

| # | Id | Title | Areas | Lvl | Type | £ | Peer | Deploy | Sess/max | Identity |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | az104-01-identity | Users, groups, roles and custom roles | identity | F | explore | £ | off | 2 min | 1/4 | users, groups, custom role, RG assignments · G |
| 2 | az104-02-policy | Azure Policy, tags and resource locks | identity | F | explore | £ | off | 2 | 1/4 | policy defs, RG assignments, locks · G |
| 3 | az104-03-mgmt-groups | Management groups and subscription governance | identity | A | explore | £ | off | 3 | 1/4 | lab MGs, MG-scope policy · G |
| 4 | az104-04-cost | Cost management: budgets and alerts | identity, monitor | F | explore | £ | off | 2 | 1/4 | RG budget, action group |
| 5 | az104-05-storage | Storage accounts: redundancy, access tiers, lifecycle | storage | F | explore | £ | off | 3 | 2/6 | none |
| 6 | az104-06-blob-security | Blob security: SAS, access policies, private endpoint | storage, networking | A | explore | £ | opt | 4 | 2/6 | group, Blob Data Reader |
| 7 | az104-07-files | Azure Files shares mounted from a VM | storage, compute | A | explore | £ | opt | 5 | 2/6 | none |
| 8 | az104-08-vms | VMs: availability zones, disks, extensions | compute | A | explore | £ | opt | 6 | 2/6 | none |
| 9 | az104-09-vmss | VM Scale Sets and autoscale | compute | A | explore | £ | opt | 6 | 2/6 | none |
| 10 | az104-10-app-service | App Service: plans, slots, scaling | compute | A | explore | £ | off | 4 | 2/6 | none |
| 11 | az104-11-containers | Containers: ACI and Container Apps | compute | A | explore | £ | opt | 5 | 2/6 | none |
| 12 | az104-12-bicep | ARM and Bicep templates (Bicep) | compute | A | explore | £ | off | 3 | 2/6 | none |
| 13 | az104-13-vnets | VNets, subnets, NSGs, ASGs | networking | F | explore | £ | opt | 5 | 2/6 | none |
| 14 | az104-14-peering-udr | VNet peering and UDRs | networking | A | explore | £ | opt | 6 | 2/6 | none |
| 15 | az104-15-dns | Azure DNS public and private zones | networking | A | explore | £ | opt | 4 | 2/6 | none |
| 16 | az104-16-lb-appgw | Load Balancer and Application Gateway | networking | A | explore | ££ | opt | 12 | 2/4 | none |
| 17 | az104-17-netwatcher-fix | Break-fix: connectivity troubleshooting with Network Watcher | networking, monitor | A | break-fix | £ | opt | 6 | 2/4 | none |
| 18 | az104-18-monitor | Azure Monitor: metrics, alerts, Log Analytics | monitor | A | explore | £ | opt | 6 | 2/6 | none |
| 19 | az104-19-backup | Backup: Recovery Services vault, VM backup and restore | monitor | A | explore | ££ | opt | 8 | 3/8 | none |
| 20 | az305-20-landing-zone | Landing zone lite: management groups, policy initiatives, role design | identity | E | explore | £ | off | 4 | 2/4 | MGs, initiatives, custom roles · G |
| 21 | az305-21-monitoring-scale | Monitoring at scale: workspace design, diagnostics via policy | identity | E | explore | £ | off | 6 | 2/6 | DINE policy at RG, MI role · G |
| 22 | az305-22-keyvault-mi | Key Vault and managed identities | identity | E | explore | £ | opt | 5 | 2/6 | MI, Key Vault Secrets User |
| 23 | az305-23-sql-failover | Azure SQL Database: serverless, geo-replication, failover groups | data, continuity | E | explore | ££ | opt | 15 | 2/4 | none |
| 24 | az305-24-cosmos | Cosmos DB: partitioning and consistency | data | E | explore | £ | off | 8 | 2/4 | none |
| 25 | az305-25-storage-design | Storage design: data lake, immutability, tiering | data | E | explore | £ | off | 3 | 2/6 | none |
| 26 | az305-26-site-recovery | Cross-region VM restore and Site Recovery | continuity | E | explore | ££ | opt | 20 | 3/8 | none |
| 27 | az305-27-multi-region | Multi-region app with Traffic Manager and Front Door | infra, continuity | E | explore | ££ | off | 15 | 2/4 | none |
| 28 | az305-28-three-tier | Three-tier app: Container Apps, SQL, Front Door + WAF (ruling 41) | infra | E | explore | ££ | off | 15 | 2/3 | none |
| 29 | az305-29-aks | AKS small cluster, networking, ingress | infra | E | explore | ££ | opt | 12 | 2/4 | MI, AcrPull (V) |
| 30 | az305-30-messaging | Messaging and events: Service Bus, Event Grid, Functions | infra | E | explore | £ | off | 5 | 2/6 | none |
| 31 | az700-31-ip-nat-outbound | Public IP prefixes, NAT Gateway and outbound rules | 700 core | A | explore | ££ | opt | 6 | 2/4 | none |
| 32 | az700-32-dns-resolver | Hybrid DNS with DNS Private Resolver | 700 core | A | explore | ££ | opt | 10 | 2/4 | none |
| 33 | az700-33-vnet-manager | Virtual Network Manager: hub-and-spoke and security admin rules | 700 core, security | A | explore | ££ | opt | 10 | 2/4 | none · S1 |
| 34 | az700-34-route-server | Route Server with a BGP router VM | 700 core | E | explore | ££ | opt | 25 | 2/3 | none |
| 35 | az700-35-forced-tunnel-fix | Break-fix: hub-spoke routing fault (forced tunnelling) | 700 core; 305 infra | A | break-fix | £ | opt | 6 | 2/4 | none |
| 36 | az700-36-s2s-vpn | Site-to-site VPN between two VNets, one as on-prem | 700 connectivity; 305 infra | A | explore | £££ | opt | 45 | 2/3 | none |
| 37 | az700-37-p2s-vpn | Point-to-site VPN with Entra ID sign-in | 700 connectivity | A | explore | £££ | opt | 40 | 2/3 | user |
| 38 | az700-38-hub-firewall | Hub-spoke with Azure Firewall and Firewall Manager policy | 700 security, core; 305 infra | A | explore | ££ | opt | 15 | 2/3 | none |
| 39 | az700-39-vwan-secured-hub | Virtual WAN with a secured hub | 700 connectivity, security | E | explore | £££ | off | 35 | 2/3 | none |
| 40 | az700-40-lb-advanced | Load Balancer: cross-region, Gateway LB, inbound NAT, outbound rules | 700 delivery | E | explore | ££ | opt | 10 | 2/4 | none |
| 41 | az700-41-appgw-waf | Application Gateway WAF_v2: TLS, rewrites, WAF policy | 700 delivery, security | A | explore | ££ | opt | 12 | 2/3 | none |
| 42 | az700-42-frontdoor-private | Front Door Premium: rules, caching, WAF, Private Link origin | 700 delivery, security, private | E | explore | ££ | off | 15 | 2/3 | none |
| 43 | az700-43-private-link | Private Link service, private endpoints, service endpoint policies | 700 private; 305 infra, data | A | explore | ££ | opt | 8 | 2/4 | none |
| 44 | az700-44-flow-logs-bastion | VNet flow logs, IP flow verify and Bastion | 700 security, core | A | explore | ££ | opt | 12 | 2/4 | none · S2 |

Batch 4 changed this table (rulings 40–41, 2026-10-05): AZ-305 batch 4 is labs 28–30; the never-built AZ-305 labs 28
(hub-spoke firewall), 29 (S2S VPN), 30 (Private Link) and 34 (forced-tunnel break-fix) are AZ-700 labs 38, 36, 43 and 35.
Labs 13, 14, 15, 16, 17 and 27 also belong to AZ-700 (ruling 42). S1 and S2 are the scope exceptions of rulings 47–48.
AZ-700 rows show their planning marker from `costMarker`; designs are in `docs/superpowers/specs/2026-10-06-labs-az700-design.md`.

Cheap SKUs are listed in §15 item 13; lab 23 adds a separate serverless database to show auto-pause, and lab 35 uses a small Linux
router VM, not Azure Firewall. Break-fix faults: lab 17, an NSG deny at higher priority plus a UDR to a dead next hop; lab 35, a
0.0.0.0/0 UDR on the spoke to an NVA that does not forward.

## 13. Delivery

Each batch is built, tested for real on Azure (every lab in it passes §11.2 with `clean: true`), released (merged, Worker deployed),
and noted in its report before the next starts. Gateway-side changes ship as their own PR and take effect at the next gateway deploy.

1. **Engine + labs 1–7.** Migration 0020, `labs-build`, `labs-check`, `lab.yml`, `lab-scope.mjs`, `lab-unblock.sh`, lab API,
   locks, timers, budget, orphan sweep, cost query, prices for lab items, peering and the Labs zone, client AllowedIPs, the Labs tab
   (catalogue, modal, running strip, history and coverage), Activity, Cost, topology and banner, the widget, the command palette,
   Settings → Labs, phone. Gateway PR: `wg.yml` "Remove lab peerings", dnsmasq forwarding. README: §8.2. Labs 1–7 prove every
   governance permission and the lock "unblock" early.
2. **Labs 8–19:** compute, networking, monitoring, backup (the first vault "unblock" case).
3. **Labs 20–27:** AZ-305 governance, identity, data and continuity (cross-region and Site Recovery).
4. **Labs 28–30:** AZ-305 infrastructure (three-tier, AKS, messaging; rulings 40–41).
5. **The AZ-700 suite, labs 31–44,** plus AZ-700 tags on labs 13–17 and 27, including the £££ and slow labs
   (`docs/superpowers/plans/2026-10-06-labs-az700-plan.md`).

## 14. Risks and open questions

| Item | Status |
|---|---|
| SP blast radius (§8.5) | Accepted by Steven. Tenant-wide Graph write is the largest exposure. |
| Decision A (2026-10-05): the SP keeps `roleDefinitions/write` | **Accepted by Steven.** With it the pipeline SP could in principle define a role and so widen its own rights (escalate itself). It is kept, because labs 1, 20 and 21 teach custom roles. Mitigation is in lab content checks instead: `lab-lint.mjs` before init, and in `lab-scope.mjs` a lab custom role may hold no wildcard action other than a wildcard read and nothing that writes `Microsoft.Authorization`, must use its fixed GUID, and is assignable only inside the lab's own group(s). The code that would abuse the right still has to reach `main`. |
| Decision B (2026-10-05): "Deploy anyway" and the budget guard | **Steven's ruling.** "Deploy anyway" only skips the warning before a deploy. At 100% of the month's budget every live lab is torn down, one deployed with "Deploy anyway" included; the gateway never. Note: the guard's total includes running labs' estimates to their timers, so a lab deployed anyway over budget is torn down at the next watch run (within 5 minutes). |
| Teardown blockers | Locks, backup items with soft delete, Site Recovery replication, legal holds and **locked** immutability can stop a group delete. The unblock step handles the first four, and locked immutability is refused at plan. Vaults are created with soft delete off (V: still allowed on new vaults). |
| Azure-made resource groups | AKS (`node_resource_group`), backup instant restore (`instant_restore_resource_group` prefix) and Site Recovery targets must be named `rg-lab-<id>-*` or they escape the sweep. CI checks these attributes are set. |
| Budget size | Today's `MONTHLY_BUDGET_GBP` is £10. One 2-hour session of a £££ lab is about £2, so §15 asks Steven to set a study-period budget. |
| VPN gateway time | Microsoft quotes 45 minutes or more per gateway (V); two are built in parallel. Planned 35 minutes to deploy and 20 to destroy, with a 130-minute job timeout (cap 150). |
| App Gateway, Front Door, Azure Firewall | App Gateway Standard_v2: fixed fee plus capacity units, about £0.15–0.20/h (V); a Basic SKU may be GA and in `azurerm` (V), and lab 16 uses it if so. Front Door Standard: monthly base fee, about £0.04/h prorated (V). Azure Firewall Basic: about £0.30/h plus two public IPs (V). |
| AKS and quotas | Free tier has no control-plane charge (V); system pools need ≥ 2 vCPU and 4 GB (B2s, V). New pay-as-you-go subscriptions have low regional vCPU limits (V); the capacity warning covers VM sizes only. |
| Network Watcher, Log Analytics | Network Watcher is enabled per region automatically; the lab 17 tools are free apart from connection troubleshoot, billed per 1,000 checks (pennies, V). No flow logs or Connection Monitor. Log Analytics ingestion is small, believed within the free allowance (V). |
| SQL failover group | Two Basic databases cost about £0.007/h together (V). Auto-pause is not available for geo-replicated serverless databases (V), hence the split design. |
| Cost Management delay | Actuals lag 8–24 hours, so budget teardown works on estimates plus actuals and can be a few pence late. |
| Exam outlines, lab users | Skill area names (§12.1) checked on Microsoft Learn (V) before batches 1 and 3. Security defaults may make lab users register MFA at first sign-in (V); the readme says so. |
| Management groups | Creation rights depend on the hierarchy setting (§8.1, V). A lab MG must be empty to delete, so the safety net deletes children first. |
| GitHub | Public repo: Actions minutes are free; 20 concurrent jobs, far above `labs_max_running`. Lab logs are public, so lab outputs with addresses are masked as `wg.yml` does. |
| Private DNS link and VNet delete | (V) whether a private DNS zone link blocks deleting `vnet-wg`. The gateway destroy removes links first anyway. |

Open questions for Steven: none block batch 1, apart from running §8.2 and choosing a study budget (§15 item 1).

## 15. Decisions Steven may want to change

1. **Budget:** labs share the existing monthly budget (£10 today). Suggested: raise it to about £30 for study months.
2. **Pool 10.64.0.0/13, 32 × /18 slots,** IPv4 only.
3. **Peered traffic reaches labs from the gateway VM's VNet address** (NAT, no change to the gateway). Lab NSGs see 10.50.1.x,
   not the client's 10.13.13.x. Keeping the real source would need routes in every lab subnet back to the gateway VM.
4. **The client "Azure route" switch also carries the lab pool** (no separate switch); one config re-download per client.
5. **Tunnel DNS forwards Azure service domains to Azure DNS** (§6), so private endpoints resolve over the tunnel.
6. **At most 3 labs at once** (`labs_max_running`), within budget.
7. **Session timer:** defaults to the lab's suggestion; Extend in 1-hour steps; maximum lifetime per lab, never over 12 hours.
8. **A failed lab deploy is destroyed after 15 minutes** (the gateway waits 30); budget teardown also cancels labs mid-deploy.
9. **Catalogue bundled at Worker build:** a new lab or version needs `npm run deploy-worker`.
10. **Governance labs:** 1, 2, 3, 20, 21 (lab 4 keeps its budget on its own group). Definitions at subscription scope are
    allowed; assignments there never are.
11. **Role-assignment allow-list** as in §8.1; a lab needing another role changes the list and the condition.
12. **Graph permissions** `User.ReadWrite.All`, `User.DeleteRestore.All`, `Group.ReadWrite.All` (tenant-wide). A dedicated
    lab service principal, or an administrative-unit-scoped role (V: licensing), would narrow this later.
13. **SKUs:** App Gateway Standard_v2 (or Basic if available), Azure Firewall Basic, VPN Gateway Basic (else VpnGw1), SQL Basic
    pair plus one serverless database, Front Door Standard with custom WAF rules, AKS Free with one B2s node.
14. **Release test from the dashboard** (Settings → Labs → Test). Untested versions stay deployable, marked "Untested".
15. **UI:** tear down a lab with a confirm dialog (not typing `destroy`); Labs is the phone's seventh bottom-bar icon, after Cost;
    the Running labs widget lives in row `r4` and suggests replacing Cost impact.
16. **Lab VMs have no public IP.** Reach them through peering, or the portal's Serial console or Run command.
17. **Lab ids `az104-NN-slug` / `az305-NN-slug` / `az700-NN-slug` (ruling 38),** with resource groups and Entra names derived from them (§3.1).

## 16. Rulings from the batch 1 plan

Copied from `docs/superpowers/plans/2026-10-04-labs-batch1-plan.md` (rulings 1–8) and its contract area L0. Where they differ
from the sections above, these win.

1. **The app never imports the generated catalogue.** It reads `GET /labs`; only the Worker imports `shared/labs.generated.json`
   (so §7.1's "imported by the Worker and the app" now reads "by the Worker").
2. **Readmes are parsed at build time** into `ReadmeBlock[]` and drawn as React elements, never as HTML. Allowed: headings (`#`
   to `###`), paragraphs, `-` bullets, fenced code, `**bold**`, inline `` `code` ``, `[links](https://...)` and `<details>`.
   Anything else is refused by `labs-build`. Names like `<id>` go in backticks.
3. **Custom roles get fixed GUIDs** (`role_definition_id`), kept with the allowed built-in GUIDs in
   `labs/setup/allowed-roles.json`, which the scope check and the setup condition both read.
4. **Timers:** `max_until` = `requested_at + max_h`; `auto_destroy_at` = `ready_at + hours`, never later than `max_until`; the
   estimate = `est_gbp_h × (ended_at − requested_at)`.
5. **The Cost "Labs" panel is widget `cost.labs`**, off by default, in Cost row `r3` (now `max: 3`), suggesting `cost.insights`.
   `overview.runningLabs` is off by default in Overview `r4`, suggesting `overview.costImpact`.
6. **`peers.labs_config_due`** marks split-tunnel `azure_vnet` clients whose config predates the lab pool; it clears when that
   client's config is fetched or edited.
7. **Extra routes:** `GET /labs/:id/secret`, `POST /labs/repeer`, `POST /labs/permissions/check`.
8. **An inert `lab.yml` lands on `main` first** (PR 0), so branch tests can dispatch it; without `secrets_url` a run makes its
   own masked password and skips peering.
9. **Lab ids use single hyphens** (`^az(104|305)-\d{2}-[a-z0-9]+(-[a-z0-9]+)*$`): no trailing or doubled hyphen, so names built
   from an id cannot be ambiguous.
10. **`lab.yaml` is read as YAML 1.1**, as most tools read it: an unquoted `off` is a boolean and is refused, so write `"off"`.
    Unknown keys are refused. A `retail.sku` must also appear in `capacity.vm_sizes`; whole minutes and hours only.
11. **Optional output `users`** (name → user principal name) is what Show reveals beside the admin password.
12. **`labs_default_peering` defaults on**; `labs_max_running` is 1–5, default 3.
13. **Cost markers** (`costMarker`): £ under £0.05/h, ££ under £0.50/h, £££ from £0.50/h or a deploy of 30 minutes or more.
14. **The permission check result and the orphan list live in KV** (`labs:permissions`, `labs:orphans`), not D1.
15. **A lab run in the Activity list keeps a gateway `action`** (`apply` for deploy, peer and test; `destroy` for destroy and
    unpeer); `RunRow.lab.action` carries the lab action.
16. **Deploy and Extend take whole hours, 1 to 12**; Extend may instead ask `toMax`.

## 17. Rulings from the batch 2 and batch 3 plans

Copied from `docs/superpowers/plans/2026-10-05-labs-batch2-plan.md` (rulings 1–12, B0's 13–20 as built on
`feat/labs-b2-engine`, and 21 on from the batch's review fix pass; its "B0 names as built" section has the exact names). Where they differ from the sections above,
these win; §3.4's `az bicep build` and §5 step 5's are replaced by ruling 1.

1. **Bicep is the §3.4 hybrid, pinned.** `az bicep build` downloads whatever Bicep is newest; it is replaced by a
   checksum-pinned `bicep build` (Bicep 0.47.16, `scripts/lib/bicep.mjs`). `lab-scope` reads the built template from the plan
   (`template_content` is known at plan) and refuses Graph extension resources, deployment scripts, linked templates
   (`templateLink`), template specs, extension imports, non-resource-group schemas and any template it cannot read.
   `labs-tf` checks the built JSON with `templateProblems`.
2. **A `retail.meter` must be unique in uksouth.** The feed matches on meter name alone, and four names batch 2 wants are
   shared: `P0v3 App` (Linux £0.0653, Windows £0.1257), `S1 App` (Linux £0.0755, Windows £0.0943), `Standard Fixed Cost` and `Standard Capacity Units` (App Gateway v2,
   WAF v2, AGC), `Standard vCPU Duration` (ACI, Logic Apps). Those items, the load balancer (no regional row), DNS zones
   (tiered, region "Zone 1"), ACI memory (`1 GB Hour`) and Log Analytics stay authored. `labs-verify --meters` proves the rest.
3. **`capacity.vm_sizes` lists one entry per VM at its maximum** (the capacity warning counts each entry as one VM); cost
   `qty` is the default count. Lab 9 lists three `Standard_B1s` and prices two.
4. **Markers come from `costMarker`,** not §12.2's planning column: lab 10 is ££ (S1 Linux; P0v3 has no default quota on pay-as-you-go), lab 16 is ££ on App Gateway
   **Standard_v2** (Steven's choice over Basic after the batch review: autoscale 0–2, as azurerm takes no maximum below 2;
   about £0.24/h, its shared meters authored by ruling 2; lab version 2), lab 19 is £ by estimate.
5. **No public IP on any VM.** VMs serve with `python3 -m http.server` from a cloud-init systemd unit. Public by nature and
   accepted: lab 10's app and slot, lab 11's Container App ingress, lab 15's public zone. Lab 16's App Gateway must own a public
   IP; its only listener is private.
6. **Lab 9 uses a Uniform scale set** (`azurerm_linux_virtual_machine_scale_set`); Flexible is a Things-to-try item.
7. **Lab 11's Container Apps environment is consumption-only with no infrastructure subnet,** so Azure makes no `MC_`/`ME_`
   group outside `rg-lab-<id>`; the scope check refuses an environment with a subnet unless its infrastructure group is
   `rg-lab-<id>-*`. ACI runs in a delegated subnet. The registry is empty: images come from MCR.
8. **Lab 17 makes no Network Watcher resource.** Azure's own lives in `NetworkWatcherRG`; the VMs get the
   `NetworkWatcherAgentLinux` extension only.
9. **Lab 18 never writes subscription diagnostic settings;** the workspace is capped and permanently deleted on destroy.
   **Lab 19's vault** is Standard, LRS, `soft_delete_enabled = true` (Azure requires it on a new vault; unblock turns it
   off before destroy), `immutability = "Disabled"`; instant restore goes to
   `rg-lab-<id>-irp`.
10. **Lab 15's private zone is `lab15.internal`**: the gateway's dnsmasq already forwards `internal` to Azure DNS (§6).
11. **`labs-pr0-check` is not needed:** `lab.yml` is on `main`, and `--ref feat/labs-b2` runs that branch's `lab.yml` and
    `infra/ci/`. B0's workflow changes reach `main` in the batch PR itself.
12. **No UI change** in batch 2.
13. **No unpinned Bicep anywhere.** lab.yml step 5 and CI download the linux-x64 asset from the official GitHub release and
    run it only after `sha256sum -c`, with no secrets in its environment (`env -i`). `npm run labs-tf` runs `$BICEP` only if it
    matches the pin byte for byte, else the pinned download (checked before every use); never a `bicep` from PATH, never
    `az bicep`. Without one, a Bicep lab's build, init and validate are skipped with a note (a failure with
    `LABS_TF_REQUIRE_BICEP=1`, as in CI).
14. **A template may not reach beyond the lab's group,** even by name: any literal subscription-level or management-group id,
    `resourceId()` with a resource group or subscription argument, `subscriptionResourceId()`, `tenantResourceId()` and
    `managementGroupResourceId()` are refused (`outside-scope`), as are the gateway's names (`gateway`). A plan whose
    `template_content` is unknown is refused; in HCL it is left to `labs-tf`.
15. **Terraform deployment scripts** (`azurerm_resource_deployment_script_*`) **and template deployments at subscription,
    management group or tenant scope are refused,** as is `template_spec_version_id` (`outside-scope`).
16. **The lint reads `.bicep` too,** before the build: literal CIDRs, the gateway's names, registry or template spec modules
    (`module`), `extension`/`import`/`provider` statements (`provider`), and a committed `x.json` beside `x.bicep` (`file`).
17. **The PR 0 comparison test is skipped from batch 2 on** (ruling 11); `npm run labs-pr0-check` stays for a future PR 0.
18. **The shared content suite binds every batch 2 lab:** an S4 OS disk priced per VM, an E1 item per data disk,
    `retail.sku` `qty` = the default count, and a public IP only for an Application Gateway.
19. **`npm run labs-verify`** (network, never in `npm test`): every readme link answers 200, every retail meter has one
    uksouth price in a unit the feed reads (now including `1/Hour`), and an authored price more than 25% from Azure's is a
    problem. Lab 6's `Standard Private Endpoint` has no uksouth row (Azure prices it under region `Global`), so the feed never
    refreshes it: a batch 1 finding. The batch 2 integration drops its `retail` entry and authors it (£0.0076/h against
    Azure's Global £0.0075/h), as ruling 2 does for meters the feed cannot read; lab 6 is version 2.
20. **Vault teardown:** unblock turns an `Unlocked` vault immutability `Disabled` before soft delete (a `Locked` one is a loud
    warning), stops protection with data deleted for every management type the CLI can (`AzureIaasVM`, `AzureStorage`,
    `AzureWorkload`; `MAB` is a warning), and waits, polling every 15 s, until the vault lists no items, at most
    `LAB_UNBLOCK_VAULT_WAIT_SECONDS` (default 300). It never fails the run. A failed item list is never read as "no items
    left": it is a warning, and if the wait ends on one, the vault's items are reported "unverified" (review fix pass).
21. **A template deploys only allow-listed types** (review fix pass). `templateProblems` reads keys case-insensitively, as
    ARM does, and refuses every resource type not in `TEMPLATE_TYPES` (`infra/ci/lab-scope.mjs`): today storage accounts,
    VNets and subnets, NSGs and their rules (lab 12), and `Microsoft.Resources/deployments` only as Bicep emits a module
    (inline template, inner expression scope, Incremental, no `resourceGroup`/`subscriptionId`/`scope`). A lab that needs
    another type adds it there with the reason it can only ever land inside the lab's group; the refusal says so. Types
    that make or reach other groups (AKS without `nodeResourceGroup`, Container Apps environments in a subnet, managed
    applications, deployment stacks) stay off it. `subscription()`, `tenant()`, `managementGroup()`,
    `extensionResourceId()` and any literal `/subscriptions/` or `/resourceGroups/` path are refused too; `resourceGroup()`
    is the deployment's own group and is fine. `metadata` is skipped only where it is ARM's description slot.
22. **The safety net retries a failed group delete and never outlives the job.** It issues every delete with `--no-wait`
    and polls the groups' `provisioningState` (`LAB_DELETE_POLL_SECONDS`, default 30) instead of `az group wait --deleted`,
    which cannot tell a failed delete from a slow one. A group back in `Succeeded`/`Failed` gets unblock run again and its
    delete re-issued, at most `LAB_DELETE_RETRIES` (default 2) times. Polling stops by Parse payload's `LAB_JOB_DEADLINE`
    (the job's start plus `timeout_min`) less 420 s for the rest of the job, or `LAB_DELETE_WAIT_SECONDS` (default 1500)
    without one; a group still there is a warning, "left behind", and Verify clean names it.

### Rulings from the batch 3 plan (23 on)

From `docs/superpowers/plans/2026-10-06-labs-batch3-plan.md` (labs 20–27). Where they differ from the sections above, these win.

23. **No App Service in batch 3.** The subscription has 0 App Service quota for P0v3 and S1 in uksouth (lab 10 is parked on
    `feat/lab-10-app-service`). Lab 27's backends are two Azure Container Instances groups (uksouth and the secondary region),
    each with a public IP and DNS label, serving one static page with `python3 -m http.server` from an MCR image. Public by
    nature and accepted, like ruling 5's list: Traffic Manager and Front Door reach origins over the internet. No App
    Gateway Basic (preview, not registered) and no preview SKU anywhere.
24. **Lab 23 is DTU in uksouth.** The SQL vCore quota is 0 in uksouth (320 in ukwest), so lab 23 keeps its id and title but
    builds a Basic primary database in uksouth, an explicit Basic geo-secondary (`create_mode = "Secondary"`) on a ukwest server,
    and a failover group over them with the customer-managed (`Manual`) policy. Serverless is one separate GP_S_Gen5_1 database
    (minimum 0.5 vCore, auto-pause) on the ukwest server, outside the failover group (auto-pause is not available to
    geo-replicated serverless databases). Not the free offer: azurerm 4.81 has no free-limit attribute, and the subscription's
    free databases may already be in use.
25. **Secondary-region resources live in `rg-lab-<id>-secondary`,** made by the lab's own Terraform in `var.secondary_region`
    (`azurerm_resource_group.secondary`, name `"${var.resource_group_name}-secondary"`). A lab with `regions.secondary` refuses
    an empty secondary region or one equal to `var.region` (variable validation). Its secondary-region VNets take /20s of the
    lab's own slot, never addresses of their own. As built: the scope check holds an unknown id at any nested path (a
    failover group's partner server and databases, a replicated VM's disk target group) to the lab's own resources, as it
    does top-level ids; inside an attribute written as blocks (`managed_disk`, typed `set(object)`), where
    `terraform show -json` lists every reference under the attribute, all of the attribute's references must; and the content suite's `secondary: true` checks both groups, `regions.secondary: ukwest` and the validation.
26. **A cost item may say `region: secondary`** (only in a lab with `regions.secondary`). The Worker then prices its
    `retail` entry in the session's secondary region (the lab's `regions.secondary`; the cards, modal and warnings read that
    region's prices too), `labs-verify --meters` checks it there, and the content suite counts VM sizes and S4 disks per
    region: a replicated VM adds a secondary-region S4 (its replica disk) and one `capacity.vm_sizes` entry (its failover
    VM).
27. **Lab 20's custom roles are assigned by its Terraform** (identity change 2, approved by Steven 2026-10-05, chosen over
    define-only roles, which were never built). Its two roles (`lab-az305-20-landing-zone-netops`,
    `60bdbc03-b25a-4a83-9fce-b2c5afff563c`; `lab-az305-20-landing-zone-appops`, `bd52e05a-22cb-4bd5-b56c-3396add9b7c0`) are
    ordinary `allowed-roles.json` custom entries: fixed GUID, assignable only at `rg-lab-<id>`, each assigned there to its own
    user-assigned managed identity in `rg-lab-<id>` (`principal_type = "ServicePrincipal"`), and listed in `lab.yaml`
    `identity.roles`. `governance-condition.txt` gains both GUIDs (regenerated with `node scripts/labs-setup.mjs
    --condition`), and the condition is re-applied in Azure, with Steven's sign-in, before lab 20's release test. The scope
    check allows the roles' assignment to lab 20 only, as for lab 1's role.
28. **Remediating policies stay inside the lab.** A lab policy definition with `deployIfNotExists` or `modify` may list in
    `roleDefinitionIds` only built-in roles on the allow-list and may not deploy at subscription scope; its assignment's
    identity gets exactly those roles, at the lab's own group (`role`, `outside-scope`). Lab 21's diagnostics policy needs only
    Monitoring Contributor (it holds `Microsoft.Insights/diagnosticSettings/*`, `Microsoft.Resources/deployments/*` and
    `Microsoft.OperationalInsights/workspaces/sharedKeys/action`), so lab 21 needs no identity change (Log Analytics
    Contributor stays contingent on the lab 21 soak). As built: every `roleDefinitionIds` entry in the rule is read
    (keys case-insensitive, whatever the effect says, since it may be a parameter), and in a plan a rule that is not known
    (built from apply-time values) is refused: those values go to the assignment as parameters.
29. **Management-group initiatives are governance definitions.** `azurerm_management_group_policy_set_definition` joins the
    governance types (governance labs only, named `lab-<id>-*`). Batch 3 defines no initiative at subscription scope, so the
    orphan sweep's lists are unchanged.
30. **Key Vault never keeps a lab alive.** Purge protection is refused at plan (rule `immutability`: nothing could delete the
    vault for its retention); soft-delete retention is 7 days; the provider purges the vault on destroy; the safety net purges
    soft-deleted vaults that lived in a lab group, and Verify clean counts one as a leftover.
31. **Unblock knows SQL and Site Recovery.** Before the group deletes: SQL failover groups are deleted (on the server that
    holds the primary, so a swapped failover is handled), then the primary databases' geo-replication links; Site Recovery
    recovery plans are deleted (a learner may make one; it holds its items), test failovers are cleaned up, replication is removed and waited for (every 15 s, at most
    `LAB_UNBLOCK_ASR_WAIT_SECONDS`, default 900; a list that fails is "unverified"; never failing the run), then network
    mappings, container mappings and replication policies are removed (an Azure-to-Azure vault needs only its items gone;
    the rest is tidy-up).
32. **Lab 26 is Site Recovery only,** titled "Cross-region VM recovery with Site Recovery" (confirmed by Steven
    2026-10-05). Backup cross-region restore is not built: a GRS vault's secondary-region recovery points appear hours after
    a backup, beyond any session. The source VM is
    AlmaLinux 9.7 Gen2 (`almalinux`/`almalinux-x86_64`/`9-gen2`), pinned to version `9.7.2026051801` (free, no marketplace
    plan), with default outbound access set on explicitly; the vault, the target and test VNets and everything failover makes
    are in `rg-lab-<id>-secondary`. *Changed 2026-10-06 (v3):* it was Ubuntu 22.04, but the first release test failed because
    Mobility agent 9.66 did not support that image's current Azure kernel (6.8.0-1064; the matrix listed 22.04 Azure kernels
    only to 6.8.0-1041), and Ubuntu's kernel cadence keeps outpacing the agent. Agent 9.66 supports RHEL-family 9.0–9.7
    (kernel 5.14.0-611.5.1 and later); 9.8 images need agent 9.67, which uksouth did not deploy, hence the exact 9.7 pin and
    never `latest`. Its cloud-init installs and upgrades nothing, so the kernel never moves under the agent; SELinux stays
    enforcing (the systemd unit runs unconfined) and firewalld, where running, has port 80 opened permanently.
33. **Lab 24's Cosmos DB account is serverless,** single region, with the free tier off (one per subscription; creation fails
    if it is already taken). Consistency and multi-region writes are taught on that account and in the readme.
34. **Lab 25 uses container-level, unlocked immutability only** (1 day; `locked = true` is refused at plan). No version-level
    immutability, no SFTP (billed by the hour), no data-plane resources in Terraform.
35. **Plan fixtures are checked against real plans.** Every release test records its plan's shape (addresses, references,
    unknown and sensitive paths, never values) and the fixture test compares against it; `labs-tf` also plans each lab offline
    with mocked providers (`terraform test`). As built: lab.yml step 6 prints the shape as one `LAB_PLAN_SHAPE` line (gzipped
    JSON, base64), the release test saves it as `scripts/test/fixtures/labs/plans/shapes/<id>.json`, references are compared
    as sets; the mock plan mocks only the providers a lab installs, gives the subscription and client-config data sources
    real-looking ids, and uses a parseable throw-away SSH key.
36. **The ready check may accept an empty `provisioningState` only for a listed type,** added test-first on release-test
    evidence; the list starts empty (`READY_NO_STATE_TYPES` in `infra/ci/lab-ready.sh`, which reads each resource's type).
37. **Subnets that need outbound access say so.** A subnet whose VMs need to reach Azure services (Key Vault, Site Recovery)
    sets `default_outbound_access_enabled = true` explicitly instead of relying on the provider's default.

### Rulings from the AZ-700 suite (38 on)

From `docs/superpowers/specs/2026-10-06-labs-az700-design.md` (its §9) and `docs/superpowers/plans/2026-10-06-labs-az700-plan.md`
(labs 31–44, the AZ-305 batch 4 shrink, tags on labs 13–17 and 27). Where they differ from the sections above, these win; §-references
in them are to the AZ-700 design spec.

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

Rulings 56–61 are the AZ-700 integrator's (2026-10-06, `feat/labs-az700`): the content areas' calls, each checked and
accepted as built.

56. **`subnets_used` counts every /20 of the slot a lab's Terraform takes, VNet or not** (the content suite counts the
    distinct `cidrsubnet(var.address_space, 2, n)`). Lab 34 is 3 (hub /20 0, spoke /20 1, the FRR-advertised /24 in /20 3);
    lab 37 is 2 (hub /20 0; the P2S pool, the last /24 of /20 3); lab 39 is 3 (spokes /20 0 and 1, the hub /23 in /20 3).
    **Lab 37's client pool is derived from the slot** (`cidrsubnet(cidrsubnet(var.address_space, 2, 3), 4, 15)`), never
    fixed: it stays inside the session's own /18, so it cannot meet another lab's slot (the 32 slots of 10.64.0.0/13 are
    disjoint, so two labs at once never collide) or the gateway's own ranges (outside the pool, §4); on Steven's PC the P2S
    routes are more specific than WireGuard's 10.64.0.0/13 route. Test 6 checks the pool against the lab's VNets.
57. **Service subnets say `default_outbound_access_enabled = true`** (ruling 37's "say so", for subnets with no VM):
    `GatewaySubnet`, `RouteServerSubnet`, `AzureFirewallSubnet`, `AzureFirewallManagementSubnet`, `AzureBastionSubnet`, the
    resolver's delegated subnets and the App Gateway subnet keep the value those services were proven on (Learn, "Default
    outbound access", 2026-07-24: private subnets do not apply to delegated or managed service subnets). VM subnets say
    `false` where the lab teaches or forces explicit outbound (31; 35's spoke; 38 and 39's spokes) or where nothing needs the
    internet (40, 41's web, 42, 43's provider and endpoint subnets: no package installs, pages from `python3`), and `true`
    where cloud-init installs a package or the learner needs the internet (32, 33, 34, 35's NVA, 36, 37, 43's client, 44).
    Lab 33's spoke NSGs deny SSH from the hub (the AlwaysAllow admin rule visibly wins) instead of allowing it from anywhere:
    ruling 50 forbids an inbound internet SSH rule.
58. **Lab 36's local network gateways read the far gateway's BGP address through `try(…default_addresses[0], "")`.**
    Accepted: a real plan has the address unknown (the gateway does not exist yet) and `try()` passes an unknown through
    (Terraform 1.14 plans `try(<unknown>, "")` as "known after apply", checked), so the `""` fallback is reached only in
    labs-tf's mocked plan, whose computed peering list is empty. It cannot hide a real misconfiguration: at apply the
    address is known, and if Azure ever returned none the local network gateway would carry an empty BGP address, which
    fails the apply or leaves BGP down (the lab 36 soak checks BGP `Connected`). The plan fixture keeps the attribute
    unknown with the reference, and the release test records the real shape.
59. **Lab 40's web NSGs allow TCP 80 only, not the NAT rule's 8081–8090:** an NSG sees inbound NAT traffic after the load
    balancer has translated it to backend port 80, so a rule for the frontend ports would never match.
60. **Lab 43's `peer_vnet_id` is `vnet-consumer`,** not the first VNet: the learner works from the consumer side (`pe-svc`,
    `pe-blob`, `vm-client`, the blob zone), and peering the provider would go round the Private Link service the lab
    teaches. The provider is never peered.
61. **Lab 41's certificate goes with the vault purge:** `purge_soft_delete_on_destroy = true`,
    `purge_soft_deleted_certificates_on_destroy = false` and no recovery of vaults or certificates, as lab 22 does for
    secrets (ruling 30): the destroyed certificate is soft-deleted inside the vault, and purging the vault removes it.
