// Lab topology plan T2.5: the lab dialog and its diagram on the phone. Kept from the old
// phone.test.tsx when the labs redesign (plan B6) replaced the phone's own catalogue composition.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
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

describe("the lab dialog on the phone", () => {
  it("a lab opens as a bottom sheet with Deploy", async () => {
    setViewport("phone");
    renderApp("/labs/az104-06-blob-security", { routes: routes() });
    const lab = await screen.findByRole("dialog", { name: /Blob security/ });
    expectBottomSheet(lab);
    expect(within(lab).getByRole("button", { name: "Deploy" })).toBeEnabled();
  });
});

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
