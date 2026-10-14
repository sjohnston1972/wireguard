// scripts/tf-validate.mjs   (npm run tf-validate)
//
// Plain English: checks the Terraform without touching Azure, AWS or Cloudflare.
// Formatting, syntax, and that every reference resolves, in every Terraform
// folder. Same checks CI runs.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

// terraform is a real .exe on Windows, so no shell is needed (and none is
// wanted: a shell would re-parse the arguments).
const ROOTS = ["infra", "infra/aws", "infra/aws-bootstrap"];

function run(cwd, args) {
  console.log(`$ (${cwd}) terraform ${args.join(" ")}`);
  const r = spawnSync("terraform", args, { cwd, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

run("infra", ["fmt", "-check", "-recursive", "-diff"]);
for (const root of ROOTS) {
  if (!existsSync(root)) continue;
  run(root, ["init", "-backend=false", "-input=false", "-no-color"]);
  run(root, ["validate", "-no-color"]);
}
console.log("Terraform OK");
