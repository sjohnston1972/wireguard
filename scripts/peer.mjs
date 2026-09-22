// scripts/peer.mjs   (npm run peer -- --name laptop [--ip 10.13.13.2] [--full])
//
// Plain English: makes a client (a laptop or phone) for the tunnel, on this
// machine, without the Worker. Used for the Phase 1 manual test and as a
// fallback if the dashboard is ever down. The client's private key is written
// only to peers/<name>.conf (gitignored). Two things are printed:
//
//   1. the JSON line to put in the workflow's payload "peers_json" so the VM
//      knows about this client, and
//   2. the path of the .conf to import into the WireGuard app.
//
// In Phase 3 the dashboard does this in the browser instead.

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { loadEnv } from "./lib/env.mjs";
import { genKeypair, publicKeyFrom, isWgKey, renderClientConf } from "./lib/wg.mjs";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}

const name = arg("name");
if (!name || !/^[a-z0-9-]{1,32}$/i.test(name)) {
  console.error("usage: npm run peer -- --name <letters-digits-dashes> [--ip 10.13.13.2] [--full]");
  process.exit(2);
}
const ip = arg("ip", "10.13.13.2");
const fullTunnel = process.argv.includes("--full");
// --home adds the home LAN to AllowedIPs. Only right for a client that is
// AWAY from home once site-to-site (backlog item 7) exists; on a device that
// is on the home LAN it would black-hole local traffic. Off by default.
const viaHome = process.argv.includes("--home");

const env = loadEnv();
if (!isWgKey(env.WG_SERVER_PRIVATE_KEY)) {
  console.error("WG_SERVER_PRIVATE_KEY missing or invalid in .env. Run: npm run keys");
  process.exit(1);
}

const serverPublicKey = publicKeyFrom(env.WG_SERVER_PRIVATE_KEY);
const serverIp = env.WG_SUBNET.replace(/\.\d+\/\d+$/, ".1");
const client = genKeypair();

const conf = renderClientConf({
  clientPrivateKey: client.privateKey,
  clientIp: ip,
  serverPublicKey,
  endpoint: `${env.WG_DNS_NAME}:${env.WG_PORT}`,
  serverIp,
  tunnelCidr: env.WG_SUBNET,
  loopbackIp: env.WG_LOOPBACK_IP || "10.13.255.1",
  homeLanCidr: viaHome ? env.HOME_LAN_CIDR || undefined : undefined,
  fullTunnel,
});

mkdirSync("peers", { recursive: true });
const out = `peers/${name}${fullTunnel ? "-full" : ""}.conf`;
if (existsSync(out)) {
  console.error(`${out} already exists. Pick another --name or delete it first.`);
  process.exit(1);
}
writeFileSync(out, conf, { mode: 0o600 });

const peerEntry = { name, public_key: client.publicKey, ip };
console.log(`Client config written to ${out}  (import this into the WireGuard app; keep it private)`);
console.log("");
console.log("Add this object to peers_json in the workflow payload:");
console.log(JSON.stringify(peerEntry));
console.log("");
console.log("Whole payload for a manual run with just this client:");
console.log(JSON.stringify({ peers_json: JSON.stringify([peerEntry]) }));
