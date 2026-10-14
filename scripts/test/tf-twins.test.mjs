// tf-twins.test.mjs
//
// Plain English: Azure and AWS build the same peer list the same way: one copy
// each, kept identical. This test fails if one copy is edited without the other.
// Azure-only lines inside that range (subnet_cidr6, the common_tags map) and
// comments are ignored; everything else must match exactly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const block = (f) => {
  const t = readFileSync(f, "utf8").replace(/\r\n/g, "\n");
  const a = t.indexOf("  peers = [");
  const b = t.indexOf("\n  ])\n", t.indexOf("  peers_conf ="));
  assert.ok(a > 0 && b > a, `${f}: peers..peers_conf block not found`);
  return t
    .slice(a, b)
    .replace(/^\s*common_tags\s*=\s*\{[\s\S]*?^\s*\}\s*$/m, "") // whole multi-line map
    .split("\n")
    .filter((l) => !/^\s*#/.test(l) && l.trim() !== "" && !/^\s*subnet_cidr6\s*=/.test(l))
    .join("\n");
};

test("peer and site-route logic is identical in both roots", () => {
  assert.equal(block("infra/aws/main.tf"), block("infra/main.tf"));
});
