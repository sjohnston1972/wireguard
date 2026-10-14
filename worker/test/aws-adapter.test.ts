// The AWS adapter, against the harness's fake AWS.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
    expect((await aws().view(env)).power).toBe("deallocated");
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
});
