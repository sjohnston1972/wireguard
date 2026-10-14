// Which cloud the headend is in: read from the snapshot, Azure when unsaid.
import { describe, it, expect, afterEach, vi } from "vitest";
import { makeEnv } from "./harness";
import { cloudOf, getSnapshot, saveSnapshot } from "../src/state";
import { startDeploy } from "../src/runs";

afterEach(() => vi.unstubAllGlobals());

describe("cloudOf", () => {
  it("reads a fresh snapshot as Azure", async () => {
    const { env } = makeEnv();
    expect(cloudOf(await getSnapshot(env))).toBe("azure");
  });
  it("keeps the cloud a deploy recorded", async () => {
    const { env } = makeEnv();
    await saveSnapshot(env, { cloud: "aws" });
    expect(cloudOf(await getSnapshot(env))).toBe("aws");
  });
  it("reads a snapshot stored before the field existed as Azure", () => {
    expect(cloudOf({})).toBe("azure");
  });
  it("an Azure deploy records azure and sends no cloud key", async () => {
    const { env, world } = makeEnv();
    await startDeploy(env, { hours: 4, requesterIp: null, requestedBy: "steven" });
    expect((await getSnapshot(env)).cloud).toBe("azure");
    expect(world.dispatches[0].workflow).toBe("wg.yml");
    expect("cloud" in world.dispatches[0].payload).toBe(false);
  });
});
