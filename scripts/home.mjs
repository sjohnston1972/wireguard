// scripts/home.mjs   (npm run home [-- --down])
//
// Plain English: sets up the home end of site-to-site on this PC, in Docker.
//   1. Makes the home site's WireGuard keypair once (kept in .env as
//      HOME_WG_PRIVATE_KEY / HOME_WG_PUBLIC_KEY; the private key never leaves
//      this machine).
//   2. Registers it with the dashboard as the peer "home-site", carrying the
//      home LAN (HOME_LAN_CIDR), so the VM routes 192.168.1.0/24 to it.
//   3. Writes docker/home/wg0.conf and starts the container.
// A running VM picks the new peer up within 30 seconds; a destroyed one gets
// it at the next deploy. Run it again at any time; it changes nothing that is
// already right. "--down" stops the container.
//
// Networking picture: this is provisioning the branch router: give it an
// identity, tell the hub about the branch's LAN, and bring the tunnel up.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { loadEnv } from "./lib/env.mjs";
import { genKeypair, publicKeyFrom, isWgKey } from "./lib/wg.mjs";

const env = loadEnv();
const shell = process.platform === "win32";
const wranglerEnv = { ...process.env, CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID };
const DIR = "docker/home";
const NAME = "home-site";

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", shell, ...opts });
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout);
    process.exit(r.status ?? 1);
  }
  return r.stdout;
}

if (process.argv.includes("--down")) {
  run("docker", ["compose", "-f", `${DIR}/compose.yaml`, "down"], { stdio: "inherit" });
  process.exit(0);
}

// ── 1. Keys ─────────────────────────────────────────────────────────────────
let priv = env.HOME_WG_PRIVATE_KEY;
if (!isWgKey(priv)) {
  priv = genKeypair().privateKey;
  setEnv("HOME_WG_PRIVATE_KEY", priv);
  console.log("made a new home site keypair (private key saved to .env)");
}
const pub = publicKeyFrom(priv);
if (env.HOME_WG_PUBLIC_KEY !== pub) setEnv("HOME_WG_PUBLIC_KEY", pub);

const lan = env.HOME_LAN_CIDR || "192.168.1.0/24";
if (!/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(lan)) throw new Error(`HOME_LAN_CIDR "${lan}" is not a CIDR`);
const serverPub = env.WG_SERVER_PUBLIC_KEY || publicKeyFrom(env.WG_SERVER_PRIVATE_KEY);
const endpoint = `${env.WG_DNS_NAME || "wg.clydeford.net"}:${env.WG_PORT || 51820}`;
const subnet = env.WG_SUBNET || "10.13.13.0/24";
const loopback = env.WG_LOOPBACK_IP || "10.13.255.1";
const vnet = env.AZURE_VNET_CIDR || "10.50.0.0/16";

// ── 2. Register with the dashboard (D1) ─────────────────────────────────────
function d1(sql) {
  const out = run("npx", ["wrangler", "d1", "execute", "wg-admin", "--remote", "--json", "--command", JSON.stringify(sql)], { env: wranglerEnv });
  return JSON.parse(out)[0].results;
}
const peers = d1("SELECT id, name, public_key, ip, routes FROM peers");
let me = peers.find((p) => p.name === NAME || p.public_key === pub);
if (!me) {
  const used = new Set(peers.map((p) => p.ip));
  const base = subnet.split("/")[0].split(".").slice(0, 3).join(".");
  // .10 upwards keeps the site apart from phones and laptops (.2 onwards) in listings.
  let ip = null;
  for (let h = 10; h < 250; h++) if (!used.has(`${base}.${h}`)) { ip = `${base}.${h}`; break; }
  if (!ip) throw new Error("no free tunnel address");
  d1(`INSERT INTO peers (name, public_key, ip, enabled, full_tunnel, azure_vnet, tunnel_dns, routes, home_lan, created_at, note) VALUES ('${NAME}', '${pub}', '${ip}', 1, 0, 0, 0, '${lan}', 0, '${new Date().toISOString()}', 'home site container (npm run home)')`);
  me = { name: NAME, public_key: pub, ip, routes: lan };
  console.log(`registered ${NAME} at ${ip}, carrying ${lan}`);
} else if (me.public_key !== pub || me.routes !== lan || me.name !== NAME) {
  d1(`UPDATE peers SET name = '${NAME}', public_key = '${pub}', routes = '${lan}', enabled = 1 WHERE id = ${me.id}`);
  console.log(`updated ${NAME} (${me.ip})`);
} else {
  console.log(`${NAME} already registered at ${me.ip}`);
}

// ── 3. Container config and start ───────────────────────────────────────────
// AllowedIPs: everything that should come back through the tunnel: the
// tunnel itself, the VM loopback, and the Azure VNet (for workloads there).
writeFileSync(
  `${DIR}/wg0.conf`,
  `# Written by "npm run home". Holds the home site private key: never commit.
[Interface]
PrivateKey = ${priv}
Address = ${me.ip}/32
# NAT tunnel traffic onto the home network, like "ip nat inside" on a branch router.
PostUp = iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE; iptables -A FORWARD -i %i -j ACCEPT; iptables -A FORWARD -o %i -j ACCEPT
PostDown = iptables -t nat -D POSTROUTING -o eth0 -j MASQUERADE; iptables -D FORWARD -i %i -j ACCEPT; iptables -D FORWARD -o %i -j ACCEPT

[Peer]
PublicKey = ${serverPub}
Endpoint = ${endpoint}
AllowedIPs = ${subnet}, ${loopback}/32, ${vnet}
PersistentKeepalive = 25
`,
  { mode: 0o600 }
);
run("docker", ["compose", "-f", `${DIR}/compose.yaml`, "up", "-d", "--build"], { stdio: "inherit" });
console.log(`\nHome site running in Docker as "wg-home" (${me.ip}, carrying ${lan}).`);
console.log("A running VM picks it up within 30 seconds; otherwise at the next deploy.");

function setEnv(key, value) {
  let s = readFileSync(".env", "utf8");
  const re = new RegExp(`^${key}=.*$`, "m");
  s = re.test(s) ? s.replace(re, `${key}=${value}`) : `${s.replace(/\s*$/, "\n")}${key}=${value}\n`;
  writeFileSync(".env", s);
}
