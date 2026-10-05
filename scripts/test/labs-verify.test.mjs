// labs-verify.test.mjs
//
// Plain English: npm run labs-verify (scripts/labs-verify.mjs), the checks
// that need the internet and so never run in npm test: every readme link
// answers 200, and every retail meter a lab.yaml names has one clear uksouth
// price the Worker's price feed can use. Here the parts are tested with
// made-up price rows and a fake fetch; nothing goes on the network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LAB_UNITS, meterProblems, readmeLinks, skuProblems, verifyLabs } from "../labs-verify.mjs";

const PKG = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
/** A Retail Prices API row, uksouth, GBP, pay as you go. */
const row = (over) => ({ currencyCode: "GBP", type: "Consumption", armRegionName: "uksouth", location: "UK South", isPrimaryMeterRegion: true, tierMinimumUnits: 0, ...over });

test("readmeLinks takes every https link from a readme", () => {
  const md = [
    "Covers [the AZ-104 outline](https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/az-104).",
    "",
    "## Learn more",
    "",
    "- [VNet peering](https://learn.microsoft.com/en-us/azure/virtual-network/virtual-network-peering-overview)",
    "- [Two on a line](https://learn.microsoft.com/a) and [b](https://learn.microsoft.com/b#part)",
    "- [Not https](http://example.com/x), `https://in-code.example.com`",
    "- [Again](https://learn.microsoft.com/a)",
  ].join("\n");
  assert.deepEqual(readmeLinks(md), [
    "https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/az-104",
    "https://learn.microsoft.com/en-us/azure/virtual-network/virtual-network-peering-overview",
    "https://learn.microsoft.com/a",
    "https://learn.microsoft.com/b#part",
  ]);
});

test("meterProblems flags a meter two products share at different prices, a unit the feed cannot use, and a meter with no uksouth row", () => {
  // One product, the unit lab.yaml says: fine.
  assert.deepEqual(meterProblems([row({ meterName: "S4 LRS Disk", productName: "Standard HDD Managed Disks", retailPrice: 1.3, unitOfMeasure: "1/Month" })], { meter: "S4 LRS Disk", unit: "1/Month" }), []);
  // Two products, the same price: still one answer.
  assert.deepEqual(meterProblems([row({ meterName: "X", productName: "A", retailPrice: 0.5, unitOfMeasure: "1 Hour" }), row({ meterName: "X", productName: "B", retailPrice: 0.5, unitOfMeasure: "1 Hour" })], { meter: "X", unit: "1 Hour" }), []);
  // Shared by two products at different prices (P0v3 App: Linux and Windows plans): the feed matches on the name alone.
  const shared = meterProblems(
    [row({ meterName: "Standard Fixed Cost", productName: "Application Gateway Standard v2", retailPrice: 0.18, unitOfMeasure: "1/Hour" }), row({ meterName: "Standard Fixed Cost", productName: "Application Gateway WAF v2", retailPrice: 0.33, unitOfMeasure: "1/Hour" })],
    { meter: "Standard Fixed Cost", unit: "1/Hour" },
  );
  assert.equal(shared.length, 1);
  assert.match(shared[0], /Standard Fixed Cost.*2 prices.*Application Gateway Standard v2.*Application Gateway WAF v2/);
  // Tiers of one product are different prices too (DNS zones).
  assert.match(meterProblems([row({ meterName: "Public Zone", productName: "Azure DNS", retailPrice: 0.4, unitOfMeasure: "1/Month" }), row({ meterName: "Public Zone", productName: "Azure DNS", retailPrice: 0.08, unitOfMeasure: "1/Month", tierMinimumUnits: 25 })], { meter: "Public Zone", unit: "1/Month" })[0], /2 prices/);
  // Rows naming Windows are dropped as the feed drops them, but App Service's Windows plan does not say so:
  // P0v3 App is kept twice, at the Linux and the Windows price (ruling 2), so it stays authored.
  assert.deepEqual(meterProblems([row({ meterName: "P0v3 App", productName: "Azure App Service Premium v3 Plan - Linux", retailPrice: 0.0653, unitOfMeasure: "1 Hour" }), row({ meterName: "P0v3 App", productName: "Azure App Service Premium v3 Plan", skuName: "P0 v3", retailPrice: 0.1257, unitOfMeasure: "1 Hour" })], { meter: "P0v3 App", unit: "1 Hour" }).length, 1);
  // A unit the feed cannot turn into £ per hour.
  assert.match(meterProblems([row({ meterName: "Memory Duration", productName: "Container Instances", retailPrice: 0.004, unitOfMeasure: "1 GB Hour" })], { meter: "Memory Duration", unit: "1 GB Hour" })[0], /unit "1 GB Hour".*cannot use/);
  // lab.yaml's unit differs from Azure's.
  assert.match(meterProblems([row({ meterName: "E1 LRS Disk", productName: "Standard SSD Managed Disks", retailPrice: 0.25, unitOfMeasure: "1/Month" })], { meter: "E1 LRS Disk", unit: "1 Hour" })[0], /lab\.yaml says "1 Hour".*Azure prices it per "1\/Month"/);
  // No row in uksouth at all.
  assert.match(meterProblems([], { meter: "Nonexistent Meter", unit: "1 Hour" })[0], /no uksouth row/);
  assert.match(meterProblems([row({ meterName: "X", armRegionName: "ukwest", productName: "A", retailPrice: 1, unitOfMeasure: "1 Hour" })], { meter: "X", unit: "1 Hour" })[0], /no uksouth row/);
  assert.deepEqual([...LAB_UNITS].sort(), ["1 Hour", "1/Day", "1/Hour", "1/Month"]);
});

