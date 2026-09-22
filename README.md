# wg-admin: an on-demand WireGuard concentrator in Azure

A VPN headend that only exists while you want it. One click builds a small
Azure VM running WireGuard, points **wg.clydeford.net** at it, and shows you
who is connected. Another click tears it all down and the Azure bill goes back
to £0. Your phones and laptops never change: they always dial the same name and
trust the same server key.

Everything that manages it runs on Cloudflare and GitHub, both on free tiers.
Nothing runs in the homelab except the WireGuard clients themselves.

> **Status:** the dashboard is live at **https://wg-admin.clydeford.net**
> (Cloudflare Access login). Deploy, tear down, add clients by QR, watch the
> live log, see cost. The Deploy button needs the GitHub token in place (see
> Settings > Setup). The full design is in [wg-admin-spec.md](wg-admin-spec.md).

## The picture

```mermaid
flowchart LR
  U[You] --> CA[Cloudflare Access<br/>login gate]
  CA --> W[Worker<br/>wg-admin.clydeford.net<br/>Phase 2]
  W -->|"run it"| GH[GitHub Actions<br/>runs Terraform]
  GH --> AZ[Azure UK South<br/>one small VM]
  GH --> R2[(R2 bucket<br/>Terraform state)]
  GH --> DNS[Cloudflare DNS<br/>wg.clydeford.net]
  AZ -->|heartbeat every 30s| W
  C[WireGuard clients<br/>phone, laptop, home] -->|UDP 51820| AZ
```

## The moving parts, in networking terms

| Part | What it is | Think of it as |
| --- | --- | --- |
| **Terraform** (`infra/`) | A description of every Azure object: resource group, VNet, subnet, NSG, public IP, NIC, VM, plus the DNS record. `apply` builds it, `destroy` removes it. | A config template you push to a new site, and pull back when the site closes |
| **cloud-init** (`infra/cloud-init.yaml.tftpl`) | A script Azure hands the VM on first boot. Installs WireGuard, writes its config, opens the tunnel, starts the heartbeat. | Zero-touch provisioning, like Cisco ZTP or a Meraki claiming itself |
| **The agent** (`infra/agent/`) | A 30-second systemd timer on the VM that POSTs `wg show` output to the Worker and applies any new peers the Worker sends back. | SNMP traps plus a tiny config-push channel |
| **GitHub Actions** (`.github/workflows/wg.yml`) | The machine that actually runs Terraform. It logs into Azure and Cloudflare with secrets, runs apply or destroy, backs up state, reports back. | The NOC engineer who types the change |
| **R2 bucket** `wg-admin-tfstate` | Where Terraform keeps its inventory of what it built. Locked during a run so two runs cannot collide. | The startup-config; lose it and the box still runs but you no longer know what you have |
| **wg.clydeford.net** | An A record, TTL 60, DNS-only (grey cloud). Points at the VM while it exists; parked on the reserved address 192.0.2.1 while destroyed, so it always resolves and nobody caches a "no such host". | A DDNS name: the name is stable, the address behind it is disposable |
| **Cloudflare Access** | Login gate for the dashboard. Only stevie.johnston@gmail.com gets in. | MFA on the management plane |
| **The Worker** (Phase 2) | The dashboard and API at wg-admin.clydeford.net. | The management plane |

## Setup, once

