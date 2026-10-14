// boot-bundle.test.mjs
//
// Plain English: the boot bundle carries each file with the same mode cloud-init would have given it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("bundle paths and modes match the template", () => {
  const tpl = readFileSync("infra/cloud-init.yaml.tftpl", "utf8").replace(/\r\n/g, "\n");
  const modes = new Map([...tpl.matchAll(/- path: (\S+)\n\s+permissions: "(\d+)"/g)].map((m) => [m[1], m[2]]));
  const sh = readFileSync("infra/ci/boot-bundle.sh", "utf8").replace(/\r\n/g, "\n");
  const puts = [...sh.matchAll(/^put "\$root\/(\S+)" (\S+) (\d+)$/gm)].map((m) => ({ src: m[1], path: m[2], mode: m[3] }));
  assert.ok(puts.length >= 7, "boot-bundle.sh puts the agent scripts");
  for (const p of puts) assert.equal(p.mode, modes.get(p.path), `${p.path} mode`);
  assert.equal(modes.get("/etc/wg-admin/firewall.nft"), "0600");
  assert.match(sh, /install -D -m 0600 .*etc\/wg-admin\/firewall\.nft/);
});
