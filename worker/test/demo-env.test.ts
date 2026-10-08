// demo-env.test.ts
//
// Plain English: the demo environment is the only "env" the app's code ever
// sees while it serves demo data (demo mode spec §3 ruling 3). It is built
// from an allow-list: the plain settings from wrangler.toml's [vars] and the
// demo store's own look-alike bindings. No secret, no real binding, no login
// bypass can get in, so nothing running for a demo person can reach Azure,
// GitHub, DNS, push or the real data. A mark only code can set (a Symbol)
// says "this is the demo"; the dev stand-ins and the topology cache read it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { makeEnv, sqliteLike } from "./harness";
import { DEMO_MARK, DEMO_VARS, isDemoEnv, makeDemoEnv } from "../src/demo/env";
import { WriteMeter, ensureFacadeTables } from "../src/demo/sql";
import { SECRET_GROUPS, missingSecrets, canAzure, canDispatch, canDns, type Env } from "../src/env";
import { standInsAllowed, devSeeded, DEVSEED_KV } from "../src/devmarks";
import { topologyCacheKey } from "../src/labs/topology";

/** The keys of wrangler.toml's [vars] table. */
function tomlVars(): string[] {
  const toml = readFileSync(new URL("../../wrangler.toml", import.meta.url), "utf8").replace(/\r\n?/g, "\n");
  const start = toml.indexOf("\n[vars]\n");
  expect(start).toBeGreaterThan(-1);
  const rest = toml.slice(start + "\n[vars]\n".length);
  const end = rest.search(/^\[/m);
  const body = end === -1 ? rest : rest.slice(0, end);
  return [...body.matchAll(/^([A-Z0-9_]+)\s*=/gm)].map((m) => m[1]);
}

/** A real-looking env: every secret set, plus the bypass, so anything copied across would show. */
function fullEnv(): Env {
  const { env } = makeEnv({
    AUTH_DEV_BYPASS: "1",
    CF_ACCESS_TEAM_DOMAIN: "team.example.com",
    CF_ACCESS_AUD: "aud",
    CF_ACCESS_ALLOWED_EMAIL: "someone@example.com",
    CLOUDFLARE_DNS_TOKEN: "dns-token",
    CLOUDFLARE_ZONE_ID: "zone",
    NOTIFY_TOKEN: "ntfy",
    VAPID_PRIVATE_KEY: "vapid-private",
    VAPID_PUBLIC_KEY: "vapid-public",
    GITHUB_WORKFLOW: "wg.yml",
  });
  (env as unknown as Record<string, unknown>).ASSETS = { fetch: () => new Response("assets") };
  (env as unknown as Record<string, unknown>).DEMO_STORE = { idFromName: () => "demo" };
  return env;
}

function demoOf(src: Env): Env {
  const sql = sqliteLike();
  ensureFacadeTables(sql);
  return makeDemoEnv(src, sql, new WriteMeter());
}

describe("DEMO_VARS", () => {
  it("equals the keys of wrangler.toml [vars]", () => {
    expect([...DEMO_VARS].sort()).toEqual(tomlVars().sort());
    expect(DEMO_VARS.length).toBeGreaterThan(20);
  });
});

describe("makeDemoEnv", () => {
  it("copies only DEMO_VARS (as strings) and adds the four demo bindings", () => {
    const real = fullEnv();
    const demo = demoOf(real);
    const keys = Object.keys(demo).sort();
    expect(keys).toEqual([...DEMO_VARS.filter((k) => typeof (real as unknown as Record<string, unknown>)[k] === "string"), "DB", "STATUS", "STATE", "RUN_LOCK"].sort());
    for (const k of DEMO_VARS) if (k in demo) expect((demo as unknown as Record<string, unknown>)[k]).toBe((real as unknown as Record<string, unknown>)[k]);
    expect(demo.DB).not.toBe(real.DB);
    expect(demo.STATUS).not.toBe(real.STATUS);
    expect(demo.STATE).not.toBe(real.STATE);
    expect(demo.RUN_LOCK).not.toBe(real.RUN_LOCK);
  });

  it("has no secret (bar the public server key, a plain var), no CF_ACCESS_*, NOTIFY_*, VAPID_PRIVATE_KEY, AUTH_DEV_BYPASS, ASSETS or DEMO_STORE", () => {
    const demo = demoOf(fullEnv()) as unknown as Record<string, unknown>;
    const vars = new Set<string>(DEMO_VARS);
    for (const k of Object.values(SECRET_GROUPS).flat()) if (!vars.has(k)) expect(demo, k).not.toHaveProperty(k);
    for (const k of Object.keys(demo)) {
      expect(k).not.toMatch(/^CF_ACCESS_|^NOTIFY_|^AZURE_CLIENT|^AZURE_TENANT|^AZURE_SUBSCRIPTION|^GITHUB_|^CLOUDFLARE_/);
    }
    for (const k of ["VAPID_PRIVATE_KEY", "AUTH_DEV_BYPASS", "ASSETS", "DEMO_STORE", "GITHUB_TOKEN", "AZURE_CLIENT_SECRET"]) expect(demo, k).not.toHaveProperty(k);
    // The public server key is configuration, not a secret (spec §12): it is a [vars] entry.
    expect(vars.has("WG_SERVER_PUBLIC_KEY")).toBe(true);
  });

  it("never reads a real binding (only the [vars] by name)", () => {
    const touched: string[] = [];
    const src = new Proxy(fullEnv() as unknown as Record<string, unknown>, {
      get(t, k) {
        if (typeof k === "string") touched.push(k);
        return t[k as string];
      },
      ownKeys() {
        throw new Error("the demo env must not enumerate the real env");
      },
    });
    demoOf(src as unknown as Env);
    expect(touched.filter((k) => !(DEMO_VARS as readonly string[]).includes(k))).toEqual([]);
  });
});

describe("isDemoEnv", () => {
  it("is true for a demo env, and survives { ...env }", () => {
    const demo = demoOf(fullEnv());
    expect(isDemoEnv(demo)).toBe(true);
    expect(isDemoEnv({ ...demo })).toBe(true);
  });
  it("is false for a real env, and for one with a string DEMO_MARK key (configuration cannot set it)", () => {
    expect(isDemoEnv(fullEnv())).toBe(false);
    expect(isDemoEnv({ ...fullEnv(), DEMO_MARK: true } as unknown as Env)).toBe(false);
    expect(isDemoEnv({ ...fullEnv(), DEMO_MARK: "1" } as unknown as Env)).toBe(false);
    expect(typeof DEMO_MARK).toBe("symbol");
  });
});

describe("capabilities in a demo env", () => {
  it("canAzure, canDispatch and canDns are false, whatever the real env holds", () => {
    const real = fullEnv();
    expect(canAzure(real) && canDispatch(real) && canDns(real)).toBe(true);
    const demo = demoOf(real);
    expect(canAzure(demo)).toBe(false);
    expect(canDispatch(demo)).toBe(false);
    expect(canDns(demo)).toBe(false);
  });
  it("missingSecrets is {} in a demo env (no setup checklist over the demo) and unchanged for a real one", () => {
    expect(missingSecrets(demoOf(fullEnv()))).toEqual({});
    const { env } = makeEnv({ GITHUB_TOKEN: "" });
    expect(Object.keys(missingSecrets(env))).toContain("Deploy and destroy (GitHub Actions)");
    expect(Object.keys(missingSecrets(env))).toContain("Login (Cloudflare Access)");
  });
});

describe("standInsAllowed (spec ruling 14)", () => {
  it("is true with the bypass exactly \"1\" or in a demo env, false otherwise", () => {
    const { env } = makeEnv();
    expect(standInsAllowed(env)).toBe(false);
    expect(standInsAllowed({ ...env, AUTH_DEV_BYPASS: "1" })).toBe(true);
    expect(standInsAllowed({ ...env, AUTH_DEV_BYPASS: "true" })).toBe(false);
    expect(standInsAllowed(demoOf(env))).toBe(true);
  });
  it("devSeeded still needs the seed's marker, in the demo store's own KV", async () => {
    const demo = demoOf(makeEnv().env);
    expect(await devSeeded(demo, DEVSEED_KV.insights)).toBe(false);
    await demo.STATUS.put(DEVSEED_KV.insights, "1");
    expect(await devSeeded(demo, DEVSEED_KV.insights)).toBe(true);
  });
});

describe("the lab topology cache key (spec §9.10)", () => {
  it("starts with the data source, so a demo answer and a real one never share an entry", () => {
    const real = makeEnv().env;
    expect(topologyCacheKey(real, "az104-01-x", "s1")).toBe("real:az104-01-x:s1");
    expect(topologyCacheKey(demoOf(real), "az104-01-x", "s1")).toBe("demo:az104-01-x:s1");
  });
});
