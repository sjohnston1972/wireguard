// agent-wan.test.mjs
// Plain English: the agent scripts and the boot template must not assume the
// WAN interface is eth0 (AWS calls it ens5), and must write the cloud's name
// and WAN interface for the agent to read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

test("agent scripts read the WAN interface from WAN_IF", () => {
  for (const f of readdirSync("infra/agent").filter((f) => f.endsWith(".sh"))) {
    const lines = readFileSync(`infra/agent/${f}`, "utf8").split("\n");
    lines.forEach((l, i) => {
      if (/^\s*#/.test(l) || !/\beth0\b/.test(l)) return;
      assert.ok(/WAN_IF/.test(l), `${f}:${i + 1} uses eth0 without WAN_IF: ${l.trim()}`);
    });
  }
});

test("the template writes CLOUD and WAN_IF for the agent, and has no fixed azureuser", () => {
  const t = readFileSync("infra/cloud-init.yaml.tftpl", "utf8");
  assert.match(t, /CLOUD=\$\{cloud\}/);
  assert.match(t, /WAN_IF=\$\{wan_if\}/);
  assert.doesNotMatch(t, /name: azureuser/);
  assert.match(t, /%\{ if boot_bundle_sha256 != "" ~\}/);
});
