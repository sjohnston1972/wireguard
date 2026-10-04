// scripts/labs-tf.mjs   (npm run labs-tf; CI's labs job runs it with LABS_TF_REQUIRE_HCL2JSON=1)
//
// Plain English: the Terraform half of the labs' static checks (labs spec
// §11.1, plan L1.4), no cloud calls. For labs/_template and every lab:
//
//   terraform fmt -check          in place (read only)
//   terraform init -backend=false and terraform validate
//                                 on a throw-away copy, so no .terraform folder
//                                 or lock file lands in the repo
//   hcl2json | lab-scope --hcl    the plan-time scope rules on the source, as
//                                 an early warning (lab.yml checks the real plan)
//
// A lab with no terraform/ folder FAILS here (labs-check only notes it): it
// cannot be deployed, so it cannot be released. Without hcl2json on PATH the
// HCL check is skipped with a note, unless LABS_TF_REQUIRE_HCL2JSON=1 (CI).
//
//   node scripts/labs-tf.mjs [folder ...]     only these folders (e.g. _template)

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkHcl } from "../infra/ci/lab-scope.mjs";
import { labFolders } from "./lib/labs.mjs";

const LABS = fileURLToPath(new URL("../labs/", import.meta.url));
/** The id the template is checked as: any valid, non-governance lab id. */
export const TEMPLATE_ID = "az104-00-template";

const tfFiles = (dir) => (existsSync(dir) && statSync(dir).isDirectory() ? readdirSync(dir).filter((f) => f.endsWith(".tf")).sort() : []);

/** What labs-tf checks: [{ folder, dir, labId, problem }], the template first. */
export function labsTfTargets(labsDir = LABS) {
  const out = [{ folder: "_template", dir: join(labsDir, "_template"), labId: TEMPLATE_ID, problem: null }];
  for (const folder of labFolders(labsDir)) {
    const dir = join(labsDir, folder, "terraform");
    out.push({ folder, dir, labId: folder, problem: tfFiles(dir).length ? null : "no terraform/ folder with .tf files: the lab cannot be deployed, so it cannot be released" });
  }
  return out;
}

/** Run the checks. `run(cmd, args, { cwd })` -> spawnSync-like result. Returns { failures: [{ folder, message }] }. */
export function runLabsTf({ labsDir = LABS, run, log = console.log, only = null, requireHcl2json = false, hcl2json = "hcl2json" }) {
  const failures = [];
  const scratch = mkdtempSync(join(tmpdir(), "labs-tf-copy-"));
  const fail = (folder, message) => {
    failures.push({ folder, message });
    log(`FAIL ${folder}: ${message}`);
  };
  const ran = (r) => r && r.status === 0;
  const missing = (r) => r?.error?.code === "ENOENT";
  const why = (r) => (missing(r) ? "not installed" : `${(r?.stderr || r?.stdout || "").trim().split("\n").slice(-6).join(" | ")}`);
  let hclNoted = false;

  for (const t of labsTfTargets(labsDir)) {
    if (only && !only.includes(t.folder)) continue;
    if (t.problem) {
      fail(t.folder, t.problem);
      continue;
    }
    const fmt = run("terraform", ["fmt", "-check", "-diff", "-recursive"], { cwd: t.dir });
    if (!ran(fmt)) {
      fail(t.folder, `terraform fmt -check: ${why(fmt)}`);
      if (missing(fmt)) continue;
    }
    const copy = join(scratch, t.folder);
    mkdirSync(copy, { recursive: true });
    cpSync(t.dir, copy, { recursive: true, filter: (src) => !/[\\/]\.terraform([\\/]|$)/.test(src) });
    const init = run("terraform", ["init", "-backend=false", "-input=false", "-no-color"], { cwd: copy });
    if (!ran(init)) {
      fail(t.folder, `terraform init: ${why(init)}`);
    } else {
      const validate = run("terraform", ["validate", "-no-color"], { cwd: copy });
      if (!ran(validate)) fail(t.folder, `terraform validate: ${why(validate)}`);
    }

    const all = join(scratch, `${t.folder}.tf`);
    writeFileSync(all, tfFiles(t.dir).map((f) => readFileSync(join(t.dir, f), "utf8")).join("\n"));
    const hcl = run(hcl2json, [all], { cwd: scratch });
    if (missing(hcl)) {
      if (requireHcl2json) fail(t.folder, "hcl2json is not installed; the HCL scope check is required here");
      else if (!hclNoted) {
        log("note: hcl2json is not installed, so the HCL scope check was skipped (CI runs it; lab.yml checks the real plan)");
        hclNoted = true;
      }
    } else if (!ran(hcl)) {
      fail(t.folder, `hcl2json: ${why(hcl)}`);
    } else {
      let json = null;
      try {
        json = JSON.parse(hcl.stdout);
      } catch {
        fail(t.folder, "hcl2json printed something that is not JSON");
      }
      if (json) {
        const problems = checkHcl(json, t.labId);
        if (problems.length) fail(t.folder, `scope: ${problems.map((p) => `${p.rule}: ${p.address} (${p.message})`).join("; ")}`);
      }
    }
    if (!failures.some((f) => f.folder === t.folder)) log(`ok   ${t.folder}`);
  }
  return { failures };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const cache = process.env.TF_PLUGIN_CACHE_DIR || join(tmpdir(), "labs-tf-plugin-cache");
  mkdirSync(cache, { recursive: true });
  // terraform and hcl2json are real executables: no shell, so arguments stay exact.
  const run = (cmd, args, opts) => spawnSync(cmd, args, { ...opts, encoding: "utf8", env: { ...process.env, TF_PLUGIN_CACHE_DIR: cache, TF_IN_AUTOMATION: "1" } });
  const { failures } = runLabsTf({ run, only: only.length ? only : null, requireHcl2json: process.env.LABS_TF_REQUIRE_HCL2JSON === "1", hcl2json: process.env.HCL2JSON || "hcl2json" });
  if (failures.length) {
    console.error(`labs-tf: ${failures.length} problem(s)`);
    process.exitCode = 1;
  } else console.log("labs-tf: fmt, init, validate and the HCL scope check pass");
}
