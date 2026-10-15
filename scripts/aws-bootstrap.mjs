// scripts/aws-bootstrap.mjs   (node scripts/aws-bootstrap.mjs)
//
// Plain English: the one-off AWS setup, run from Steven's machine only.
// Uses the admin keys in .env (never copied anywhere) to create wg-admin's
// own narrow logins, then hands them to GitHub and the Worker:
//   GitHub secret AWS_DEPLOY_ROLE_ARN       (a role name, not a key)
//   Worker secrets AWS_WORKER_ACCESS_KEY_ID / AWS_WORKER_SECRET_ACCESS_KEY
// Values go in through stdin; only names are printed. Safe to run again.
//
// --labs (AWS labs spec §7.1, §13): Terraform also makes the AWS labs' role
// wg-admin-labs and its boundary on every run (infra/aws-bootstrap/labs.tf);
// with --labs it then sets the GitHub secret AWS_LABS_ROLE_ARN, asks IAM's
// policy simulator ruling A19's and A48's questions about the role and the
// boundary (any other answer fails the run, exit 1), raises the lab quotas that are below
// target in London and Ireland, and reports (or switches on) the cost
// allocation tag cloudlabs-lab. See scripts/lib/aws-bootstrap-labs.mjs.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv } from "./lib/env.mjs";
import { runLabsBootstrap } from "./lib/aws-bootstrap-labs.mjs";
import { fillPolicy } from "./lib/aws-lab-policies.mjs";

const LABS = process.argv.includes("--labs");
const env = loadEnv();
for (const k of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "CLOUDFLARE_ACCOUNT_ID", "CF_ACCESS_ALLOWED_EMAIL", "GITHUB_REPO"]) {
  if (!env[k]) throw new Error(`.env is missing ${k}`);
}
const dir = "infra/aws-bootstrap";
const tfEnv = {
  ...process.env,
  AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY,
  AWS_REGION: "eu-west-2",
  TF_VAR_alert_email: env.CF_ACCESS_ALLOWED_EMAIL,
  TF_IN_AUTOMATION: "1",
};

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: opts.input === undefined ? "inherit" : ["pipe", "inherit", "inherit"], input: opts.input, env: opts.env ?? tfEnv, shell: opts.shell ?? false, encoding: "utf8" });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${args[0]} failed`);
  return r;
}
function out(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { env: opts.env ?? tfEnv, encoding: "utf8", shell: opts.shell ?? false });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${(r.stderr || "").slice(0, 300)}`);
  return r.stdout;
}

// The R2 keys go to the state backend in a file, so they never meet the AWS provider's variables.
const tmp = mkdtempSync(join(tmpdir(), "wg-aws-"));
const backend = join(tmp, "r2.hcl");
writeFileSync(backend, `bucket = "${env.R2_BUCKET}"\naccess_key = "${env.R2_ACCESS_KEY_ID}"\nsecret_key = "${env.R2_SECRET_ACCESS_KEY}"\nendpoints = { s3 = "https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com" }\n`, { mode: 0o600 });
try {
  run("terraform", [`-chdir=${dir}`, "init", "-reconfigure", "-input=false", "-no-color", `-backend-config=${backend}`]);

  // An account that already trusts GitHub keeps its provider: adopt it rather than fail.
  const acct = out("aws", ["sts", "get-caller-identity", "--query", "Account", "--output", "text"]).trim();
  const providers = out("aws", ["iam", "list-open-id-connect-providers", "--output", "text"]);
  const arn = `arn:aws:iam::${acct}:oidc-provider/token.actions.githubusercontent.com`;
  const inState = spawnSync("terraform", [`-chdir=${dir}`, "state", "list"], { env: tfEnv, encoding: "utf8" }).stdout ?? "";
  if (providers.includes(arn) && !inState.includes("aws_iam_openid_connect_provider.github")) {
    run("terraform", [`-chdir=${dir}`, "import", "-input=false", "-no-color", "aws_iam_openid_connect_provider.github", arn]);
  }

  run("terraform", [`-chdir=${dir}`, "apply", "-auto-approve", "-input=false", "-no-color"]);
  const o = JSON.parse(out("terraform", [`-chdir=${dir}`, "output", "-json"]));

  run("gh", ["secret", "set", "AWS_DEPLOY_ROLE_ARN", "--repo", env.GITHUB_REPO], { input: o.deploy_role_arn.value, env: process.env });
  console.log("GitHub secret set: AWS_DEPLOY_ROLE_ARN");
  const wranglerShell = process.platform === "win32";
  for (const [name, value] of [["AWS_WORKER_ACCESS_KEY_ID", o.worker_access_key_id.value], ["AWS_WORKER_SECRET_ACCESS_KEY", o.worker_secret_access_key.value]]) {
    run("npx", ["wrangler", "secret", "put", name], { input: value, env: process.env, shell: wranglerShell });
    console.log(`Worker secret set: ${name}`);
  }

  // Cost Explorer answers only once it is enabled on the account.
  const today = new Date().toISOString().slice(0, 10);
  const first = `${today.slice(0, 8)}01`;
  const ce = spawnSync("aws", ["ce", "get-cost-and-usage", "--region", "us-east-1", "--time-period", `Start=${first === today ? "2026-01-01" : first},End=${today}`, "--granularity", "MONTHLY", "--metrics", "UnblendedCost", "--output", "text"], { env: tfEnv, encoding: "utf8" });
  console.log(ce.status === 0 ? "Cost Explorer: answering" : `Cost Explorer: NOT answering (${(ce.stderr || "").trim().slice(0, 200)}). Enable it in the AWS console (Billing > Cost Explorer).`);

  if (LABS) {
    run("gh", ["secret", "set", "AWS_LABS_ROLE_ARN", "--repo", env.GITHUB_REPO], { input: o.labs_role_arn.value, env: process.env });
    console.log("GitHub secret set: AWS_LABS_ROLE_ARN");
    const aws = (cmd, args) => {
      const r = spawnSync(cmd, args, { env: tfEnv, encoding: "utf8" });
      return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    };
    // The boundary as Terraform applied it (labs.tf fills the same placeholders), for simulate-custom-policy.
    const defaultVpcArns = o.default_vpc_arns.value;
    const lab = JSON.parse(readFileSync(join(dir, "lab-policies.json"), "utf8"));
    const vpcArns = defaultVpcArns.length ? defaultVpcArns : [`arn:aws:ec2:eu-west-2:${acct}:vpc/vpc-00000000000000000`];
    const boundaryDoc = fillPolicy(lab.boundary, { account: acct, vpcArns });
    const { ok } = await runLabsBootstrap(aws, { account: acct, roleArn: o.labs_role_arn.value, defaultVpcArns, boundaryDoc, log: (s) => console.log(s) });
    if (!ok) {
      console.error("AWS labs: the simulator's answers are wrong (above); do not run AWS labs until they are fixed.");
      process.exitCode = 1;
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
