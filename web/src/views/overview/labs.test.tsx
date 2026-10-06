// labs.test.tsx
//
// Plain English: the Overview's lab integrations (Labs spec section 10).
// With no lab running the page is exactly as before; while labs run they
// show beside the Azure VNet (solid line when peered, dashed when waiting
// or disconnected), the banner says how many and what they cost, Running
// offers Re-peer when sessions wait, and the off-by-default Running labs
// widget lists time left, cost so far and Tear down.
import "./testSetup";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LabSession, OverviewResponse } from "@shared/api";
import { renderApp } from "@/test/render";
import { labDetailFixture, labSessionFixture } from "@/test/fixtures";
import { PLANNED_URL, TOPOLOGY_API, layoutServer, liveDown, liveOk, plannedGraph } from "@/views/labs/topology/places.fixtures";
import { MINI_DELAY_MS } from "./LabMiniHover";
import { overview, prefsRoutes, routes, saved } from "./testData";

const HERE = dirname(fileURLToPath(import.meta.url));

beforeAll(async () => {
  await import("./LabsParts");
});

const withLabs = (o: OverviewResponse, running: LabSession[], rePeer = 0): OverviewResponse => ({
  ...o,
  labs: { running, gbpH: running.reduce((n, s) => n + s.estGbpH, 0), rePeer },
});
const lab2 = () => labSessionFixture({ id: "ls-2", labId: "az104-04-budgets", title: "Budgets and action groups", estGbpH: 0.11, costGbp: 0.2, peering: "waiting", slot: 1 });
const ON = { layout: { hidden: ["overview.costImpact"], shown: ["overview.runningLabs"] } };
const region = (name: string) => screen.findByRole("region", { name });

describe("Overview with no labs", () => {
  it("with no labs overview renders exactly as before", async () => {
    renderApp("/", { routes: routes(overview("running")) });
    const banner = await region("Status");
    expect(banner).not.toHaveTextContent(/lab/i);
    expect(within(banner).queryByRole("button", { name: /re-peer/i })).toBeNull();
    const topo = await region("Live topology");
    expect(topo.querySelectorAll(".ov-node")).toHaveLength(3);
    expect(topo.querySelector(".ov-labs")).toBeNull();
    expect(screen.queryByRole("region", { name: "Running labs" })).toBeNull();
  });
});

describe("Overview with labs running", () => {
  it("running labs appear as boxes beside the Azure VNet, solid when peered, dashed when waiting or disconnected", async () => {
    renderApp("/", { routes: routes(withLabs(overview("running"), [labSessionFixture(), lab2(), labSessionFixture({ id: "ls-3", labId: "az104-05-storage", title: "Storage", peering: "disconnected" }), labSessionFixture({ id: "ls-4", labId: "az104-07-files", title: "Files", peering: "off" })])) });
    const topo = await region("Live topology");
    const boxes = await within(topo).findAllByRole("link", { name: /^Lab /i });
    expect(boxes).toHaveLength(4);
    expect(boxes[0]).toHaveAccessibleName(/Blob security.*peered/);
    expect(boxes[0]).toHaveAttribute("href", "/labs/az104-06-blob-security");
    const edge = (i: number) => boxes[i].closest(".ov-lab")!.querySelector(".ov-lab__edge");
    expect(edge(0)).toHaveAttribute("data-peering", "on");
    expect(edge(1)).toHaveAttribute("data-peering", "waiting");
    expect(edge(2)).toHaveAttribute("data-peering", "disconnected");
    expect(edge(3)).toBeNull(); // not peered: no line, and the word says so
    expect(boxes[1]).toHaveTextContent("waiting to peer");
    expect(boxes[2]).toHaveTextContent("disconnected");
    expect(boxes[3]).toHaveTextContent("not peered");
    // The other three nodes are where they were.
    expect(topo.querySelectorAll(".ov-node")).toHaveLength(3);
  });

  it("banner adds · 2 labs running (£0.12/h)", async () => {
    renderApp("/", { routes: routes(withLabs(overview("running"), [labSessionFixture({ estGbpH: 0.01 }), lab2()])) });
    const banner = await region("Status");
    expect(banner).toHaveTextContent("· 2 labs running (£0.12/h)");
  });

  it("the banner says one lab, and it still reads right with the VM gone", async () => {
    renderApp("/", { routes: routes(withLabs(overview("destroyed"), [labSessionFixture({ estGbpH: 0.0082 })])) });
    const banner = await region("Status");
    expect(banner).toHaveTextContent("1 lab running (£0.01/h)");
    expect(banner).not.toHaveTextContent("Nothing in Azure, £0");
  });

  it("Re-peer 2 labs shows on Running when sessions wait and posts repeer", async () => {
    const user = userEvent.setup();
    const r = renderApp("/", { routes: routes(withLabs(overview("running"), [lab2(), labSessionFixture({ peering: "disconnected" })], 2), { "POST /api/v1/labs/repeer": { ok: true, message: "Peering 2 labs." } }) });
    const banner = await region("Status");
    await user.click(await within(banner).findByRole("button", { name: "Re-peer 2 labs" }));
    await waitFor(() => expect(r.fetchMock!.callsTo("POST", "/api/v1/labs/repeer")).toHaveLength(1));
  });

  it("no Re-peer when every lab is peered, or while the VM is not running", async () => {
    const a = renderApp("/", { routes: routes(withLabs(overview("running"), [labSessionFixture()], 0)) });
    expect(within(await region("Status")).queryByRole("button", { name: /re-peer/i })).toBeNull();
    a.unmount();
    renderApp("/", { routes: routes(withLabs(overview("standby"), [lab2()], 1)) });
    expect(within(await region("Status")).queryByRole("button", { name: /re-peer/i })).toBeNull();
  });
});

