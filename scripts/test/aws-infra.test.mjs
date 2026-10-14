// aws-infra.test.mjs
//
// Plain English: pins the small AWS infrastructure details from issue #122 that
// nothing else would notice slipping: the server's network card is attached the
// current way, the deploy role may not delete another project's network cards
// or detach its public addresses, the Worker may list volumes, CI renders the
// AWS cloud-init as well as Azure's, and test fixtures stay byte-stable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import YAML from "yaml";

const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const bootstrap = read("infra/aws-bootstrap/main.tf");

/** The text of one `Sid = "..."` statement, up to the next Sid or the end of the policy. */
function statement(sid) {
  const i = bootstrap.search(new RegExp(`Sid\\s+= "${sid}"`));
  assert.ok(i >= 0, `statement ${sid} exists`);
  const rest = bootstrap.slice(i + 1);
  const j = rest.search(/Sid\s+=\s+"/);
  return j < 0 ? rest : rest.slice(0, j);
}

test("the AWS instance uses primary_network_interface, not the deprecated block", () => {
  const tf = read("infra/aws/main.tf");
  assert.match(tf, /^\s+primary_network_interface \{\s*\n\s+network_interface_id = aws_network_interface\.wg\.id\s*\n\s*\}/m);
  assert.doesNotMatch(tf, /^\s+network_interface \{/m);
  assert.match(tf, /source_dest_check\s+= false/, "forwarding stays on the ENI");
});

test("the deploy role cannot delete network cards or detach addresses unless tagged wg-admin=vpn", () => {
  const deny = statement("OnlyWgAdminThings");
  assert.match(deny, /Effect\s+= "Deny"/);
  assert.match(deny, /"ec2:DeleteNetworkInterface"/);
  assert.match(deny, /"ec2:DisassociateAddress"/);
  assert.match(deny, /StringNotEquals = \{ "aws:ResourceTag\/wg-admin" = "vpn" \}/);
});

test("the Worker's IAM user may look at volumes (read only)", () => {
  const look = statement("Look");
  assert.match(look, /"ec2:DescribeVolumes"/);
  assert.doesNotMatch(look, /ec2:(Delete|Create|Modify)/);
});

test("ci.yml renders the AWS cloud-init too, with the placeholder-leak check", () => {
  const ci = YAML.parse(read(".github/workflows/ci.yml"));
  const all = Object.values(ci.jobs).flatMap((j) => j.steps ?? []);
  const step = all.find((s) => s.name === "render cloud-init (AWS)") ?? assert.fail("missing AWS render step");
  assert.match(step.run, /render-aws\/aws/);
  assert.match(step.run, /local\.cloud_init/);
  assert.match(step.run, /unrendered Terraform placeholder/);
  // The shell in cloud-init is full of single "$"; only an unescaped "$$" means a leak (as in the Azure step).
  assert.match(step.run, /assert "\$\$" not in text/);
  assert.doesNotMatch(step.run, /assert "\$" not in text/);
  assert.ok(all.some((s) => s.name === "render cloud-init"), "the Azure step is still there");
});

test(".gitattributes keeps worker test fixtures byte-stable", () => {
  assert.match(read(".gitattributes"), /^worker\/test\/fixtures\/\*\* -text$/m);
});
