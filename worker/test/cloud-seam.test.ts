// The cloud seam: one door to whichever cloud the headend is in.
import { describe, it, expect, afterEach, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { makeEnv } from "./harness";
import { headendOps, opsFor } from "../src/cloud";
import { saveSnapshot } from "../src/state";

afterEach(() => vi.unstubAllGlobals());

const walk = (dir: string): string[] => readdirSync(new URL(`../src/${dir}`, import.meta.url)).flatMap((f) => (/\.tsx?$/.test(f) ? [`${dir}${f}`] : f.includes(".") ? [] : walk(`${dir}${f}/`)));

describe("cloud seam", () => {
  it("routes power to Azure for a snapshot with no cloud", async () => {
    const { env, world } = makeEnv();
    world.azure.rg = true;
    await (await headendOps(env)).power(env, "hibernate");
    await (await headendOps(env)).power(env, "resume");
    expect(world.powerCalls).toEqual(["deallocate", "start"]);
  });
  it("names the cloud for messages", () => {
    expect(opsFor("azure").label).toBe("Azure");
  });
  it("the Azure view is the same as before", async () => {
    const { env, world } = makeEnv();
    world.azure.rg = true;
    world.azure.power = "deallocated";
    await saveSnapshot(env, { cloud: "azure" });
    const v = await (await headendOps(env)).view(env);
    expect(v).toMatchObject({ rg_exists: true, vm_exists: true, power: "deallocated", public_ip: "20.0.0.10" });
  });
  it("only the seam, insights and labs import azure.ts", () => {
    // The file that is src/azure.ts from where it sits: "./azure" at the top, "../azure" one folder down.
    const offenders = walk("")
      .filter((f) => !/^(cloud|insights|labs)\//.test(f) && f !== "azure.ts")
      .filter((f) => (f.includes("/") ? /from "\.\.\/azure"/ : /from "\.\/azure"/).test(readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8")));
    expect(offenders).toEqual([]);
  });
});
