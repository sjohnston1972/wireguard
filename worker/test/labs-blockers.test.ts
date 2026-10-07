// labs-blockers.test.ts
//
// Plain English: labs redesign plan E4 (spec §6.1, §6.2). Each catalogue card
// says every reason Deploy would be refused before its confirmation, in
// deployLab's order and with deployLab's sentences (github, role, graph,
// slots, max_running, leftovers, budget), so the app's "Ready" can never
// disagree with the deploy route. Unknown or failed permission checks are
// blockers (fail-closed); a budget that cannot be read adds none (the route
// re-checks). Cards also carry the catalogue's learning content and planned
// resources, and GET /labs says whether labs are torn down by themselves.

import { afterEach, describe, expect, it, vi } from "vitest";
import * as db from "../src/db";
import { setCatalogueForTest } from "../src/labs/catalogue";
import { blockersOf, unavailableReason, type Availability } from "../src/labs/availability";
import { budgetFullMessage } from "../src/labs/warnings";
import { api, deployLab, freeze, labEnv, runningLab, NOW, TEST_LABS } from "./labs-helpers";
import type { Env } from "../src/env";
import type { LabBlocker, LabCard, LabsResponse } from "../../shared/api";

afterEach(() => {
  setCatalogueForTest(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const def = (id: string) => TEST_LABS.find((l) => l.id === id)!;
const PASSED = { checkedAt: NOW, role: true, users: true, groups: true, message: null };
const NEVER = { checkedAt: null, role: null, users: null, groups: null, message: null };
const avail = (over: Partial<Availability> = {}): Availability => ({ permissions: PASSED, live: 0, maxRunning: 3, slotsUsed: 0, github: true, ...over });

const SENTENCES = {
  github: "GitHub is not connected yet. Add GITHUB_TOKEN and GITHUB_REPO in Settings > Setup.",
  role: "Needs the labs governance role: do the one-time setup, then Settings → Labs → Check permissions.",
  graph: "Needs the Microsoft Graph permissions for lab users and groups: do the one-time setup, then Settings → Labs → Check permissions.",
  slots: "All 32 address slots are in use. A slot is freed when a lab is clean in Azure again.",
  max_running: "3 labs are already running (the limit in Settings → Labs).",
};

async function cards(env: Env): Promise<LabsResponse> {
  const r = await api(env, "GET", "/labs");
  expect(r.status).toBe(200);
  return r.json as LabsResponse;
}
const card = (l: LabsResponse, id: string): LabCard => l.labs.find((c) => c.id === id)!;
const kinds = (c: LabCard) => c.blockers.map((b) => b.kind);

describe("blockersOf (spec §6.1)", () => {
  it("blockersOf lists github, role, graph, slots, max_running in order with unavailableReason's sentences", () => {
    // Lab 1 needs the governance role and Graph.
    const all = blockersOf(def("az104-01-identity"), avail({ github: false, permissions: NEVER, slotsUsed: 32, live: 3 }));
    expect(all).toEqual<LabBlocker[]>([
      { kind: "github", message: SENTENCES.github },
      { kind: "role", message: SENTENCES.role },
      { kind: "graph", message: SENTENCES.graph },
      { kind: "slots", message: SENTENCES.slots },
      { kind: "max_running", message: SENTENCES.max_running },
    ]);
    // Lab 5 needs neither permission.
    expect(blockersOf(def("az104-05-storage"), avail({ permissions: NEVER }))).toEqual([]);
    expect(blockersOf(def("az104-05-storage"), avail())).toEqual([]);
  });

  it("unavailableReason is the first blocker's message", () => {
    const cases: Partial<Availability>[] = [
      {},
      { github: false },
      { permissions: NEVER },
      { permissions: { ...PASSED, role: false } },
      { permissions: { ...PASSED, groups: null } },
      { slotsUsed: 32 },
      { live: 3 },
      { live: 2, maxRunning: 2, slotsUsed: 32 },
    ];
    for (const id of ["az104-01-identity", "az104-05-storage", "az104-06-blob-security"]) {
      for (const c of cases) {
        const a = avail(c);
        expect(unavailableReason(def(id), a), `${id} ${JSON.stringify(c)}`).toBe(blockersOf(def(id), a)[0]?.message ?? null);
      }
    }
  });

  it("a never-checked permission is a role blocker", () => {
    expect(blockersOf(def("az104-01-identity"), avail({ permissions: NEVER })).map((b) => b.kind)).toEqual(["role", "graph"]);
    // Lab 6 assigns a role and makes a group.
    expect(blockersOf(def("az104-06-blob-security"), avail({ permissions: NEVER })).map((b) => b.kind)).toEqual(["role", "graph"]);
  });

  it("a failed Graph check is a graph blocker", () => {
    expect(blockersOf(def("az104-06-blob-security"), avail({ permissions: { ...PASSED, users: false } }))).toEqual([{ kind: "graph", message: SENTENCES.graph }]);
    expect(blockersOf(def("az104-06-blob-security"), avail({ permissions: { ...PASSED, groups: null } }))).toEqual([{ kind: "graph", message: SENTENCES.graph }]);
  });
});

describe("cards (spec §6.1, §6.2)", () => {
  it("cards have no blockers when the lab can deploy now", async () => {
    freeze();
    const { env } = await labEnv();
    const l = await cards(env);
    for (const c of l.labs) expect(c.blockers, c.id).toEqual([]);
  });

  it("a KV read failure of labs:permissions blocks every lab that needs permissions", async () => {
    freeze();
    const { env } = await labEnv();
    const get = env.STATUS.get.bind(env.STATUS);
    env.STATUS.get = ((key: string, ...rest: unknown[]) => {
      if (key === "labs:permissions") return Promise.reject(new Error("KV down"));
      return (get as (k: string, ...r: unknown[]) => Promise<unknown>)(key, ...rest);
    }) as typeof env.STATUS.get;
    const l = await cards(env);
    expect(kinds(card(l, "az104-01-identity"))).toEqual(["role", "graph"]);
    expect(kinds(card(l, "az104-06-blob-security"))).toEqual(["role", "graph"]);
    expect(kinds(card(l, "az104-05-storage"))).toEqual([]);
    expect(kinds(card(l, "az305-28-hub-spoke-fw"))).toEqual([]);
  });

  it("a dirty session holding a slot or an orphan entry is a leftovers blocker with deployLab's sentence", async () => {
    freeze();
    const { env, world } = await labEnv();
    const up = await runningLab(env, world, "az104-05-storage");
    await env.DB.prepare("UPDATE lab_sessions SET state = 'ended_dirty', ended_at = ?2 WHERE id = ?1").bind(up.sid, NOW).run();
    await env.STATUS.put("labs:orphans", JSON.stringify([{ labId: "az104-07-files", names: ["rg-lab-az104-07-files"], since: NOW }]));
    const l = await cards(env);
    const leftovers = (title: string) => `${title} still has leftovers in Azure from an earlier session. Clean them up from the Labs tab first.`;
    expect(card(l, "az104-05-storage").blockers).toEqual([{ kind: "leftovers", message: leftovers("Storage accounts") }]);
    expect(card(l, "az104-07-files").blockers).toEqual([{ kind: "leftovers", message: leftovers("Azure Files") }]);
    expect(kinds(card(l, "az104-06-blob-security"))).toEqual([]);
    // A dirty session whose slot went back no longer blocks.
    await env.DB.prepare("UPDATE lab_slots SET session_id = NULL, since = NULL WHERE session_id = ?1").bind(up.sid).run();
    await env.DB.prepare("UPDATE lab_sessions SET slot = NULL WHERE id = ?1").bind(up.sid).run();
    expect(kinds(card(await cards(env), "az104-05-storage"))).toEqual([]);
  });

  it("budget at 100 % is a budget blocker; a budget read failure adds none", async () => {
    freeze();
    const { env } = await labEnv();
    await db.upsertCostDay(env, "2026-10-01", 10.5);
    const l = await cards(env);
    const message = budgetFullMessage({ total: 10.5, budget: 10 });
    expect(message).toBe("This month is already at £10.50 of £10.00, and the budget guard removes labs at 100%. Raise the budget in Settings to deploy.");
    for (const c of l.labs) expect(c.blockers, c.id).toEqual([{ kind: "budget", message }]);
    // The deploy modal's non-overridable warning says the same.
    const w = (await api(env, "GET", "/labs/az104-05-storage")).json.warnings as { kind: string; message: string; overridable: boolean }[];
    expect(w).toContainEqual({ kind: "budget", message, overridable: false });
    // Under budget: none.
    await db.upsertCostDay(env, "2026-10-01", 9.99);
    expect(kinds(card(await cards(env), "az104-05-storage"))).toEqual([]);
    // The budget cannot be read: no blocker (the deploy route checks again).
    await db.upsertCostDay(env, "2026-10-01", 10.5);
    const prepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) => {
      if (/FROM cost_days/.test(sql)) throw new Error("D1 down");
      return prepare(sql);
    }) as typeof env.DB.prepare;
    const failed = await cards(env);
    for (const c of failed.labs) expect(c.blockers, c.id).toEqual([]);
  });

  it("a lab with any blocker is refused by deployLab with the blocker's first sentence", async () => {
    const stories: { name: string; lab: string; overrides?: Partial<Env>; setup?: (env: Env, world: Parameters<typeof runningLab>[1]) => Promise<void>; kind: LabBlocker["kind"] }[] = [
      { name: "github", lab: "az104-05-storage", overrides: { GITHUB_TOKEN: "" }, kind: "github" },
      { name: "role (never checked)", lab: "az104-01-identity", setup: async (env) => env.STATUS.put("labs:permissions", JSON.stringify(NEVER)), kind: "role" },
      { name: "graph (failed)", lab: "az104-06-blob-security", setup: async (env) => env.STATUS.put("labs:permissions", JSON.stringify({ ...PASSED, users: false })), kind: "graph" },
      { name: "slots", lab: "az104-05-storage", setup: async (env) => void (await env.DB.prepare("UPDATE lab_slots SET session_id = 'ls-elsewhere', since = ?1").bind(NOW).run()), kind: "slots" },
      {
        name: "max_running",
        lab: "az104-05-storage",
        setup: async (env, world) => {
          await api(env, "PUT", "/settings", { labs_max_running: "1" });
          await runningLab(env, world, "az104-07-files");
        },
        kind: "max_running",
      },
      {
        name: "leftovers",
        lab: "az104-07-files",
        setup: async (env) => env.STATUS.put("labs:orphans", JSON.stringify([{ labId: "az104-07-files", names: ["rg-lab-az104-07-files"], since: NOW }])),
        kind: "leftovers",
      },
      { name: "budget", lab: "az104-05-storage", setup: async (env) => db.upsertCostDay(env, "2026-10-01", 10.5), kind: "budget" },
    ];
    for (const s of stories) {
      freeze();
      const { env, world } = await labEnv(s.overrides);
      await s.setup?.(env, world);
      const c = card(await cards(env), s.lab);
      expect(c.blockers[0]?.kind, s.name).toBe(s.kind);
      expect(c.unavailable === null || c.unavailable === c.blockers[0].message, s.name).toBe(true);
      const r = await deployLab(env, s.lab, { hours: 1, peer: false, overBudgetOk: true, capacityOk: true });
      expect(r.status, s.name).toBe(409);
      expect(r.json.error.message, s.name).toBe(c.blockers[0].message);
      setCatalogueForTest(null);
      vi.useRealTimers();
    }
  });

  it("cards carry learning (camelCase) and resources from the catalogue, null when absent", async () => {
    freeze();
    const { env } = await labEnv();
    const l = await cards(env);
    expect(card(l, "az104-06-blob-security").learning).toEqual({
      objective: "Control who reaches one blob container with keys and SAS tokens, Entra roles and a private endpoint.",
      learn: ["Make a SAS from a stored access policy and revoke it", "Grant blob data access to an Entra group", "Resolve the account to a private endpoint address"],
      learningMin: 50,
    });
    expect(card(l, "az104-06-blob-security").resources).toEqual({ entraPrincipal: 1, privateDnsZone: 1, privateEndpoint: 1, resourceGroup: 1, storage: 1, subnet: 1, vnet: 1 });
    expect(card(l, "az104-05-storage").learning).toBeNull();
    expect(card(l, "az104-05-storage").resources).toEqual({ resourceGroup: 1, storage: 2 });
    expect(card(l, "az104-07-files")).toMatchObject({ learning: null, resources: null });
    // GET /labs/:id's card is the same card.
    expect((await api(env, "GET", "/labs/az104-06-blob-security")).json.card).toMatchObject({ learning: { learningMin: 50 }, resources: { storage: 1 }, blockers: [] });
  });

  it("GET /labs answers autoCleanup = canDispatch", async () => {
    freeze();
    expect((await cards((await labEnv()).env)).autoCleanup).toBe(true);
    expect((await cards((await labEnv({ GITHUB_TOKEN: "" })).env)).autoCleanup).toBe(false);
    expect((await cards((await labEnv({ GITHUB_TOKEN: "REPLACE_ME" })).env)).autoCleanup).toBe(false);
    expect((await cards((await labEnv({ GITHUB_REPO: "" })).env)).autoCleanup).toBe(false);
  });
});
