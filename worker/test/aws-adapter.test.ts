// The AWS adapter, against the harness's fake AWS.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { makeEnv, type World } from "./harness";
import type { Env } from "../src/env";
import { opsFor } from "../src/cloud";

let env: Env;
let world: World;
beforeEach(() => {
  ({ env, world } = makeEnv());
  world.aws.exists = true;
});
afterEach(() => vi.unstubAllGlobals());
const aws = () => opsFor("aws");

describe("view", () => {
  it("running server: running, with its address", async () => {
    expect(await aws().view(env)).toMatchObject({ rg_exists: true, vm_exists: true, power: "running", public_ip: "18.130.0.10" });
  });
  it("stopped server reads as deallocated, like Azure", async () => {
    world.aws.state = "stopped";
    const v = await aws().view(env);
    expect(v.power).toBe("deallocated");
    expect(v.public_ip).toBeNull(); // the network interface's own addresses are not the server's
  });
  it("nothing built: nothing exists", async () => {
    world.aws.exists = false;
    expect(await aws().view(env)).toMatchObject({ rg_exists: false, vm_exists: false, power: null, public_ip: null });
  });
  it("a leftover tagged Elastic IP alone still counts as something there", async () => {
    world.aws.exists = false;
    world.awsEipLeft = true;
    expect(await aws().view(env)).toMatchObject({ rg_exists: true, vm_exists: false });
  });
  it("view reports an AWS error without throwing", async () => {
    world.awsFail = "RequestLimitExceeded";
    const v = await aws().view(env);
    expect(v.error).toMatch(/fake failure/);
    expect(v.rg_exists).toBe(false);
  });
});

describe("power", () => {
  it("hibernate stops the server, resume starts it", async () => {
    await aws().power(env, "hibernate");
    await aws().power(env, "resume");
    expect(world.powerCalls).toEqual(["deallocate", "start"]);
  });
  it("says AWS refused, with the code", async () => {
    world.awsFail = "UnauthorizedOperation";
    await expect(aws().power(env, "hibernate")).rejects.toThrow(/AWS .*UnauthorizedOperation/);
  });
});

describe("SSH rule", () => {
  it("adds the new SSH source before removing the old", async () => {
    world.aws.sg = [{ id: "sgr-old", protocol: "tcp", port: 22, cidr: "203.0.113.1/32", description: "ssh-from-home" }];
    const order: string[] = [];
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (i: Request, init?: RequestInit) => {
      const body = typeof i === "object" && "clone" in i ? await i.clone().text() : String(init?.body ?? "");
      const a = new URLSearchParams(body).get("Action");
      if (a === "AuthorizeSecurityGroupIngress" || a === "RevokeSecurityGroupIngress") order.push(a);
      return real(i, init);
    });
    await aws().setSshAllowedCidr(env, "198.51.100.7/32");
    expect(order).toEqual(["AuthorizeSecurityGroupIngress", "RevokeSecurityGroupIngress"]);
    expect(world.aws.sg.map((r) => r.cidr)).toEqual(["198.51.100.7/32"]);
  });
  it("does nothing when the rule is already right", async () => {
    world.aws.sg = [{ id: "sgr-1", protocol: "tcp", port: 22, cidr: "198.51.100.7/32", description: "ssh-from-home" }];
    await aws().setSshAllowedCidr(env, "198.51.100.7/32");
    expect(world.aws.sg.map((r) => r.id)).toEqual(["sgr-1"]);
  });
});

describe("published ports", () => {
  it("adds missing rules, drops stale ones, leaves the rest", async () => {
    world.aws.sg = [
      { id: "sgr-wg", protocol: "udp", port: 51820, cidr: "0.0.0.0/0", description: "wireguard" },
      { id: "sgr-80", protocol: "tcp", port: 80, cidr: "0.0.0.0/0", description: "published-tcp-80" },
      { id: "sgr-25", protocol: "tcp", port: 25, cidr: "0.0.0.0/0", description: "published-tcp-25" },
    ];
    await aws().setPublishedPorts(env, [
      { name: "published-tcp-80", protocol: "Tcp", port: "80", source: "*" },
      { name: "published-udp-53", protocol: "Udp", port: "53", source: "192.0.2.0/24" },
    ]);
    expect(world.aws.sg.map((r) => `${r.description}:${r.cidr}`).sort()).toEqual(["published-tcp-80:0.0.0.0/0", "published-udp-53:192.0.2.0/24", "wireguard:0.0.0.0/0"]);
  });
  it("makes no calls when nothing changes", async () => {
    world.aws.sg = [{ id: "sgr-80", protocol: "tcp", port: 80, cidr: "0.0.0.0/0", description: "published-tcp-80" }];
    const before = world.calls.length;
    await aws().setPublishedPorts(env, [{ name: "published-tcp-80", protocol: "Tcp", port: "80", source: "*" }]);
    const writes = world.calls.slice(before).length;
    expect(writes).toBe(2); // DescribeSecurityGroups + DescribeSecurityGroupRules only
  });
});

