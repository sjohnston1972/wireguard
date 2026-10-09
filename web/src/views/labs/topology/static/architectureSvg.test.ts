// The readme's architecture diagram (static/architectureSvg.ts): the interactive diagram's own layout and routing,
// drawn once as a self-contained SVG. Pure; no DOM.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TopologyGraph } from "@shared/topology/model";
import { absoluteBoxes, layoutTopology } from "../layout";
import { stackGraph } from "../stacks";
import { routeAll } from "../edges/router";
import { edgeSpecs } from "../edges/specs";
import { nodeIndex } from "../words";
import { architectureSvg, describeGraph, fitText, spriteSymbols, textWidth } from "./architectureSvg";

// jsdom gives import.meta.url an http: scheme, so find the repo from the working directory (repo root or web/).
const repo = [process.cwd(), join(process.cwd(), "..")].find((p) => existsSync(join(p, "shared/topology/planned")))!;
const planned = (id: string): TopologyGraph => JSON.parse(readFileSync(join(repo, "shared/topology/planned", `${id}.json`), "utf8"));
const sprite = readFileSync(join(repo, "web/src/views/labs/topology/icons/azure.svg"), "utf8");
const LB = "az104-16-lb-appgw";

describe("architectureSvg", () => {
  it("is deterministic: the same graph in any order gives the same bytes", () => {
    const g = planned(LB);
    const a = architectureSvg(g, { sprite, title: "t" });
    const b = architectureSvg({ ...g, nodes: [...g.nodes].reverse(), edges: [...g.edges].reverse() }, { sprite, title: "t" });
    expect(b.svg).toBe(a.svg);
  });

  it("is self-contained: every icon it uses is inside it, and nothing points outside", () => {
    const { svg } = architectureSvg(planned("az305-28-three-tier"), { sprite, title: "t" });
    const used = [...new Set([...svg.matchAll(/ href="#(az-[^"]+)"/g)].map((m) => m[1]!))];
    expect(used.length).toBeGreaterThan(5);
    for (const id of used) expect(svg).toContain(`<symbol id="${id}"`);
    // Only the icons it uses: not the whole sprite.
    expect([...svg.matchAll(/<symbol /g)].length).toBe(used.length);
    expect(svg).not.toMatch(/(?:href|src)="(?:https?:|data:|\/\/)|<script|<foreignObject|<image/);
    expect(svg.length).toBeLessThan(150_000);
  });

  it("draws every box where the interactive diagram puts it, and every line along the router's route", () => {
    const g = planned(LB);
    const { svg } = architectureSvg(g, { sprite, title: "t" });
    const stacked = stackGraph(g).graph;
    const byId = nodeIndex(stacked);
    const laid = layoutTopology(stacked, null);
    const abs = absoluteBoxes(laid);
    // Each card's outline at its laid-out spot (half a pixel in, for the stroke).
    for (const n of stacked.nodes.filter((x) => x.kind === "vm" || x.kind === "loadBalancer" || x.kind === "appGateway")) {
      const b = abs.get(n.id)!;
      expect(svg).toContain(`<rect x="${b.x + 0.5}" y="${b.y + 0.5}" width="${b.w - 1}" height="${b.h - 1}" rx="10"`);
      expect(svg).toContain(`>${n.label}</text>`);
    }
    const boxes = laid.nodes.map((l) => ({ id: l.id, ...abs.get(l.id)!, group: ["resourceGroup", "vnet", "subnet", "virtualHub", "lane"].includes(byId.get(l.id)!.kind), head: byId.get(l.id)!.kind === "subnet" ? 28 : 36 }));
    const specs = edgeSpecs(stacked, byId);
    const routes = routeAll({ boxes: boxes.map((b) => (b.group ? b : { ...b, head: 0 })), edges: specs.map((s) => ({ id: s.edge.id, from: s.edge.from, to: s.edge.to, label: s.carriesLabel ? (s.label ?? null) : null })) });
    for (const r of routes.values()) expect(svg).toContain(`d="${r.path}"`);
    // The labels and the colour of each source, and the legend naming them.
    expect(svg).toContain(">HTTP 80→80</text>");
    expect(svg).toContain(">TCP 80→80</text>");
    expect(svg).toContain(">from agw-web</text>");
    expect(svg).toContain(">from lbi-web</text>");
    expect(svg).toMatch(/stroke="#0b62b0"[^>]*marker-end="url\(#arrow-1\)"/);
  });

  it("names two sources of one name by their container in the legend", () => {
    const { svg } = architectureSvg(planned("az104-14-peering-udr"), { sprite, title: "t" });
    expect(svg).toMatch(/>from snet-workload \(vnet-spoke\d\)<\/text>/);
  });

  it("carries a title and a description for screen readers, escaped", () => {
    const { svg, description } = architectureSvg(planned(LB), { sprite, title: "Load <Balancer> & Gateway" });
    expect(svg).toContain('<title id="t">Load &lt;Balancer&gt; &amp; Gateway</title>');
    expect(svg).toContain(`<desc id="d">${description}</desc>`);
    expect(svg).toMatch(/^<svg [^>]*role="img" aria-labelledby="t d"/);
  });

  it("draws every planned lab within the size cap", () => {
    for (const id of ["az700-40-lb-advanced", "az700-43-private-link", "az305-20-landing-zone"]) {
      const r = architectureSvg(planned(id), { sprite, title: id });
      expect(r.width).toBeGreaterThan(400);
      expect(r.svg.length).toBeLessThan(150_000);
    }
  });
});

describe("describeGraph", () => {
  it("says what sends traffic to what, and where", () => {
    expect(describeGraph(planned(LB))).toBe("An application gateway and a load balancer sending traffic to two VMs, in one resource group with one virtual network and two subnets.");
    expect(describeGraph(planned("az305-27-multi-region"))).toBe("A Front Door and a Traffic Manager profile sending traffic to two container groups, across two resource groups.");
  });
  it("says what there is when nothing sends traffic", () => {
    expect(describeGraph(planned("az104-05-storage"))).toBe("Two storage accounts, in one resource group.");
  });
});

describe("text fitting", () => {
  it("cuts a long name short with an ellipsis, and errs wide", () => {
    expect(fitText("vm-web1", 138, 12, { bold: true })).toBe("vm-web1");
    const cut = fitText("privatelink.database.windows.net", 138, 12, { bold: true });
    expect(cut.endsWith("…")).toBe(true);
    expect(textWidth(cut, 12, { bold: true })).toBeLessThanOrEqual(138);
    expect(textWidth("mmmm", 10)).toBeGreaterThan(textWidth("iiii", 10));
  });
  it("finds the sprite's symbols by icon name", () => {
    const s = spriteSymbols(sprite);
    expect(s.get("virtual-machine")).toMatch(/^<symbol id="az-virtual-machine"/);
  });
});
