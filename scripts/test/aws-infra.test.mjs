// aws-infra.test.mjs
//
// Plain English: pins the small AWS infrastructure details from issue #122 that
// nothing else would notice slipping: the server's network card is attached the
// current way, the deploy role may not delete another project's network cards
// or detach its public addresses, the Worker may list volumes, CI renders the
// AWS cloud-init as well as Azure's, and test fixtures stay byte-stable. Also the
// Worker's read-only AWS insights permissions (AWS insights spec section 8).
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

test("the Worker's IAM user may read the AWS insights figures, in its region, and change nothing", () => {
  const insights = statement("Insights");
  for (const a of ["cloudwatch:GetMetricData", "ec2:DescribeInstanceStatus", "ec2:DescribeInstanceTypeOfferings", "ec2:DescribeInstanceTypes", "cloudtrail:LookupEvents", "servicequotas:GetServiceQuota"]) {
    assert.ok(insights.includes(`"${a}"`), `Insights allows ${a}`);
  }
  const actions = insights.match(/Action\s+= \[([^\]]*)\]/)?.[1] ?? "";
  assert.equal(actions.split(",").length, 6, "exactly the six actions");
  assert.match(insights, /Effect\s+= "Allow"/);
  assert.match(insights, /Condition = \{ StringEquals = \{ "aws:RequestedRegion" = \[var\.region, "eu-west-1"\] \} \}/);
  assert.doesNotMatch(insights, /:(Delete|Create|Modify|Put|Update|Start|Stop|Terminate|Run)/);
  // The Price List API is us-east-1 only: its own statement, without the region condition.
  const prices = statement("InsightsPriceList");
  assert.match(prices, /Action\s+= \["pricing:GetProducts"\]/);
  assert.doesNotMatch(prices, /RequestedRegion/);
});

test("the Worker may read only its own server's console output", () => {
  const console_ = statement("ConsoleOfOurServer");
  assert.match(console_, /Effect\s+= "Allow"/);
  assert.match(console_, /Action\s+= \["ec2:GetConsoleOutput"\]/);
  assert.match(console_, /Resource\s+= "arn:aws:ec2:\$\{var\.region\}:\$\{local\.account\}:instance\/\*"/);
  assert.match(console_, /Condition = \{ StringEquals = \{ "aws:ResourceTag\/wg-admin" = "vpn" \} \}/);
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

// The Worker's policy must be a customer managed policy: IAM caps a user's inline policies at 2,048 characters
// in total, and the labs read statements pushed it past that (apply failed with LimitExceeded).
test("the Worker's IAM policy is a managed policy attached to the user, under the 6,144-character cap", () => {
  assert.match(bootstrap, /resource "aws_iam_policy" "worker" \{\s+name\s+= "wg-admin-worker"/);
  assert.match(bootstrap, /resource "aws_iam_user_policy_attachment" "worker" \{\s+user\s+= aws_iam_user\.worker\.name\s+policy_arn = aws_iam_policy\.worker\.arn/);
  assert.doesNotMatch(bootstrap, /resource "aws_iam_user_policy" /, "no inline user policy remains");

  // Render the document: cut the jsonencode( ... ) body of the managed policy, turn the HCL into JSON, substitute.
  const start = bootstrap.indexOf("jsonencode(", bootstrap.indexOf('resource "aws_iam_policy" "worker"'));
  const open = bootstrap.indexOf("(", start) + 1;
  let depth = 1, i = open;
  for (; depth > 0; i++) depth += bootstrap[i] === "(" ? 1 : bootstrap[i] === ")" ? -1 : 0;
  const json = bootstrap.slice(open, i - 1)
    .split("\n").filter((l) => !/^\s*#/.test(l)).join("\n")
    .replace(/\$\{var\.region\}/g, "eu-west-2").replace(/\$\{local\.account\}/g, "123456789012")
    .replace(/\bvar\.region\b/g, '"eu-west-2"')
    .replace(/([{,]\s*|^\s*)([A-Za-z_]\w*)\s*=/gm, '$1"$2":').replace(/("[^"\n]+")\s*=\s*/g, "$1:")
    .replace(/([^,{[(\s])[ \t]*\n(\s*"[^"\n]+":)/g, "$1,\n$2") // HCL separates object attributes by newline
    .replace(/,(\s*[}\]])/g, "$1");
  const doc = JSON.parse(json);
  assert.ok(doc.Statement.length > 5, "parsed the whole document");
  const size = JSON.stringify(doc).length;
  assert.ok(size < 6000, `compact policy is ${size} characters; the managed-policy cap is 6,144`);
});