// A real DescribeSecurityGroupRules answer (masked). EC2 lists each rule's fields alphabetically, so the rule id
// comes near the end of its <item>; reading by "chunk from each id" paired one rule's id with the next rule's fields.
describe("against a recorded DescribeSecurityGroupRules answer", () => {
  const fixture = readFileSync(new URL("./fixtures/aws/describe-sg-rules.xml", import.meta.url), "utf8");
  const WIREGUARD = ["sgr-01ff26f508f46d552", "sgr-016f6bfb58af353c4"];
  let writes: { action: string; params: URLSearchParams }[];
  beforeEach(() => {
    writes = [];
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (i: Request, init?: RequestInit) => {
      const body = typeof i === "object" && "clone" in i ? await i.clone().text() : String(init?.body ?? "");
      const params = new URLSearchParams(body);
      const action = params.get("Action") ?? "";
      if (action === "DescribeSecurityGroupRules") return new Response(fixture, { status: 200 });
      if (action === "AuthorizeSecurityGroupIngress" || action === "RevokeSecurityGroupIngress") writes.push({ action, params });
      return real(i, init);
    });
  });

  it("setSshAllowedCidr to the address already allowed makes no Authorize or Revoke call", async () => {
    await aws().setSshAllowedCidr(env, "203.0.113.7/32");
    expect(writes).toEqual([]);
  });
  it("setSshAllowedCidr to a new address adds it, then revokes only the old ssh-from-home rule", async () => {
    await aws().setSshAllowedCidr(env, "198.51.100.7/32");
    expect(writes.map((w) => w.action)).toEqual(["AuthorizeSecurityGroupIngress", "RevokeSecurityGroupIngress"]);
    expect(writes[0].params.get("IpPermissions.1.IpRanges.1.CidrIp")).toBe("198.51.100.7/32");
    const revoked = [...writes[1].params.entries()].filter(([k]) => k.startsWith("SecurityGroupRuleId.")).map(([, v]) => v);
    expect(revoked).toEqual(["sgr-06731c55055802f63"]);
  });
  it("setPublishedPorts with the rules already there makes no calls", async () => {
    await aws().setPublishedPorts(env, [
      { name: "published-tcp-2230", protocol: "Tcp", port: "2230", source: "*" },
      { name: "published-tcp-8080", protocol: "Tcp", port: "8080", source: "203.0.113.7/32" },
    ]);
    expect(writes).toEqual([]);
  });
  it("removing 8080 revokes exactly that rule, never WireGuard", async () => {
    await aws().setPublishedPorts(env, [{ name: "published-tcp-2230", protocol: "Tcp", port: "2230", source: "*" }]);
    expect(writes.map((w) => w.action)).toEqual(["RevokeSecurityGroupIngress"]);
    const revoked = [...writes[0].params.entries()].filter(([k]) => k.startsWith("SecurityGroupRuleId.")).map(([, v]) => v);
    expect(revoked).toEqual(["sgr-0148109b78d97895e"]);
    expect(revoked.some((id) => WIREGUARD.includes(id))).toBe(false);
  });
});

describe("inventory", () => {
  it("lists tagged resources; the Public IP line starts with the address", async () => {
    const inv = await aws().inventory(env);
    expect(inv.exists).toBe(true);
    expect(inv.resources.find((r) => r.kind === "Public IP")?.detail.split(",")[0]).toBe("18.130.0.10");
    expect(inv.resources.find((r) => r.kind === "Virtual machine")?.detail).toMatch(/t4g\.micro, running/);
  });
  it("nothing built: exists is false", async () => {
    world.aws.exists = false;
    expect((await aws().inventory(env)).exists).toBe(false);
  });
  it("after a clean tear-down the tagging API's ghosts are not leftovers", async () => {
    world.aws.exists = false;
    world.awsGhosts = true;
    const inv = await aws().inventory(env);
    expect(inv.exists).toBe(false);
    expect(inv.resources).toEqual([]);
  });
  it("with a live server the ghosts are dropped and the live instance and disk stay", async () => {
    world.awsGhosts = true;
    const inv = await aws().inventory(env);
    expect(inv.exists).toBe(true);
    const names = inv.resources.map((r) => r.name);
    expect(names).not.toContain("i-dead");
    expect(names).not.toContain("vol-dead");
    expect(names).toContain("i-0abc");
    expect(names).toContain("vol-1");
  });
});