You need: [Node.js](https://nodejs.org) 20+, [GitHub CLI](https://cli.github.com) (`gh auth login`), and
[Terraform](https://developer.hashicorp.com/terraform/install) 1.10+ for local validation.

1. **Fill in `.env`.** Copy `.env.example` to `.env` if you do not have one. Every
   key has a comment saying what it is and where to get it. The values marked
   `REPLACE_ME` are the only ones you must mint by hand; the comments tell you
   where in each dashboard to click.

2. **Server key.** If `WG_SERVER_PRIVATE_KEY` is blank:

   ```sh
   npm run keys
   ```

   This is the one key every client trusts. It is generated once and kept
   forever. `npm run keys` refuses to overwrite it unless you pass `--rotate`.

3. **Push secrets to GitHub.** Terraform in Actions reads them from there.

   ```sh
   npm run secrets -- --dry-run   # shows what it would set, never the values
   npm run secrets
   ```

   It refuses to run while any `REPLACE_ME` remains. If the narrow DNS token
   is not minted yet it will use the broad token with a loud warning, so you
   can test before tightening.

4. **Check the Terraform** (no cloud calls):

   ```sh
   npm run tf-validate
   npm test
   ```

## Using the dashboard

Open **https://wg-admin.clydeford.net** and sign in with Google, or with the
one-time PIN sent to your email (Cloudflare Access; only your address is allowed). On a phone, use "Add to Home Screen": it
installs as an app and the login lasts 24 hours.

| Screen | What it does |
| --- | --- |
| **Overview** | The big state word and the tunnel diagram. Deploy (choose how long for), Tear down (type `destroy`), extend or clear the auto-destroy, cancel a run, clean up after a failure. While a run is in progress you see the GitHub steps and the live log. |
| **Clients** | Every phone and laptop with its tunnel address, online/offline, last handshake and traffic. Add a client: the keys are made in your browser, the private key never leaves it, and you get a QR code to scan with the WireGuard app. Disable or delete a client; a running VM picks the change up within 30 seconds. |
| **Activity** | Every deploy and tear-down with how long it took and what it cost, plus the watchman's notes (drift, cost guard, missing heartbeat). |
| **Cost** | This session ticking up, this month's actual spend from Azure against a soft budget, daily bars, and each past session. |
| **Settings** | Region, VM size, default auto-destroy, idle tear-down, budget, SSH allow-list. The setup checklist, the run lock, and the server public key. |

The watchman (a 5-minute cron in the Worker) tears down when the timer
passes, again 15 minutes later if that somehow failed, on idle if you set it,
flags drift between Azure and the dashboard, and pulls actual cost daily.

### Deploying the dashboard itself

```sh
npm run secrets -- --worker   # push Worker secrets (skips placeholders with a warning)
npm run deploy-worker         # applies database migrations, then deploys
npm run dev                   # run it locally at http://localhost:8787 with login off
```

## Using it without the dashboard (from the GitHub Actions tab)

### Make a client

```sh
npm run peer -- --name laptop --ip 10.13.13.2
```

This writes `peers/laptop.conf` (import it into the WireGuard app; it holds the
client's private key and is gitignored) and prints a `peers_json` payload. Use
`--full` for a full-tunnel (exit node) config, and `--home` to also route the
home LAN through the tunnel (only for a device that is away from home, and
only once site-to-site is built).

### Deploy

GitHub > **Actions** > **wg** > **Run workflow**:

- action: `apply`
- payload: paste the JSON that `npm run peer` printed, e.g.
  `{"peers_json":"[{\"name\":\"laptop\",\"public_key\":\"...\",\"ip\":\"10.13.13.2\"}]"}`

About three minutes later the run summary shows the public IP and
wg.clydeford.net resolves to it. Turn the tunnel on in the WireGuard app.

Optional payload keys: `region`, `vm_size`, `ssh_allowed_cidr` (e.g.
`"86.1.2.3/32"`; without it there is **no SSH rule at all**), `home_lan_cidr`,
`wg_port`, `wg_subnet`.

### Destroy

Same screen, action: `destroy`, payload `{}`. The workflow runs `terraform
destroy`, then double-checks with the Azure CLI that the resource group is gone
and with the Cloudflare API that the DNS record is gone, deleting either by
hand if Terraform missed it. The bill is £0 when the run is green.

### SSH to the VM (if you allowed it)

```sh
ssh -i ~/.ssh/wg-admin-azure_ed25519 azureuser@wg.clydeford.net
sudo wg show
sudo journalctl -t wg-agent
```

## What it costs

| State | Azure cost |
| --- | --- |
| Destroyed | £0.00. Nothing exists. |
| Running | About £8 a month for the B1s VM and 30 GB disk, plus about £2.60 for the static IP, billed per hour. Roughly 1.5p an hour. |

Cloudflare (Worker, D1, KV, R2, Access) and GitHub Actions stay within their
free tiers.

## Repository map

```
infra/                    Terraform: the Azure build and the DNS record
  cloud-init.yaml.tftpl   the VM's first-boot script
  agent/                  the heartbeat script and its systemd units
worker/src/               the dashboard (Cloudflare Worker, TypeScript)
worker/public/            stylesheet, client script, QR library
worker/migrations/        database schema
wrangler.toml             the Worker's bindings, cron and hostname
.github/workflows/wg.yml  the runner: apply or destroy
.github/workflows/ci.yml  checks on every push, no cloud calls
scripts/                  the npm commands (keys, peer, secrets, deploy-worker, dev)
wg-admin-spec.md          the full design
docs/runs/                records of each autonomous build session
```

## Glossary

- **Concentrator / headend**: the VPN server the clients dial into.
- **Loopback**: 10.13.255.1, an address on a dummy interface inside the VM, like
  Loopback0 on a router. Ping it from a connected client: if it answers, the VM
  is routing between interfaces, not just holding the tunnel up.
- **Peer**: WireGuard's word for the other end of a tunnel, client or server.
- **AllowedIPs**: on a client, which destinations go through the tunnel. Split
  tunnel = just the VPN and home ranges. Full tunnel = `0.0.0.0/0`.
- **NSG**: Azure's per-subnet firewall. Ours allows UDP 51820 from anywhere,
  SSH only from an allow-list, and denies everything else inbound.
- **Resource group**: an Azure folder. Deleting it deletes everything inside,
  which is how destroy can never leave a stray VM running.
- **State**: Terraform's record of what it built. Lives in R2, backed up on
  every run.