test("skuProblems wants one Linux pay-as-you-go hourly price for a VM size", () => {
  const linux = row({ armSkuName: "Standard_B1s", meterName: "B1s", productName: "Virtual Machines BS Series", retailPrice: 0.0092, unitOfMeasure: "1 Hour" });
  const windows = row({ armSkuName: "Standard_B1s", meterName: "B1s", productName: "Virtual Machines BS Series Windows", retailPrice: 0.0166, unitOfMeasure: "1 Hour" });
  const spot = row({ armSkuName: "Standard_B1s", meterName: "B1s Spot", productName: "Virtual Machines BS Series", retailPrice: 0.002, unitOfMeasure: "1 Hour" });
  assert.deepEqual(skuProblems([linux, windows, spot], "Standard_B1s"), []);
  assert.match(skuProblems([windows], "Standard_B1s")[0], /no Linux pay-as-you-go/);
});

// Labs batch 3, C0.6 (ruling 26): an item with `region: secondary` is priced in the lab's secondary region.
test("labs-verify checks a secondary-region meter in ukwest", async () => {
  const asked = [];
  const fetch = async (url) => {
    const filter = decodeURIComponent(new URL(url).searchParams.get("$filter"));
    asked.push(filter);
    const region = /armRegionName eq '([a-z0-9]+)'/.exec(filter)[1];
    if (filter.includes("B DTU")) return Response.json({ Items: [row({ armRegionName: region, meterName: "B DTU", productName: "SQL Database Single Basic", retailPrice: 0.1517, unitOfMeasure: "1/Day" })] });
    if (filter.includes("B Secondary Active DTU")) return Response.json({ Items: region === "ukwest" ? [row({ armRegionName: "ukwest", location: "UK West", meterName: "B Secondary Active DTU", productName: "SQL Database Single Basic", retailPrice: 0.1517, unitOfMeasure: "1/Day" })] : [] });
    return Response.json({ Items: [] });
  };
  const lab = {
    id: "az305-23-sql-failover",
    readme: "",
    secondary: "ukwest",
    items: [
      { name: "Basic primary", gbp_h: 0.0063, retail: { meter: "B DTU", unit: "1/Day" } },
      { name: "Basic geo-secondary", gbp_h: 0.0063, region: "secondary", retail: { meter: "B Secondary Active DTU", unit: "1/Day" } },
    ],
  };
  const { problems, lines } = await verifyLabs([lab], { links: false, meters: true, fetch });
  assert.deepEqual(problems, []);
  assert.ok(asked.some((f) => f.startsWith("armRegionName eq 'ukwest' and meterName eq 'B Secondary Active DTU'")), asked.join("\n"));
  assert.ok(asked.some((f) => f.startsWith("armRegionName eq 'uksouth' and meterName eq 'B DTU'")), asked.join("\n"));
  assert.ok(lines.some((l) => /B Secondary Active DTU \(ukwest\): £0\.1517\/1\/Day/.test(l)), lines.join("\n"));
  // Not in the secondary region: a problem naming it.
  const wrong = await verifyLabs([{ ...lab, items: [{ ...lab.items[1], retail: { meter: "B DTU-only-in-uksouth", unit: "1/Day" } }] }], { links: false, meters: true, fetch });
  assert.match(wrong.problems.join("\n"), /no ukwest row/);
  // A secondary item in a lab with no secondary region is a problem, not a uksouth lookup.
  const lone = await verifyLabs([{ ...lab, secondary: null }], { links: false, meters: true, fetch });
  assert.match(lone.problems.join("\n"), /region: secondary but the lab has no regions\.secondary/);
});

