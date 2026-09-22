import { describe, it, expect } from "vitest";
import { nextFreeIp, serverTunnelIp, clientConfigTemplate, agentPeerList, terraformPeerList, validPeerName, isWgKey, serverPublicKey, PRIVATE_KEY_PLACEHOLDER } from "../src/peers";
import type { Env } from "../src/env";
import type { Peer } from "../src/db";

const env = {
  WG_DNS_NAME: "wg.clydeford.net",
  WG_PORT: "51820",
  WG_SUBNET: "10.13.13.0/24",
  AZURE_VNET_CIDR: "10.50.0.0/16",
  // RFC 7748 §6.1 Alice's private key, base64
  WG_SERVER_PRIVATE_KEY: Buffer.from("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a", "hex").toString("base64"),
} as unknown as Env;

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
    expect(t).toContain("AllowedIPs = 10.13.13.0/24, 10.13.255.1/32");
    expect(t).not.toContain("DNS =");
  });
  it("split tunnel includes the loopback, and the Azure VNet only when asked", () => {
    const plain = clientConfigTemplate(env, { ip: "10.13.13.7", full_tunnel: 0 }, "SERVERPUB=");
    expect(plain).toContain("AllowedIPs = 10.13.13.0/24, 10.13.255.1/32");
    expect(plain).not.toContain("10.50.0.0/16");
    const vnet = clientConfigTemplate(env, { ip: "10.13.13.7", full_tunnel: 0, azure_vnet: 1 }, "SERVERPUB=");
    expect(vnet).toContain("AllowedIPs = 10.13.13.0/24, 10.13.255.1/32, 10.50.0.0/16");
  });
  it("full tunnel routes everything and pushes DNS", () => {
    const t = clientConfigTemplate(env, { ip: "10.13.13.7", full_tunnel: 1 }, "SERVERPUB=");
    expect(t).toContain("AllowedIPs = 0.0.0.0/0, ::/0");
    expect(t).toContain("DNS = 1.1.1.1");
  });
});

describe("peer lists", () => {
  const peers: Peer[] = [
    { id: 1, name: "a", public_key: "A=", ip: "10.13.13.2", enabled: 1, full_tunnel: 0, azure_vnet: 0, created_at: "", note: null },
    { id: 2, name: "b", public_key: "B=", ip: "10.13.13.3", enabled: 0, full_tunnel: 0, azure_vnet: 0, created_at: "", note: null },
  ];
  it("only enabled peers reach the VM and Terraform", () => {
    expect(agentPeerList(peers)).toEqual([{ name: "a", public_key: "A=", allowed_ips: "10.13.13.2/32" }]);
    expect(terraformPeerList(peers)).toEqual([{ name: "a", public_key: "A=", ip: "10.13.13.2" }]);
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
