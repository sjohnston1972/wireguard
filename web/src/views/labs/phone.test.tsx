// Plan L3.6: the phone's own composition of the Labs tab (spec §10, Phone).
import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { setViewport } from "@/test/viewport";
import { expectBottomSheet } from "@/test/dialogs";
import { labCoverageFixture } from "@/test/fixtures";
import { detailIdle, labs, session } from "./testData";
import { PLANNED_URL, layoutServer, nodeOn, plannedGraph } from "./topology/places.fixtures";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The Vitest config leaves CSS out of the module graph, so the stylesheet is read as a file.
const labsCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "labs.css"), "utf8").replace(/\r\n/g, "\n");

vi.setConfig({ testTimeout: 20_000 });
beforeAll(async () => {
  await import("@/views/labs");
});

const routes = () => ({
  "GET /api/v1/labs": labs({ running: [session({ labId: "az104-01-identity", title: "Users, groups and a custom role", id: "ls-1" })] }),
  "GET /api/v1/labs/az104-06-blob-security": detailIdle(),
  "GET /api/v1/labs/sessions": { sessions: [session({ labId: "az104-01-identity", title: "Users, groups and a custom role", id: "ls-1" })] },
  "GET /api/v1/labs/coverage": labCoverageFixture(),
});

describe("Labs on the phone", () => {
  it("phone: running labs with lights, time left, Extend and Tear down; Catalogue and Your labs open sheets; a lab opens as a sheet with Deploy", async () => {
    const user = userEvent.setup();
    setViewport("phone");
    renderApp("/labs", { routes: routes() });
    expect(await within(screen.getByRole("main")).findByRole("heading", { level: 1, name: "Labs" })).toBeInTheDocument();

    // One screen: the running labs, each with its light (a coloured word), time left, Extend and Tear down.
    const running = within(await screen.findByRole("region", { name: "Running labs" }));
    const item = within(running.getByRole("listitem"));
    expect(item.getByText("Running")).toHaveClass("labs-word--green");
    await waitFor(() => expect(item.getByText("1 h 15 min left")).toBeInTheDocument());
    expect(item.getByRole("button", { name: "Extend" })).toBeInTheDocument();
    expect(item.getByRole("button", { name: "Tear down" })).toBeInTheDocument();
    // The catalogue and history are a tap away, not on the page.
    expect(screen.queryByRole("region", { name: "Catalogue" })).toBeNull();
    expect(screen.queryByRole("table", { name: "Sessions" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Your labs" }));
    let sheet = await screen.findByRole("dialog", { name: "Your labs" });
    expectBottomSheet(sheet);
    expect(within(sheet).getByRole("table", { name: "Sessions" })).toBeInTheDocument();
    expect(within(sheet).getByRole("region", { name: "Coverage" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(screen.getByRole("button", { name: "Catalogue" }));
    sheet = await screen.findByRole("dialog", { name: "Catalogue" });
    expectBottomSheet(sheet);
    await user.click(within(sheet).getByRole("link", { name: /Blob security/ }));

    const lab = await screen.findByRole("dialog", { name: /Blob security/ });
    expectBottomSheet(lab);
    expect(within(lab).getByRole("button", { name: "Deploy" })).toBeEnabled();
    expect(screen.queryByRole("dialog", { name: "Catalogue" })).toBeNull();
  });

  it("nothing running says so", async () => {
    setViewport("phone");
    renderApp("/labs", { routes: { ...routes(), "GET /api/v1/labs": labs() } });
    expect(await screen.findByText("No labs running.")).toBeInTheDocument();
  });

  it("/labs/history opens Your labs on the phone", async () => {
    setViewport("phone");
    renderApp("/labs/history", { routes: routes() });
    const sheet = await screen.findByRole("dialog", { name: "Your labs" });
    expectBottomSheet(sheet);
  });
});

// ── Lab topology plan T2.5: the diagram on the phone ─────────────────────

describe("the lab diagram on the phone", () => {
  const ID = "az104-06-blob-security";
  const withDiagram = () => ({ ...routes(), [`GET ${PLANNED_URL}`]: plannedGraph(), ...layoutServer().routes });

  it("the lab sheet has Readme and Diagram tabs", async () => {
    const user = userEvent.setup();
    setViewport("phone");
    renderApp(`/labs/${ID}`, { routes: withDiagram() });
    const lab = await screen.findByRole("dialog", { name: /Blob security/ });
    expectBottomSheet(lab);
    const tabs = within(within(lab).getByRole("tablist", { name: "Readme and diagram" }));
    expect(tabs.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Readme", "Diagram"]);
    await user.click(tabs.getByRole("tab", { name: "Diagram" }));
    expect(await within(lab).findByRole("region", { name: "Lab diagram" })).toBeInTheDocument();
    expect(screen.getByLabelText("location")).toHaveTextContent(`/labs/${ID}?view=diagram`);
  });

  it("the canvas is at most 60vh", () => {
    // jsdom does not lay out, so the rule itself is checked: inside the phone query, the diagram tab's panel is min(60vh, 480px) tall.
    const phone = labsCss.slice(labsCss.indexOf("@media (max-width: 640px)"));
    const block = phone.slice(0, phone.indexOf("\n}\n"));
    expect(block).toMatch(/\.labs-tabs--diagram \.tabs__panel \{ height: min\(60vh, 480px\); \}/);
  });

  it("the full screen has a definite height (a min-height alone left React Flow's box 0 px tall)", () => {
    const phone = labsCss.slice(labsCss.indexOf("@media (max-width: 640px)"));
    const block = phone.slice(0, phone.indexOf("\n}\n"));
    expect(block).toMatch(/\.labs--full \{ height: calc\(100dvh - \d+px\); \}/);
    expect(labsCss).toMatch(/^\.labs--full \{[^}]*\bheight: calc\(100dvh - \d+px\);/m);
  });

  it("details open as a Sheet", async () => {
    const user = userEvent.setup();
    setViewport("phone");
    renderApp(`/labs/${ID}?view=diagram`, { routes: withDiagram() });
    const lab = await screen.findByRole("dialog", { name: /Blob security/ });
    const tree = await within(lab).findByRole("region", { name: "Lab diagram" });
    // A click on a card (React Flow selects on click; user-event's mousedown trips d3-drag in jsdom).
    fireEvent.click(nodeOn(tree, /Storage account l06…blob/));
    const details = await screen.findByRole("dialog", { name: "l06…blob" });
    expectBottomSheet(details);
    expect(details).toHaveTextContent("Storage account");
  });

  it("full screen works at 390 px", async () => {
    const user = userEvent.setup();
    setViewport("phone");
    renderApp(`/labs/${ID}/diagram`, { routes: withDiagram() });
    const main = within(screen.getByRole("main"));
    expect(await main.findByRole("heading", { level: 1, name: /Blob security/ })).toBeInTheDocument();
    expect(await main.findByRole("region", { name: "Lab diagram" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(main.getByRole("button", { name: "Close" }));
    expect(screen.getByLabelText("location")).toHaveTextContent(new RegExp(`^/labs/${ID}$`));
    expectBottomSheet(await screen.findByRole("dialog", { name: /Blob security/ }));
  });
});