test("verifyLabs checks each lab's links and meters with the fetch it is given", async () => {
  const asked = [];
  const fetch = async (url, init = {}) => {
    asked.push(`${init.method ?? "GET"} ${url}`);
    if (String(url).startsWith("https://prices.azure.com/")) {
      const filter = decodeURIComponent(new URL(url).searchParams.get("$filter"));
      if (filter.includes("S4 LRS Disk")) return Response.json({ Items: [row({ meterName: "S4 LRS Disk", productName: "Standard HDD Managed Disks", retailPrice: 1.3, unitOfMeasure: "1/Month" })] });
      if (filter.includes("Standard_B1s")) return Response.json({ Items: [row({ armSkuName: "Standard_B1s", meterName: "B1s", productName: "Virtual Machines BS Series", retailPrice: 0.0092, unitOfMeasure: "1 Hour" })] });
      return Response.json({ Items: [] });
    }
    return new Response("", { status: String(url).endsWith("/missing") ? 404 : 200 });
  };
  const labs = [
    {
      id: "az104-07-files",
      readme: "[ok](https://learn.microsoft.com/en-us/azure/storage/files/) and [gone](https://learn.microsoft.com/missing)",
      items: [
        { name: "VM", gbp_h: 0.0092, retail: { sku: "Standard_B1s" } },
        { name: "Disk", gbp_h: 0.0018, retail: { meter: "S4 LRS Disk", unit: "1/Month" } },
        { name: "Authored", gbp_h: 0.0001 },
      ],
    },
  ];
  const { problems, lines } = await verifyLabs(labs, { links: true, meters: true, fetch });
  assert.deepEqual(problems, ["az104-07-files: https://learn.microsoft.com/missing answered 404"]);
  assert.ok(lines.some((l) => /S4 LRS Disk: £1\.3\/1\/Month = £0\.0018\/h \(authored £0\.0018\/h\)/.test(l)), lines.join("\n"));
  assert.ok(asked.every((a) => /^(HEAD|GET) https:\/\/(learn\.microsoft\.com|prices\.azure\.com)\//.test(a)), asked.join("\n"));
  // Links only: no price calls.
  asked.length = 0;
  await verifyLabs(labs, { links: true, meters: false, fetch });
  assert.ok(!asked.some((a) => a.includes("prices.azure.com")));
});

test("labs-verify is an npm script and never runs in npm test", () => {
  assert.equal(PKG.scripts["labs-verify"], "node scripts/labs-verify.mjs");
  assert.doesNotMatch(PKG.scripts.test, /labs-verify/);
  for (const [name, script] of Object.entries(PKG.scripts)) if (name !== "labs-verify") assert.doesNotMatch(script, /labs-verify/, name);
});
