// scripts/labs-topology.mjs   (npm run labs-topology [-- --check] [id ...])
//
// Plain English: writes each lab's planned diagram, shared/topology/planned/
// <id>.json (lab topology spec §5), offline and without Azure. For every lab
// folder (the template is skipped):
//
//   1. a throw-away copy of its terraform/ (a Bicep lab's .bicep built into
//      it with the pinned Bicep, as labs-tf does), terraform init
//      -backend=false (sharing labs-tf's plugin cache), labs-tf's mock plan
//      file, then `terraform test -verbose -json`: a plan with mocked
//      providers whose values are real for everything configured
//   2. the plan's managed resources and outputs, read in memory and scrubbed
//      (scripts/lib/topology-stream.mjs); the stream holds the mock admin
//      password and is never printed, written or kept: on a failed run only
//      its diagnostic messages are printed
//   3. the HCL's references between resources (the pinned hcl2json and
//      infra/ci/lab-scope.mjs's hclResources)
//   4. plannedGraph (shared/topology/planned.ts, run through Vite's module
//      runner: the builder is TypeScript), the deny check (a graph with any
//      secret-like value or a prop outside PROP_NAMES is never written), then
//      the file: JSON.stringify(graph, null, 1) + "\n"
//
// --check writes nothing and exits 1 naming each lab whose fresh graph
// differs from the committed file (compared parsed, so line endings never
// matter), each lab with no file, and each file with no lab folder. CI's labs
// job runs it after labs-tf. Without terraform it fails with a reason: a
// stale diagram is a failure, never a skip.
//
//   node scripts/labs-topology.mjs [--check] [id ...]     only these labs

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { hclResources } from "../infra/ci/lab-scope.mjs";
import { mockedProviders, mockPlanFile } from "./labs-tf.mjs";
import { labFolders } from "./lib/labs.mjs";
import { diagnostics, planFromTestStream, refsFromHcl } from "./lib/topology-stream.mjs";
import { BICEP_VERSION, bicepAsset, bicepMatchesPin, pinnedBicep } from "./lib/bicep.mjs";
import { HCL2JSON_VERSION, hcl2jsonAsset, hcl2jsonMatchesPin, pinnedHcl2json } from "./lib/hcl2json.mjs";

const LABS = fileURLToPath(new URL("../labs/", import.meta.url));
const OUT = fileURLToPath(new URL("../shared/topology/planned/", import.meta.url));

const tfFiles = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".tf")).sort() : []);
const missing = (r) => r?.error?.code === "ENOENT";

/** The builder and the deny check, from the TypeScript in shared/topology (Vite's module runner). */
export async function loadBuilder() {
  const { runnerImport } = await import("vite");
  const load = async (rel) => (await runnerImport(fileURLToPath(new URL(rel, import.meta.url)), { configFile: false, logLevel: "error" })).module;
  const [planned, props] = await Promise.all([load("../shared/topology/planned.ts"), load("../shared/topology/props.ts")]);
  return { build: planned.plannedGraph, deny: props.denyProblems };
}

/** A graph as stored. */
export const fileText = (graph) => JSON.stringify(graph, null, 1) + "\n";

/**
 * One lab's PlannedInput (without labId, version and number), or { error }:
 * the error is safe to print (diagnostics only, never the stream).
 */
