// cloud-init-size.test.ts
//
// Plain English: Azure refuses a VM whose custom data (the cloud-init) is
// over 64 KB. The limit is on the decoded bytes: the API takes a base64
// string and "the maximum length of the binary array is 65535 bytes"
// (OSProfile.customData). main.tf sends base64encode(local.cloud_init), so
// what counts is the rendered cloud-init itself. The big parts travel
// gzipped (wg-agent.sh, wg-vitals.sh and the firewall rule set; cloud-init's
// gz+b64 encoding unpacks them on the VM). This renders the real
// template, the way main.tf does, for a realistic worst case (25 clients
// with IPv6 and site routes, 40 firewall rules, 10 published ports, long
// names, an SSH password) and fails above 58 KB, leaving room to grow before
// a deploy could ever be refused. CI runs it with the rest of the suite (the
// Terraform job renders the same template with one peer and checks the YAML).
//
// The renderer below knows only what the template uses: ${name},
// ${indent(N, name)}, $${ (a literal dollar-brace) and %{ if name != "" }
// blocks, with or without the ~ strip marker. Anything else throws, so a new
// construct in the template is noticed here rather than mis-measured.
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { config, type Env } from "../src/env";
import { compileFirewall, type Forward, type FwRule } from "../src/firewall";
import type { Peer } from "../src/db";

/** Azure's limit on the decoded custom data, and this project's ceiling under it. */
const AZURE_LIMIT = 65_535;
const CEILING = 58 * 1024;

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
/** Terraform's base64gzip: gzip, then base64 (Go's gzip, so a few bytes off zlib's; the margin covers it). */
const b64gzip = (s: string) => gzipSync(Buffer.from(s, "utf8"), { level: 9 }).toString("base64");

/** Terraform's indent(n, s): every line but the first gains n spaces. */
const indent = (n: number, s: string) => s.replace(/\n/g, "\n" + " ".repeat(n));

