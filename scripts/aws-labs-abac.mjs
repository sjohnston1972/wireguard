// scripts/aws-labs-abac.mjs   (node scripts/aws-labs-abac.mjs [--render | --check])
//
// Plain English: writes the AWS labs' tag rules (AWS labs spec §7.1, rulings
// P16 and A29). With no flag it reads AWS's public Service Authorization
// Reference (one JSON document per service; no AWS account or keys needed),
// works out which actions must carry the cloudlabs-lab tag when they make
// something (the create list) and which may only touch things already
// carrying it (the change list), and writes infra/aws-bootstrap/lab-abac.json,
// then renders. --render turns lab-abac.json into the managed policies and
// the boundary, infra/aws-bootstrap/lab-policies.json, offline. --check exits
// 1 when lab-policies.json is not what --render would write. Both files are
// committed and reviewed; aws-labs-iam.test.mjs pins the lists.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ABAC_SERVICES, SAR_INDEX, abacLists, renderLabPolicies, policySize, POLICY_MAX, ROLE_POLICIES_MAX } from "./lib/aws-lab-policies.mjs";

const ABAC_FILE = fileURLToPath(new URL("../infra/aws-bootstrap/lab-abac.json", import.meta.url));
const POLICIES_FILE = fileURLToPath(new URL("../infra/aws-bootstrap/lab-policies.json", import.meta.url));
const json = (o) => `${JSON.stringify(o, null, 2)}\n`;

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

/** The reference's documents for the ABAC services, by service name. */
async function fetchSar() {
  const index = await getJson(SAR_INDEX);
  if (!Array.isArray(index)) throw new Error(`${SAR_INDEX}: not a list of services`);
  const sar = {};
  for (const service of ABAC_SERVICES) {
    const entry = index.find((e) => e.service === service);
    if (!entry?.url) throw new Error(`the Service Authorization Reference has no ${service}`);
    const doc = await getJson(entry.url);
    if (!Array.isArray(doc.Actions)) throw new Error(`${service}: no Actions (has the reference's shape changed?)`);
    sar[service] = doc;
  }
  return sar;
}

function render() {
  const abac = JSON.parse(readFileSync(ABAC_FILE, "utf8"));
  const out = renderLabPolicies(abac);
  const fill = { account: "123456789012", vpcArns: ["arn:aws:ec2:eu-west-2:123456789012:vpc/vpc-0123456789abcdef0", "arn:aws:ec2:eu-west-1:123456789012:vpc/vpc-0123456789abcdef0"] };
  const sizes = out.role.map((d) => policySize(d, fill));
  return { out, sizes, boundary: policySize(out.boundary, fill) };
}

function report({ out, sizes, boundary }) {
  console.log(`role: ${out.role.length} of at most ${ROLE_POLICIES_MAX} policies; characters (under ${POLICY_MAX} each): ${sizes.join(", ")}; boundary ${boundary}`);
  console.log(out.changeFallback ? "change list: TOO LONG for 10 policies, so A29's fall-back is used (<svc>:Delete*, Modify*, Update*, Terminate*)" : "change list: as generated");
}

async function main(args) {
  if (args.includes("--check")) {
    const r = render();
    if (readFileSync(POLICIES_FILE, "utf8").replace(/\r\n/g, "\n") !== json(r.out)) {
      console.error("aws-labs-abac: lab-policies.json is not what --render writes from lab-abac.json; run node scripts/aws-labs-abac.mjs --render");
      return 1;
    }
    console.log("aws-labs-abac: lab-policies.json is up to date");
    return 0;
  }
  if (!args.includes("--render")) {
    const sar = await fetchSar();
    const lists = abacLists(sar);
    const abac = { source: SAR_INDEX, fetched: new Date().toISOString().slice(0, 10), services: [...ABAC_SERVICES], ...lists };
    writeFileSync(ABAC_FILE, json(abac));
    console.log(`lab-abac.json: ${lists.create.length} create, ${lists.change.length} change (${Object.keys(lists.createOn).length} creates refused on their own type only), ${lists.untag.length} untag`);
  }
  const r = render();
  writeFileSync(POLICIES_FILE, json(r.out));
  report(r);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => (process.exitCode = code),
  (e) => {
    console.error(`aws-labs-abac: ${e.message}`);
    process.exitCode = 2;
  },
);
