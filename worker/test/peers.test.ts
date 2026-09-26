import { describe, it, expect } from "vitest";
import { nextFreeIp, serverTunnelIp, clientConfigTemplate, agentPeerList, terraformPeerList, validPeerName, isWgKey, serverPublicKey, peerIp6, hostLabel, PRIVATE_KEY_PLACEHOLDER, protectedNets, routeProblem, v4Overlap } from "../src/peers";
import type { Env } from "../src/env";
import type { Peer } from "../src/db";

const env = {
  WG_DNS_NAME: "wg.clydeford.net",
  WG_PORT: "51820",
  WG_SUBNET: "10.13.13.0/24",
  AZURE_VNET_CIDR: "10.50.0.0/16",
  WG_SUBNET6: "fd13:13::/64",
  // RFC 7748 §6.1 Alice's public key, base64. The Worker only ever holds the public half.
  WG_SERVER_PUBLIC_KEY: Buffer.from("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a", "hex").toString("base64"),
} as unknown as Env;

/** The same settings with IPv6 switched off. */
const env4 = { ...env, WG_SUBNET6: "" } as unknown as Env;

describe("nextFreeIp", () => {
  it("starts at .2 and skips used addresses", () => {
    expect(nextFreeIp("10.13.13.0/24", [])).toBe("10.13.13.2");
    expect(nextFreeIp("10.13.13.0/24", ["10.13.13.2", "10.13.13.3"])).toBe("10.13.13.4");
  });
  it("returns null when the subnet is full", () => {
    const used = Array.from({ length: 253 }, (_, i) => `10.13.13.${i + 2}`);
    expect(nextFreeIp("10.13.13.0/24", used)).toBeNull();
  });
  it("server takes .1", () => {
    expect(serverTunnelIp("10.13.13.0/24")).toBe("10.13.13.1");
  });
});

describe("clientConfigTemplate", () => {
  it("uses the DNS endpoint and a private-key placeholder", () => {
    const t = clientConfigTemplate(env, { ip: "10.13.13.7", full_tunnel: 0 }, "SERVERPUB=");
    expect(t).toContain(`PrivateKey = ${PRIVATE_KEY_PLACEHOLDER}`);
    expect(t).toContain("Endpoint = wg.clydeford.net:51820");
    expect(t).toContain("AllowedIPs = 10.13.13.0/24, 10.13.255.1/32, fd13:13::/64");
    expect(t).not.toContain("DNS =");
  });
  it("gives every client an IPv6 tunnel address that mirrors the IPv4 one", () => {
    expect(clientConfigTemplate(env, { ip: "10.13.13.7", full_tunnel: 0 }, "S=")).toContain("Address = 10.13.13.7/32, fd13:13::7/128");
    expect(clientConfigTemplate(env, { ip: "10.13.13.13", full_tunnel: 0 }, "S=")).toContain("Address = 10.13.13.13/32, fd13:13::d/128");
    const v4 = clientConfigTemplate(env4, { ip: "10.13.13.7", full_tunnel: 0 }, "S=");
    expect(v4).toContain("Address = 10.13.13.7/32\n");
    expect(v4).toContain("AllowedIPs = 10.13.13.0/24, 10.13.255.1/32\n");
  });
  it("split tunnel uses the tunnel DNS only when asked", () => {
    const t = clientConfigTemplate(env, { ip: "10.13.13.7", full_tunnel: 0, tunnel_dns: 1 }, "S=");
    expect(t).toContain("DNS = 10.13.255.1, wg");
  });
  it("split tunnel includes the loopback, and the Azure VNet only when asked", () => {
    const plain = clientConfigTemplate(env, { ip: "10.13.13.7", full_tunnel: 0 }, "SERVERPUB=");
    expect(plain).toContain("AllowedIPs = 10.13.13.0/24, 10.13.255.1/32, fd13:13::/64");
    expect(plain).not.toContain("10.50.0.0/16");
    const vnet = clientConfigTemplate(env, { ip: "10.13.13.7", full_tunnel: 0, azure_vnet: 1 }, "SERVERPUB=");
    expect(vnet).toContain("AllowedIPs = 10.13.13.0/24, 10.13.255.1/32, fd13:13::/64, 10.50.0.0/16");
  });
  it("full tunnel routes everything and always uses the tunnel DNS", () => {
    const t = clientConfigTemplate(env, { ip: "10.13.13.7", full_tunnel: 1 }, "SERVERPUB=");
    expect(t).toContain("AllowedIPs = 0.0.0.0/0, ::/0");
    expect(t).toContain("DNS = 10.13.255.1, wg");
  });
});