function planInput({ folder, labsDir, scratch, run, hcl2json, bicep }) {
  const src = join(labsDir, folder, "terraform");
  if (!tfFiles(src).length) return { error: "no terraform/ folder with .tf files" };
  const copy = join(scratch, folder);
  mkdirSync(copy, { recursive: true });
  cpSync(src, copy, { recursive: true, filter: (p) => !/[\\/]\.terraform([\\/]|$)/.test(p) });
  for (const f of readdirSync(copy).filter((x) => x.endsWith(".bicep")).sort()) {
    const b = run(bicep, ["build", f, "--outfile", `${f.slice(0, -".bicep".length)}.json`], { cwd: copy });
    if (missing(b)) return { error: `Bicep ${BICEP_VERSION} is not available to build ${f}` };
    if (b.status !== 0) return { error: `bicep build ${f} failed` };
  }
  const init = run("terraform", ["init", "-backend=false", "-input=false", "-no-color"], { cwd: copy });
  if (missing(init)) return { error: "terraform is not installed (the generator needs it: a stale diagram is a failure, never a skip)" };
  if (init.status !== 0) return { error: `terraform init failed: ${(init.stderr || "").trim().split("\n").slice(-3).join(" | ")}` };
  mkdirSync(join(copy, "tests"), { recursive: true });
  writeFileSync(join(copy, "tests", "labs-mock.tftest.hcl"), mockPlanFile(folder, mockedProviders(copy)));
  const t = run("terraform", ["test", "-verbose", "-json", "-no-color"], { cwd: copy });
  if (missing(t)) return { error: "terraform is not installed (the generator needs it: a stale diagram is a failure, never a skip)" };
  if (t.status !== 0) {
    const d = diagnostics(t.stdout ?? "");
    return { error: `the mock plan failed${d.length ? `:\n  ${d.join("\n  ")}` : ` (exit ${t.status}, no diagnostic)`}` };
  }
  let plan;
  try {
    plan = planFromTestStream(t.stdout ?? "");
  } catch (e) {
    return { error: e.message };
  }
  const all = join(scratch, `${folder}.tf`);
  writeFileSync(all, tfFiles(src).map((f) => readFileSync(join(src, f), "utf8")).join("\n"));
  const h = run(hcl2json, [all], { cwd: scratch });
  if (missing(h)) return { error: `hcl2json ${HCL2JSON_VERSION} is not available` };
  if (h.status !== 0) return { error: "hcl2json failed on the lab's .tf files" };
  let hcl;
  try {
    hcl = JSON.parse(h.stdout);
  } catch {
    return { error: "hcl2json printed something that is not JSON" };
  }
  return { changes: plan.changes, outputs: plan.outputs, refs: refsFromHcl(hcl, folder, hclResources) };
}

/**
 * Generate (or --check) the planned graphs. `run(cmd, args, { cwd })` is
 * spawnSync-like. `build` and `deny` default to the real builder and deny
 * check. Returns { failures: [{ lab, message }], written: [id] }.
 */
