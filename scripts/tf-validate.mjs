// scripts/tf-validate.mjs   (npm run tf-validate)
//
// Plain English: checks the Terraform without touching Azure or Cloudflare.
// Formatting, syntax, and that every reference resolves. Same checks CI runs.

import { spawnSync } from "node:child_process";

// terraform is a real .exe on Windows, so no shell is needed (and none is
// wanted: a shell would re-parse the arguments).
const opts = { cwd: "infra", stdio: "inherit" };

function run(args) {
  console.log(`$ terraform ${args.join(" ")}`);
  const r = spawnSync("terraform", args, opts);
  if (r.status !== 0) process.exit(r.status ?? 1);
}

run(["fmt", "-check", "-recursive", "-diff"]);
run(["init", "-backend=false", "-input=false", "-no-color"]);
run(["validate", "-no-color"]);
console.log("Terraform OK");
