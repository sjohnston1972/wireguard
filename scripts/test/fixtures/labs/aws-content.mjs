// scripts/test/fixtures/labs/aws-content.mjs
//
// Plain English: the content checks every AWS lab shares (AWS labs spec §4),
// in one place. awsLab(id) reads a lab's folder (lab.yaml, the .tf files, the
// readme and its learning file); commonAwsProblems(id) lists every §4 rule it
// checks that the lab breaks (an empty list when it keeps them all). Text
// only: no AWS, no terraform init (npm run labs-tf does that). Terraform's
// formatter aligns `=`, so patterns here allow any run of spaces around it.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { LAB_TF_VARS_AWS, readmeFooter, variablesProblems } from "../../../lib/labs.mjs";
import { lintDir } from "../../../../infra/ci/lab-lint.mjs";
import { lab, resources } from "./content.mjs";

const LABS = fileURLToPath(new URL("../../../../labs/", import.meta.url));
const lf = (s) => s.replace(/\r\n/g, "\n");

/** A lab's folder read once: { yaml, tf (every .tf joined), files, readme, learning, tfDir, blocks }. */
export function awsLab(id, labsDir = LABS) {
  const l = lab(id, labsDir);
  const learning = parseYaml(lf(readFileSync(join(labsDir, "_learning", `${id}.yaml`), "utf8")), { version: "1.1" });
  return { yaml: l.yaml, tf: Object.values(l.files).join("\n"), files: l.files, readme: l.readme, learning, tfDir: l.tfDir, blocks: l.blocks, lab: l };
}

/** The top-level `variable "x" {` blocks of a variables.tf: { x: text }. */
function variableBlocks(tf) {
  const out = {};
  for (const part of lf(tf).split(/\n(?=variable ")/)) {
    const m = part.match(/^variable "([^"]+)"/);
    if (m) out[m[1]] = part.replace(/\n+$/, "");
  }
  return out;
}

/** Whether a block body has `name = value` (value is a regex source). */
const hasAttr = (body, name, value) => new RegExp(`^\\s*${name}\\s+=\\s+${value}`, "m").test(body);

export function commonAwsProblems(id, labsDir = LABS) {
  const out = [];
  const l = awsLab(id, labsDir);
  const tplFiles = {};
  for (const f of ["main.tf", "network.tf", "versions.tf", "variables.tf"]) tplFiles[f] = lf(readFileSync(join(labsDir, "_template-aws", f), "utf8"));

  for (const f of ["main.tf", "network.tf", "versions.tf"]) if (l.files[f] !== tplFiles[f]) out.push(`${f} differs from labs/_template-aws/${f}`);

  const mine = variableBlocks(l.files["variables.tf"] ?? "");
  const theirs = variableBlocks(tplFiles["variables.tf"]);
  for (const [name, text] of Object.entries(mine)) {
    if (!LAB_TF_VARS_AWS.includes(name)) out.push(`variables.tf declares ${name}, which is not a §4 variable`);
    else if (text !== theirs[name]) out.push(`variables.tf: variable "${name}" is not as the template writes it`);
  }

  const res = (type) => l.lab.blocks.filter((b) => b.kind === "resource" && b.labels[0] === type);
  for (const r of res("aws_instance")) {
    const at = `aws_instance.${r.labels[1]}`;
    if (!hasAttr(r.body, "ami", String.raw`data\.aws_ssm_parameter\.al2023_arm64\.insecure_value`)) out.push(`${at}: ami is not data.aws_ssm_parameter.al2023_arm64.insecure_value`);
    if (!hasAttr(r.body, "http_tokens", '"required"')) out.push(`${at}: http_tokens is not "required"`);
    // volume_tags, or (with a separately attached disk, where volume_tags would cycle the tags, C18) root_block_device tags.
    const rootTags = /root_block_device\s*\{[^}]*?\n\s*tags\s+=\s+merge\(var\.tags,/.test(r.body);
    if (!hasAttr(r.body, "volume_tags", String.raw`merge\(var\.tags,`) && !rootTags) out.push(`${at}: volume_tags (or root_block_device tags) does not merge(var.tags, ...)`);
    if (hasAttr(r.body, "associate_public_ip_address", "true")) out.push(`${at}: associate_public_ip_address = true`);
  }
  for (const r of res("aws_launch_template")) {
    const at = `aws_launch_template.${r.labels[1]}`;
    if (!hasAttr(r.body, "http_tokens", '"required"')) out.push(`${at}: http_tokens is not "required"`);
    for (const t of ["instance", "volume", "network-interface"]) {
      const m = r.body.match(new RegExp(String.raw`tag_specifications\s*\{[^}]*?resource_type\s+=\s+"${t}"[\s\S]*?\n\s*\}`));
      if (!m || !/merge\(var\.tags,/.test(m[0])) out.push(`${at}: tag_specifications for ${t} does not merge(var.tags, ...)`);
    }
  }
  for (const type of ["aws_iam_role", "aws_iam_instance_profile", "aws_iam_policy"]) {
    for (const r of res(type)) {
      const at = `${type}.${r.labels[1]}`;
      if (!hasAttr(r.body, "path", '"/cloudlabs-lab/"')) out.push(`${at}: path is not "/cloudlabs-lab/"`);
      if (!hasAttr(r.body, "name", String.raw`"lab-\$\{var\.lab_id\}-`)) out.push(`${at}: name does not start "lab-\${var.lab_id}-"`);
      if (type === "aws_iam_role" && !hasAttr(r.body, "permissions_boundary", String.raw`local\.boundary_arn`)) out.push(`${at}: permissions_boundary is not local.boundary_arn`);
    }
  }
  if (l.lab.blocks.some((b) => b.kind === "data" && b.labels[0] === "aws_iam_policy_document")) out.push('data "aws_iam_policy_document" is not allowed (plan ruling P12): write the document with jsonencode()');

  const outputs = l.lab.blocks.filter((b) => b.kind === "output").map((b) => b.labels[0]);
  const wanted = ["private_ips", "connect", ...(l.yaml.connectivity?.peering !== "off" ? ["peer_vpc_id", "peer_route_table_ids"] : [])];
  for (const o of wanted) if (!outputs.includes(o)) out.push(`outputs.tf has no output "${o}"`);

  const exam = l.yaml.exam;
  const before = l.readme.split("\n## What it deploys")[0];
  if (!before.includes(`From the ${exam} outline:`)) out.push(`the readme's intro has no "From the ${exam} outline:" line`);
  if (!before.includes(`\`lab-${id}\``)) out.push(`the readme's intro does not name \`lab-${id}\``);
  for (const m of l.readme.matchAll(/\]\((https?:[^)\s]+)\)/g)) if (!m[1].startsWith("https://docs.aws.amazon.com/")) out.push(`the readme links to ${m[1]}, not https://docs.aws.amazon.com/`);
  if (!lf(l.readme).trimEnd().endsWith(readmeFooter(id))) out.push("the readme does not end with the standard footer");

  for (const p of lintDir(l.tfDir, { cloud: "aws" })) out.push(`lint ${p.rule}: ${p.file}:${p.line} ${p.message}`);
  for (const p of variablesProblems(l.files["variables.tf"] ?? "", "aws")) out.push(p);
  return out;
}

export { resources };