describe("Overview Running labs widget", () => {
  it("is off by default", async () => {
    renderApp("/", { routes: routes(withLabs(overview("running"), [labSessionFixture()])) });
    await region("Status");
    expect(screen.queryByRole("region", { name: "Running labs" })).toBeNull();
    expect(screen.getByRole("region", { name: "Cost impact" })).toBeInTheDocument();
  });

  it("runningLabs widget lists time left, cost so far and Tear down", async () => {
    const user = userEvent.setup();
    const r = renderApp("/", { routes: { ...prefsRoutes(withLabs(overview("running"), [labSessionFixture(), lab2()]), ON), "POST /api/v1/labs/az104-06-blob-security/destroy": { ok: true, message: "Tearing down." } } });
    const w = await region("Running labs");
    const row = await within(w).findByRole("listitem", { name: /Blob security/ });
    expect(row).toHaveTextContent(/1h 1[0-5]m left/);
    expect(row).toHaveTextContent("£0.01 so far");
    expect(row).toHaveTextContent("peered");
    expect(within(w).getByRole("listitem", { name: /Budgets/ })).toHaveTextContent("waiting to peer");
    await user.click(within(row).getByRole("button", { name: "Tear down Blob security: SAS, access policies, private endpoint" }));
    const dlg = await screen.findByRole("dialog", { name: "Tear down this lab?" });
    expect(r.fetchMock!.callsTo("POST", "/api/v1/labs/")).toHaveLength(0);
    await user.click(within(dlg).getByRole("button", { name: "Tear down now" }));
    await waitFor(() => expect(r.fetchMock!.callsTo("POST", "/api/v1/labs/az104-06-blob-security/destroy")).toHaveLength(1));
  });

  it("a lab already tearing down offers no Tear down and no time left", async () => {
    const past = new Date(Date.now() - 4 * 60_000).toISOString();
    const going = labSessionFixture({ state: "tearing_down", autoDestroyAt: past, endReason: "timer" });
    renderApp("/", { routes: prefsRoutes(withLabs(overview("running"), [going, lab2()]), ON) });
    const w = await region("Running labs");
    const row = await within(w).findByRole("listitem", { name: /Blob security/ });
    expect(row).toHaveTextContent("Tearing down");
    expect(row).not.toHaveTextContent(/ending now|left/);
    expect(within(row).queryByRole("button", { name: /Tear down/ })).toBeNull();
    // The other lab still has its button.
    expect(within(within(w).getByRole("listitem", { name: /Budgets/ })).getByRole("button", { name: /Tear down/ })).toBeInTheDocument();
  });

  it("its settings hide cost so far and the peering word", async () => {
    renderApp("/", { routes: prefsRoutes(withLabs(overview("running"), [labSessionFixture()]), { ...saved("overview.runningLabs", { costSoFar: false, peering: false }), ...ON }) });
    const w = await region("Running labs");
    const row = await within(w).findByRole("listitem", { name: /Blob security/ });
    expect(row).not.toHaveTextContent("so far");
    expect(row).not.toHaveTextContent("peered");
  });

  it("says nothing is running when it is on and no lab runs", async () => {
    renderApp("/", { routes: prefsRoutes(overview("running"), ON) });
    expect(await region("Running labs")).toHaveTextContent("No labs running");
  });
});

// ── Lab topology plan T2.6: a mini diagram on hover of a running lab's box ──