export async function runLabsTopology({ labsDir = LABS, outDir = OUT, only = null, check = false, run, hcl2json = "hcl2json", bicep = "bicep", log = console.log, build, deny }) {
  if (!build || !deny) ({ build = build, deny = deny } = await loadBuilder());
  const failures = [];
  const written = [];
  const fail = (lab, message) => {
    failures.push({ lab, message });
    log(`FAIL ${lab}: ${message}`);
  };
  const folders = labFolders(labsDir).filter((f) => !only || only.includes(f));
  const scratch = mkdtempSync(join(tmpdir(), "labs-topology-"));
  try {
    for (const folder of folders) {
      const input = planInput({ folder, labsDir, scratch, run, hcl2json, bicep });
      // Each copy (with its .terraform folder) is large: gone as soon as it has been read.
      rmSync(join(scratch, folder), { recursive: true, force: true });
      if (input.error) {
        fail(folder, input.error);
        continue;
      }
      let version = 0;
      try {
        version = Number(parse(readFileSync(join(labsDir, folder, "lab.yaml"), "utf8"))?.version) || 0;
      } catch {
        version = 0;
      }
      const number = /^az\d{3}-(\d{2})-/.exec(folder)?.[1] ?? "00";
      let graph;
      try {
        graph = build({ labId: folder, version, number, ...input });
      } catch (e) {
        fail(folder, `the planned builder refused it: ${String(e?.message ?? e).split("\n")[0]}`);
        continue;
      }
      const problems = deny(graph);
      if (problems.length) {
        // Each problem names where (a node id and field), never the value.
        fail(folder, `the graph fails the deny check, so it was not written:\n  ${problems.join("\n  ")}`);
        continue;
      }
      const file = join(outDir, `${folder}.json`);
      const text = fileText(graph);
      if (check) {
        if (!existsSync(file)) fail(folder, `shared/topology/planned/${folder}.json is missing: run npm run labs-topology`);
        else {
          let committed = null;
          try {
            committed = JSON.parse(readFileSync(file, "utf8"));
          } catch {
            committed = null;
          }
          if (JSON.stringify(committed) !== JSON.stringify(graph)) fail(folder, `the planned diagram changed: run npm run labs-topology -- ${folder} and commit the file`);
          else log(`ok   ${folder}`);
        }
      } else {
        mkdirSync(outDir, { recursive: true });
        if (!existsSync(file) || readFileSync(file, "utf8") !== text) writeFileSync(file, text);
        written.push(folder);
        log(`ok   ${folder} (${graph.nodes.length} nodes, ${graph.edges.length} edges)`);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  // Files with no lab folder (only when every lab was considered).
  if (!only && existsSync(outDir)) {
    const ids = new Set(labFolders(labsDir));
    for (const f of readdirSync(outDir).filter((x) => x.endsWith(".json")).sort()) {
      const id = f.slice(0, -".json".length);
      if (ids.has(id)) continue;
      if (check) fail(id, `shared/topology/planned/${f} has no lab folder: delete it (npm run labs-topology removes it)`);
      else {
        rmSync(join(outDir, f));
        log(`removed ${f} (no lab folder)`);
      }
    }
  }
  return { failures, written };
}

/** $HCL2JSON or $BICEP only when they are the pinned asset by checksum; else the pinned download (verified on every use). */
async function resolveTools(only) {
  const cacheRoot = tmpdir();
  let hcl = null;
  if (process.env.HCL2JSON && hcl2jsonMatchesPin(process.env.HCL2JSON, hcl2jsonAsset())) hcl = process.env.HCL2JSON;
  else hcl = (await pinnedHcl2json({ cacheDir: join(cacheRoot, "labs-hcl2json", HCL2JSON_VERSION) })) ?? "hcl2json-pinned-not-available";
  const needsBicep = labFolders(LABS).some((f) => (!only || only.includes(f)) && existsSync(join(LABS, f, "terraform")) && readdirSync(join(LABS, f, "terraform")).some((x) => x.endsWith(".bicep")));
  let bicep = "bicep-pinned-not-available";
  if (needsBicep) {
    if (process.env.BICEP && bicepMatchesPin(process.env.BICEP, bicepAsset())) bicep = process.env.BICEP;
    else bicep = (await pinnedBicep({ cacheDir: join(cacheRoot, "labs-bicep", BICEP_VERSION) })) ?? bicep;
  }
  return { hcl2json: hcl, bicep };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const only = args.filter((a) => !a.startsWith("-"));
  const cache = process.env.TF_PLUGIN_CACHE_DIR || join(tmpdir(), "labs-tf-plugin-cache");
  mkdirSync(cache, { recursive: true });
  const tools = await resolveTools(only.length ? only : null);
  // Real executables, no shell; the stream can be several MB.
  const run = (cmd, a, opts) => spawnSync(cmd, a, { ...opts, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, TF_PLUGIN_CACHE_DIR: cache, TF_IN_AUTOMATION: "1", DOTNET_CLI_TELEMETRY_OPTOUT: "1" } });
  const { failures, written } = await runLabsTopology({ run, check, only: only.length ? only : null, ...tools });
  if (failures.length) {
    console.error(`labs-topology: ${failures.length} problem(s)${check ? " (run npm run labs-topology and commit shared/topology/planned)" : ""}`);
    process.exitCode = 1;
  } else console.log(check ? "labs-topology: every planned diagram is fresh" : `labs-topology: wrote ${written.length} planned diagram(s)`);
}