export function renderTemplate(tpl: string, vars: Record<string, string | number>): string {
  const val = (name: string) => {
    if (!(name in vars)) throw new Error(`template variable ${name} not given`);
    return String(vars[name]);
  };
  const cond = (name: string) => val(name) !== "";
  let out = tpl
    // %{ if x != "" ~} ... %{ endif ~}: the directive lines vanish (the ~ eats the newline after each).
    .replace(/%\{ if (\w+) != "" ~\}\s*([\s\S]*?)%\{ endif ~\}\s*/g, (_m, name: string, body: string) => (cond(name) ? body : ""))
    // %{ if x != "" } ... %{ endif } inside a line.
    .replace(/%\{ if (\w+) != "" \}([\s\S]*?)%\{ endif \}/g, (_m, name: string, body: string) => (cond(name) ? body : ""));
  if (/%\{/.test(out.replace(/%%\{/g, ""))) throw new Error("a template directive this renderer does not know");
  out = out.replace(/\$\$\{|\$\{([^}]*)\}/g, (m, expr: string | undefined) => {
    if (m === "$${") return "${";
    const e = expr!.trim();
    if (/^\w+$/.test(e)) return val(e);
    const ind = /^indent\((\d+),\s*(\w+)\)$/.exec(e);
    if (ind) return indent(Number(ind[1]), val(ind[2]!));
    throw new Error(`a template expression this renderer does not know: ${e}`);
  });
  return out;
}

const cfg = { ...config({ WG_SUBNET6: "fd13:13::/64", HOME_LAN_CIDR: "192.168.1.0/24", PUBLIC_URL: "https://wg-admin.example.net" } as unknown as Env), firewallDefault: "deny" as const };

/** 25 clients with 32-character names (the longest allowed); every fifth is a site with three LAN routes. */
function worstPeers(): Peer[] {
  return Array.from({ length: 25 }, (_, i) => {
    const n = i + 2;
    const key = (String.fromCharCode(65 + (i % 26)) + "x".repeat(42)).slice(0, 43) + "=";
    return {
      id: i + 1,
      name: `Client device number ${String(n).padStart(2, "0")} abcdefg`.slice(0, 32),
      public_key: key,
      ip: `10.13.13.${n}`,
      enabled: 1,
      full_tunnel: 1,
      azure_vnet: 1,
      tunnel_dns: 1,
      routes: i % 5 === 0 ? `192.168.${100 + i}.0/24,172.20.${i}.0/24,10.${100 + i}.0.0/16` : "",
      home_lan: 1,
      created_at: "2026-10-01T00:00:00.000Z",
      note: null,
    };
  });
}

/** 40 rules with 60-character names (the longest allowed): client to address, ports, zones, logging. */
function worstRules(peers: Peer[]): FwRule[] {
  return Array.from({ length: 40 }, (_, i) => ({
    id: i + 1,
    position: (i + 1) * 10,
    enabled: 1,
    name: `Rule ${String(i + 1).padStart(2, "0")} allows a client to reach a server behind the VPN`.padEnd(60, "x").slice(0, 60),
    src_kind: i % 3 === 0 ? "zone" : "client",
    src_value: i % 3 === 0 ? "clients" : String(peers[i % peers.length]!.id),
    dst_kind: i % 4 === 0 ? "zone" : "cidr",
    dst_value: i % 4 === 0 ? "workloads" : `10.50.${i % 8}.${10 + i}/32`,
    proto: i % 2 === 0 ? "tcp" : "udp",
    ports: `${1000 + i},${2000 + i}-${2100 + i},${3000 + i}`,
    action: i % 7 === 0 ? "deny" : "allow",
    log: i % 2,
  }));
}

/** 10 published ports with long names, each limited to a source network. */
function worstForwards(): Forward[] {
  return Array.from({ length: 10 }, (_, i) => ({
    id: i + 1,
    enabled: 1,
    name: `Published service number ${i + 1} for the home lab`,
    proto: i % 2 === 0 ? "tcp" : "udp",
    public_port: 8000 + i,
    target_ip: `10.50.2.${20 + i}`,
    target_port: 443,
    allow_from: `198.51.100.${i * 8}/29`,
  }));
}

/** main.tf's peers_conf: one [Peer] block per client, the name in a comment, IPv6 and site routes in AllowedIPs. */
function peersConf(peers: Peer[]): string {
  if (!peers.length) return "# no peers yet\n";
  return peers
    .map((p) => {
      const v6 = `fd13:13::${Number(p.ip.split(".")[3]).toString(16)}`;
      return `# ${p.name.replace(/[^A-Za-z0-9 _.-]/g, "?")}\n[Peer]\nPublicKey = ${p.public_key}\nAllowedIPs = ${p.ip}/32,${v6}/128${p.routes ? `,${p.routes}` : ""}\n`;
    })
    .join("\n");
}

/** What main.tf passes to templatefile(), for these clients and this rule set. */
async function worstVars(): Promise<Record<string, string | number>> {
  const peers = worstPeers();
  const fw = await compileFirewall(worstRules(peers), cfg, peers, "deny", worstForwards());
  const agent = (f: string) => read(`infra/agent/${f}`);
  return {
    wg_server_private_key: "S".repeat(43) + "=",
    wg_server_ip: "10.13.13.1",
    wg_prefix_len: "24",
    wg_server_ip6: "fd13:13::1",
    wg_prefix_len6: "64",
    wg_port: 51820,
    loopback_ip: cfg.loopbackIp,
    ssh_password: "correct-horse-battery-staple-42",
    peers_conf: peersConf(peers),
    agent_url: `${cfg.publicUrl}/api/agent`,
    agent_token: "t".repeat(64),
    agent_script_gz: b64gzip(agent("wg-agent.sh")),
    agent_service: agent("wg-agent.service"),
    agent_timer: agent("wg-agent.timer"),
    selftest_script: agent("wg-selftest.sh"),
    selftest_service: agent("wg-selftest.service"),
    blocklist_script: agent("wg-blocklist.sh"),
    blocklist_service: agent("wg-blocklist.service"),
    speedtest_script: agent("wg-speedtest.sh"),
    capture_script: agent("wg-capture.sh"),
    firewall_load_script: agent("wg-firewall-load.sh"),
    vnet_cidr: cfg.vnetCidr,
    firewall_nft_gz: b64gzip(fw.text),
    vitals_script_gz: b64gzip(agent("wg-vitals.sh")),
  };
}

describe("the VM's cloud-init stays inside Azure's custom data limit", () => {
  const tpl = read("infra/cloud-init.yaml.tftpl");
  const mainTf = read("infra/main.tf");

  it("the renderer follows the template: conditions, indent and literal dollar-braces", () => {
    const t = '#a\n%{ if p != "" ~}\npw: ${p}\n%{ endif ~}\nx: A%{ if q != "" }, ${q}%{ endif }\n  c: |\n    ${indent(4, s)}\nlit: $${1:-}\n';
    expect(renderTemplate(t, { p: "pw1", q: "", s: "l1\nl2" })).toBe("#a\npw: pw1\nx: A\n  c: |\n    l1\n    l2\nlit: ${1:-}\n");
    expect(renderTemplate(t, { p: "", q: "v6", s: "l1" })).toBe("#a\nx: A, v6\n  c: |\n    l1\nlit: ${1:-}\n");
    expect(() => renderTemplate("${upper(x)}", { x: "a" })).toThrow(/does not know/);
  });

  it("main.tf passes every variable the template names (and wg-agent.sh gzipped)", () => {
    const names = new Set([...tpl.matchAll(/(?<!\$)\$\{(?:indent\(\d+,\s*)?(\w+)\)?\}/g)].map((m) => m[1]!));
    names.add("ssh_password").add("wg_server_ip6");
    const at = mainTf.indexOf('cloud_init = templatefile("${path.module}/cloud-init.yaml.tftpl", {');
    const call = mainTf.slice(at, mainTf.indexOf("\n  })\n", at));
    for (const n of names) expect(call, n).toMatch(new RegExp(`\\n    ${n}\\s+=`));
    expect(call).toMatch(/\n    agent_script_gz\s+= base64gzip\(file\("\$\{path\.module\}\/agent\/wg-agent\.sh"\)\)\n/);
    // The Worker's rule set arrives as base64 (var.firewall_nft_b64); it is unpacked and gzipped, or the open set when none.
    expect(call).toMatch(/\n    firewall_nft_gz\s+= base64gzip\(var\.firewall_nft_b64 != "" \? base64decode\(var\.firewall_nft_b64\) : file\("\$\{path\.module\}\/agent\/firewall-open\.nft"\)\)\n/);
  });

  it("cloud-init writes /etc/wg-admin/firewall.nft 0600, gzipped (40 rules are about 18 KB as plain base64)", () => {
    expect(tpl).toMatch(/  - path: \/etc\/wg-admin\/firewall\.nft\n    permissions: "0600"\n    owner: root:root\n    encoding: gz\+b64\n    content: \$\{firewall_nft_gz\}\n/);
  });

  it("cloud-init writes /usr/local/sbin/wg-agent.sh 0755, gzipped like wg-vitals.sh", () => {
    expect(tpl).toMatch(/  - path: \/usr\/local\/sbin\/wg-agent\.sh\n    permissions: "0755"\n    owner: root:root\n    encoding: gz\+b64\n    content: \$\{agent_script_gz\}\n/);
    // The gzipped content decodes back to the script exactly (cloud-init's gz+b64 path: base64, then gunzip).
    const script = read("infra/agent/wg-agent.sh");
    expect(gunzipSync(Buffer.from(b64gzip(script), "base64")).toString("utf8")).toBe(script);
  });

  it("the worst case renders under 58 KB (Azure refuses over 65,535 bytes)", async () => {
    const vars = await worstVars();
    const out = renderTemplate(tpl, vars);
    // CLOUD_INIT_DUMP=<dir> writes the inputs and this render, to compare with
    // terraform's own: templatefile("cloud-init.yaml.tftpl", jsondecode(file("vars.json"))).
    const dump = process.env.CLOUD_INIT_DUMP;
    if (dump) {
      writeFileSync(`${dump}/vars.json`, JSON.stringify(vars));
      writeFileSync(`${dump}/rendered-js.yaml`, out);
    }
    const bytes = Buffer.byteLength(out, "utf8");
    const customData = b64(out).length;
    console.log(`cloud-init worst case: ${bytes} bytes rendered (limit ${AZURE_LIMIT}, ceiling ${CEILING}); custom_data ${customData} base64 characters`);
    expect(out).toContain("PrivateKey = " + "S".repeat(43) + "=");
    expect(out).not.toMatch(/\$\{(indent|wg_|agent_|peers_)/);
    expect(bytes).toBeLessThanOrEqual(CEILING);
    expect(bytes).toBeLessThan(AZURE_LIMIT);
  });
});