describe("the mini diagram on a running lab's box", () => {
  const LAB = "az104-06-blob-security";
  const miniRoutes = (more: Record<string, unknown> = {}) =>
    routes(withLabs(overview("running"), [labSessionFixture()]), { [`GET ${PLANNED_URL}`]: plannedGraph(), [`GET ${TOPOLOGY_API}`]: liveOk(), ...layoutServer().routes, ...more });
  /** A device with a mouse: (hover: hover) matches; everything else as the test's desktop. */
  const withHover = () => {
    const plain = window.matchMedia;
    vi.stubGlobal("matchMedia", (q: string) => (q.trim() === "(hover: hover)" ? { ...plain("(min-width: 0px)"), media: q, matches: true } : plain(q)));
  };
  const box = async () => within(await region("Live topology")).findByRole("link", { name: /^Lab Blob security/ });

  beforeAll(async () => {
    await import("./LabMiniHover");
    await import("@/views/labs/topology");
  });

  it("hovering a running lab's box for 400 ms opens the mini diagram", async () => {
    withHover();
    const user = userEvent.setup();
    renderApp("/", { routes: miniRoutes() });
    const b = await box();
    // The hover wrapper is there once its small chunk has loaded.
    await waitFor(() => expect(b.closest(".ov-lab__hover")).not.toBeNull());
    const t0 = performance.now();
    await user.hover(b);
    expect(screen.queryByRole("tooltip")).toBeNull();
    const tip = await screen.findByRole("tooltip");
    expect(performance.now() - t0).toBeGreaterThanOrEqual(MINI_DELAY_MS - 5);
    expect(MINI_DELAY_MS).toBe(400);
    expect(b).toHaveAttribute("aria-describedby", tip.id);
    // Live: the lab's resources, the hand-made one badged; no controls in the mini.
    const tree = await within(tip).findByRole("tree", { name: /diagram/i });
    expect(within(tree).getByRole("treeitem", { name: /nsg-handmade/ })).toHaveTextContent("Added by hand");
    expect(within(tip).getByText("Live · 3 resources · Open the lab")).toBeInTheDocument();
    expect(within(tip).queryByRole("button")).toBeNull();
    expect(within(tip).queryByRole("searchbox")).toBeNull();
    await user.unhover(b);
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  });

  it("keyboard focus opens it and Escape closes it", async () => {
    const user = userEvent.setup();
    renderApp("/", { routes: miniRoutes() });
    const b = await box();
    await waitFor(() => expect(b.closest(".ov-lab__hover")).not.toBeNull());
    act(() => b.focus());
    expect(await screen.findByRole("tooltip")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    expect(b).toHaveFocus();
  });

  it("the box is still a link to the lab", async () => {
    withHover();
    const user = userEvent.setup();
    renderApp("/", { routes: { ...miniRoutes(), [`GET /api/v1/labs/${LAB}`]: labDetailFixture() } });
    const b = await box();
    await waitFor(() => expect(b.closest(".ov-lab__hover")).not.toBeNull());
    expect(b).toHaveAttribute("href", `/labs/${LAB}`);
    await user.click(b);
    expect(screen.getByLabelText("location")).toHaveTextContent(`/labs/${LAB}`);
  });

  it("no mini on a hover-less device", async () => {
    const user = userEvent.setup();
    const r = renderApp("/", { routes: miniRoutes() });
    const b = await box();
    await waitFor(() => expect(b.closest(".ov-lab__hover")).not.toBeNull());
    await user.hover(b);
    await new Promise((res) => setTimeout(res, MINI_DELAY_MS + 300));
    expect(screen.queryByRole("tooltip")).toBeNull();
    // Nothing of the diagram was asked for.
    expect(r.fetchMock!.calls.some((c) => c.url.startsWith(TOPOLOGY_API) || c.url.startsWith(PLANNED_URL))).toBe(false);
  });

  it("the entry does not import the diagram chunk", () => {
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "");
    const topo = strip(readFileSync(join(HERE, "Topology.tsx"), "utf8"));
    const hover = strip(readFileSync(join(HERE, "LabMiniHover.tsx"), "utf8"));
    // The Overview (in the entry) reaches the hover wrapper only through lazy(); the wrapper reaches the diagram only through lazy().
    expect(topo).toMatch(/lazy\(\(\) => import\("\.\/LabMiniHover"\)\)/);
    expect(topo).not.toMatch(/^import[^;]*["']\.\/LabMiniHover["']/m);
    expect(topo).not.toMatch(/views\/labs\/topology|@xyflow/);
    expect(hover).toMatch(/lazy\(\(\) => import\("@\/views\/labs\/topology"\)/);
    expect(hover).not.toMatch(/^import[^;]*["'][^"']*labs\/topology["']/m);
    expect(hover).not.toMatch(/@xyflow/);
  });

  it("failed live data shows the planned graph in the mini with a word", async () => {
    withHover();
    const user = userEvent.setup();
    renderApp("/", { routes: miniRoutes({ [`GET ${TOPOLOGY_API}`]: liveDown("failed", "Azure Resource Graph refused the query (403).") }) });
    const b = await box();
    await waitFor(() => expect(b.closest(".ov-lab__hover")).not.toBeNull());
    await user.hover(b);
    const tip = await screen.findByRole("tooltip");
    expect(await within(tip).findByText("Planned · 4 resources · live view unavailable · Open the lab")).toBeInTheDocument();
    expect(within(within(tip).getByRole("tree", { name: /diagram/i })).getByRole("treeitem", { name: /pe-l06…blob-blob/ })).toBeInTheDocument();
  });
});