describe("peer lists", () => {
  const peers: Peer[] = [
    { id: 1, name: "Steven's Phone", public_key: "A=", ip: "10.13.13.2", enabled: 1, full_tunnel: 0, azure_vnet: 0, tunnel_dns: 0, routes: "", home_lan: 0, created_at: "", note: null },
    { id: 2, name: "b", public_key: "B=", ip: "10.13.13.3", enabled: 0, full_tunnel: 0, azure_vnet: 0, tunnel_dns: 0, routes: "", home_lan: 0, created_at: "", note: null },
  ];
  it("only enabled peers reach the VM and Terraform, with IPv6 and a DNS name", () => {
    expect(agentPeerList(peers, "fd13:13::/64")).toEqual([{ name: "Steven's Phone", host: "steven-s-phone", public_key: "A=", allowed_ips: "10.13.13.2/32,fd13:13::2/128" }]);
    expect(agentPeerList(peers)).toEqual([{ name: "Steven's Phone", host: "steven-s-phone", public_key: "A=", allowed_ips: "10.13.13.2/32" }]);
    expect(terraformPeerList(peers)).toEqual([{ name: "Steven's Phone", public_key: "A=", ip: "10.13.13.2" }]);
  });
  it("a site peer also carries its LAN, on the VM and in Terraform", () => {
    const site: Peer = { ...peers[0], name: "home-site", public_key: "H=", ip: "10.13.13.10", routes: "192.168.1.0/24, junk" };
    expect(agentPeerList([site], "fd13:13::/64")[0].allowed_ips).toBe("10.13.13.10/32,fd13:13::a/128,192.168.1.0/24");
    expect(terraformPeerList([site])[0]).toEqual({ name: "home-site", public_key: "H=", ip: "10.13.13.10", routes: "192.168.1.0/24" });
  });
  it("a site route can never cut the VM off: nothing wider than /8, nothing over the tunnel or the VNet", () => {
    const avoid = protectedNets({ subnet: "10.13.13.0/24", loopbackIp: "10.13.255.1", vnetCidr: "10.50.0.0/16" });
    expect(avoid).toEqual(["10.13.13.0/24", "10.13.255.1/32", "10.50.0.0/16"]);
    expect(routeProblem("0.0.0.0/0", avoid)).toMatch(/wider than \/8/);
    expect(routeProblem("128.0.0.0/1", avoid)).toMatch(/wider than \/8/);
    expect(routeProblem("10.0.0.0/8", avoid)).toMatch(/overlaps 10\.13\.13\.0\/24/);
    expect(routeProblem("10.50.2.0/24", avoid)).toMatch(/overlaps 10\.50\.0\.0\/16/);
    expect(routeProblem("10.13.255.1/32", avoid)).toMatch(/overlaps/);
    expect(routeProblem("192.168.1.0/24", avoid)).toBeNull();
    expect(routeProblem("11.0.0.0/8", avoid)).toBeNull();
    expect(routeProblem("300.1.1.0/24", avoid)).toMatch(/not an IPv4/);
    expect(v4Overlap("192.168.0.0/16", "192.168.1.0/24")).toBe(true);
    expect(v4Overlap("192.168.2.0/24", "192.168.1.0/24")).toBe(false);
    const site: Peer = { ...peers[0], name: "home-site", public_key: "H=", ip: "10.13.13.10", routes: "0.0.0.0/0, 10.50.0.0/16, 192.168.1.0/24, 128.0.0.0/1" };
    expect(agentPeerList([site], "", avoid)[0].allowed_ips).toBe("10.13.13.10/32,192.168.1.0/24");
    expect(terraformPeerList([site], avoid)[0].routes).toBe("192.168.1.0/24");
    // Even without the overlap list, the too-wide ones never get through.
    expect(terraformPeerList([site])[0].routes).toBe("10.50.0.0/16,192.168.1.0/24");
  });
  it("a client can route the home LAN into the tunnel", () => {
    const e = { ...env, HOME_LAN_CIDR: "192.168.1.0/24" } as unknown as Env;
    expect(clientConfigTemplate(e, { ip: "10.13.13.7", full_tunnel: 0, home_lan: 1 }, "S=")).toContain("fd13:13::/64, 192.168.1.0/24");
    expect(clientConfigTemplate(e, { ip: "10.13.13.7", full_tunnel: 0 }, "S=")).not.toContain("192.168.1.0/24");
  });
});

describe("validation", () => {
  it("names", () => {
    expect(validPeerName("Steven's phone")).toBe(false);
    expect(validPeerName("Stevens phone")).toBe(true);
    expect(validPeerName("")).toBe(false);
    expect(validPeerName("a".repeat(33))).toBe(false);
  });
  it("keys", () => {
    expect(isWgKey("wapbe4SDSmZoefARMVLSAR2KHjjCU3DJ3McGiXQ+3yc=")).toBe(true);
    expect(isWgKey("nope")).toBe(false);
  });
});

describe("serverPublicKey", () => {
  it("matches the RFC 7748 vector", async () => {
    const pub = await serverPublicKey(env);
    expect(pub).toBe(Buffer.from("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a", "hex").toString("base64"));
  });
  it("is null when unset", async () => {
    expect(await serverPublicKey({} as Env)).toBeNull();
  });
});
