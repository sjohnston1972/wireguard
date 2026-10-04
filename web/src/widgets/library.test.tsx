// library.test.tsx
//
// Plain English: the Layout menu's Add widgets… library (insights spec 9.2,
// 9.3). Every widget of the page, by row, with a switch: On puts it in its
// home row, Off takes it out, and a full row asks which widget to replace
// (the row's suggestion picked already), so a row never shows more than it
// does today. Saves are optimistic and put back with a toast when they fail.
import { describe, it, expect, afterEach, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import { prefsServer } from "@/test/fixtures";
import { setViewport } from "@/test/viewport";
import { Panel } from "@/components";
import type { PagePrefs } from "@shared/api";
import type { PageId } from "@shared/widgets";
import { LayoutMenu, Widget, WidgetRow, WidgetStack, usePrefsStatus, SAVE_DELAY_MS } from "@/widgets";
import { rowView } from "./layout";

afterEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
  vi.restoreAllMocks();
});

function Ready() {
  return <output aria-label="status">{usePrefsStatus()}</output>;
}
const ready = () => waitFor(() => expect(screen.getByRole("status", { name: "status", hidden: true })).toHaveTextContent("ready"));
const panel = (title: string) => <Panel title={title}>body</Panel>;

/** Overview's rows 3 and 4 as the page draws them, new widgets included. */
function OverviewRows() {
  return (
    <>
      <WidgetRow page="overview" row="r3" className="ov-row" data-testid="r3">
        {{
          "overview.run": <Widget id="overview.run">{panel("Last run")}</Widget>,
          "overview.traffic": <Widget id="overview.traffic">{panel("Network traffic")}</Widget>,
          side: (
            <WidgetStack page="overview" stack="side">
              {{
                "overview.events": <Widget id="overview.events">{panel("Recent events")}</Widget>,
                "overview.speedTest": <Widget id="overview.speedTest">{panel("Speed test")}</Widget>,
              }}
            </WidgetStack>
          ),
          "overview.vmPerformance": <Widget id="overview.vmPerformance">{panel("VM performance")}</Widget>,
        }}
      </WidgetRow>
      <WidgetRow page="overview" row="r4" className="ov-row" data-testid="r4">
        {{
          "overview.health": <Widget id="overview.health">{panel("Health summary")}</Widget>,
          "overview.costImpact": <Widget id="overview.costImpact">{panel("Cost impact")}</Widget>,
          "overview.notes": <Widget id="overview.notes">{panel("Watchman notes")}</Widget>,
          "overview.azureHealth": <Widget id="overview.azureHealth">{panel("Azure health")}</Widget>,
          "overview.vitals": <Widget id="overview.vitals">{panel("System vitals")}</Widget>,
        }}
      </WidgetRow>
    </>
  );
}

function renderPage(page: PageId = "overview", initial: Partial<Record<PageId, PagePrefs>> = {}, routes: Record<string, unknown> = {}) {
  const server = prefsServer(initial);
  const r = renderWithProviders(
    <>
      <Ready />
      <LayoutMenu page={page} />
      {page === "overview" && <OverviewRows />}
    </>,
    { routes: { ...server.routes, ...routes } },
  );
  return { ...r, server };
}

// hidden: true, because the page behind an open dialog is aria-hidden.
const titles = (row: HTMLElement) => within(row).getAllByRole("heading", { level: 2, hidden: true }).map((h) => h.textContent);
const wait = () => new Promise((r) => setTimeout(r, SAVE_DELAY_MS + 100));

async function openLibrary() {
  await userEvent.click(screen.getByRole("button", { name: "Layout" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Add widgets…" }));
  return screen.findByRole("dialog", { name: "Add widgets" });
}

/** Turn a widget's switch in the library; answers the Replace dialog when one opens. */
async function flip(lib: HTMLElement, title: string) {
  await userEvent.click(within(lib).getByRole("switch", { name: title }));
}

const replaceDialog = () => screen.findByRole("dialog", { name: "Replace a widget" });
const radios = (d: HTMLElement) => within(d).getAllByRole("radio").map((r) => r.closest("label")!.querySelector(".wg-lib__title")!.textContent);

describe("the Layout menu", () => {
  it("offers Add widgets… in place of Show hidden widgets", async () => {
    renderPage("overview", { overview: { layout: { hidden: ["overview.notes"] } } });
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Layout" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).queryByText("Show hidden widgets")).toBeNull();
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Add widgets…", "Reset this page…"]);
  });

  it("Reset this page says widgets you added are turned off", async () => {
    renderPage();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Layout" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Reset this page…" }));
    const modal = await screen.findByRole("dialog", { name: "Reset Overview to its default layout and settings?" });
    expect(modal).toHaveAccessibleDescription(/Widgets you added are turned off\./);
  });
});

describe("the library", () => {
  it("Add widgets lists every widget of the page by row with icon, description and a switch", async () => {
    renderPage();
    await ready();
    const lib = await openLibrary();
    expect(within(lib).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Row 1", "Row 2", "Row 3", "Row 4"]);
    expect(within(lib).getAllByRole("switch").map((s) => s.getAttribute("aria-label"))).toEqual([
      "Status banner",
      "Live topology",
      "Key metrics",
      "Last run",
      "Network traffic",
      "Recent events",
      "Speed test",
      "VM performance",
      "Health summary",
      "Cost impact",
      "Watchman notes",
      "Azure health",
      "System vitals",
    ]);
    const row3 = within(lib).getByRole("list", { name: "Row 3" });
    const vm = within(row3).getByRole("switch", { name: "VM performance" });
    expect(vm).not.toBeChecked();
    expect(vm).toHaveAccessibleDescription("CPU, memory, network and disk as Azure measures them");
    expect(within(row3).getByRole("switch", { name: "Last run" })).toBeChecked();
    expect(within(lib).getByText("What the watchman noticed and did")).toBeInTheDocument();
    for (const item of within(lib).getAllByRole("listitem")) expect(item.querySelector(".wg-lib__icon svg")).not.toBeNull();
  });

  it("pinned widgets read Always on", async () => {
    renderPage();
    await ready();
    const lib = await openLibrary();
    const banner = within(lib).getByRole("switch", { name: "Status banner" });
    expect(banner).toBeChecked();
    expect(banner).toBeDisabled();
    expect(banner.closest("li")).toHaveTextContent("Always on");
    expect(within(lib).getByRole("switch", { name: "Last run" }).closest("li")).not.toHaveTextContent("Always on");
  });

  it("On places a default-off widget in its home row and saves shown", async () => {
    const { server } = renderPage("overview", { overview: { layout: { hidden: ["overview.costImpact"] } } });
    await ready();
    const lib = await openLibrary();
    // From the keyboard: Space on the focused switch.
    within(lib).getByRole("switch", { name: "System vitals" }).focus();
    await userEvent.keyboard(" ");
    expect(within(lib).getByRole("switch", { name: "System vitals" })).toBeChecked();
    expect(screen.queryByRole("dialog", { name: "Replace a widget" })).toBeNull();
    expect(titles(screen.getByTestId("r4"))).toEqual(["Health summary", "Watchman notes", "System vitals"]);
    await waitFor(() => expect(server.puts).toHaveLength(1));
    expect(server.puts[0]!.body.prefs).toEqual({ layout: { hidden: ["overview.costImpact"], shown: ["overview.vitals"] } });
  });

  it("Off on an existing widget hides it", async () => {
    const { server } = renderPage();
    await ready();
    const lib = await openLibrary();
    await flip(lib, "Watchman notes");
    expect(within(lib).getByRole("switch", { name: "Watchman notes" })).not.toBeChecked();
    expect(titles(screen.getByTestId("r4"))).toEqual(["Health summary", "Cost impact"]);
    await waitFor(() => expect(server.puts).toHaveLength(1));
    expect(server.puts[0]!.body.prefs).toEqual({ layout: { hidden: ["overview.notes"] } });
  });

  it("Off on a default-off widget frees its place", async () => {
    const { server } = renderPage("overview", { overview: { layout: { hidden: ["overview.costImpact"], shown: ["overview.vitals"] } } });
    await ready();
    const lib = await openLibrary();
    await flip(lib, "System vitals");
    expect(titles(screen.getByTestId("r4"))).toEqual(["Health summary", "Watchman notes"]);
    await waitFor(() => expect(server.puts).toHaveLength(1));
    expect(server.puts[0]!.body.prefs).toEqual({ layout: { hidden: ["overview.costImpact"] } });
    // The freed place takes Cost impact back without a Replace.
    await flip(lib, "Cost impact");
    expect(screen.queryByRole("dialog", { name: "Replace a widget" })).toBeNull();
    expect(titles(screen.getByTestId("r4"))).toEqual(["Health summary", "Cost impact", "Watchman notes"]);
  });

  it("turning a hidden existing widget back on into a full row asks to replace", async () => {
    const { server } = renderPage("overview", { overview: { layout: { hidden: ["overview.costImpact"], shown: ["overview.vitals"] } } });
    await ready();
    const lib = await openLibrary();
    await flip(lib, "Cost impact");
    const d = await replaceDialog();
    expect(d).toHaveAccessibleDescription("Row 4 is full. Pick a widget to turn off, and Cost impact takes its place.");
    expect(radios(d)).toEqual(["Health summary", "Watchman notes", "System vitals"]);
    expect(within(lib).getByRole("switch", { name: "Cost impact", hidden: true })).not.toBeChecked();
    await wait();
    expect(server.puts).toHaveLength(0);
  });

  it("read-only when prefs failed to load", async () => {
    renderPage("overview", {}, { "GET /api/v1/prefs": { status: 500, json: { error: { code: "internal", message: "Something broke" } } } });
    await waitFor(() => expect(screen.getByRole("status", { name: "status", hidden: true })).toHaveTextContent("failed"));
    const lib = await openLibrary();
    expect(within(lib).getByText("Widget settings couldn't be loaded, so changes can't be saved right now.")).toBeInTheDocument();
    for (const s of within(lib).getAllByRole("switch")) expect(s).toBeDisabled();
  });

  it("phone opens the library as a Sheet", async () => {
    setViewport("phone");
    renderPage();
    await ready();
    const lib = await openLibrary();
    expect(lib).toHaveAttribute("data-side", "bottom");
    expect(within(lib).getByRole("switch", { name: "VM performance" })).toBeInTheDocument();
  });

  it("desktop opens the library as a centred modal", async () => {
    renderPage();
    await ready();
    const lib = await openLibrary();
    expect(lib).toHaveAttribute("data-side", "center");
  });
});

describe("Replace", () => {
  it("a full row opens Replace with the suggestion preselected", async () => {
    const { server } = renderPage();
    await ready();
    const lib = await openLibrary();
    await flip(lib, "VM performance");
    const d = await replaceDialog();
    expect(d).toHaveAccessibleDescription("Row 3 is full. Pick a widget to turn off, and VM performance takes its place.");
    expect(radios(d)).toEqual(["Last run", "Network traffic"]);
    expect(within(d).getByRole("radio", { name: /Network traffic/ })).toBeChecked();
    expect(within(d).getByRole("radio", { name: /Last run/ })).not.toBeChecked();
    expect(screen.queryByRole("region", { name: "VM performance" })).toBeNull();
    await wait();
    expect(server.puts).toHaveLength(0);
  });

  it("Replace saves hidden, shown and order in one PUT and the row's grid template is unchanged", async () => {
    const { server } = renderPage();
    await ready();
    const before = rowView("overview", "r3", {}).template;
    const lib = await openLibrary();
    await flip(lib, "VM performance");
    await userEvent.click(within(await replaceDialog()).getByRole("button", { name: "Replace" }));
    expect(screen.queryByRole("dialog", { name: "Replace a widget" })).toBeNull();
    const row = screen.getByTestId("r3");
    expect(titles(row)).toEqual(["Last run", "VM performance", "Recent events", "Speed test"]);
    expect(row.style.gridTemplateColumns).toBe(before);
    expect(within(lib).getByRole("switch", { name: "VM performance" })).toBeChecked();
    expect(within(lib).getByRole("switch", { name: "Network traffic" })).not.toBeChecked();
    await waitFor(() => expect(server.puts).toHaveLength(1));
    await wait();
    expect(server.puts).toHaveLength(1);
    expect(server.puts[0]!.body.prefs).toEqual({ layout: { order: { r3: ["overview.run", "overview.vmPerformance", "side", "overview.traffic"] }, hidden: ["overview.traffic"], shown: ["overview.vmPerformance"] } });
  });

  it("another choice replaces that widget instead", async () => {
    const { server } = renderPage();
    await ready();
    const lib = await openLibrary();
    await flip(lib, "VM performance");
    const d = await replaceDialog();
    await userEvent.click(within(d).getByRole("radio", { name: /Last run/ }));
    await userEvent.click(within(d).getByRole("button", { name: "Replace" }));
    expect(titles(screen.getByTestId("r3"))).toEqual(["VM performance", "Network traffic", "Recent events", "Speed test"]);
    await waitFor(() => expect(server.puts).toHaveLength(1));
    expect(server.puts[0]!.body.prefs.layout).toMatchObject({ hidden: ["overview.run"], shown: ["overview.vmPerformance"] });
  });

  it("a stack home lists the stack's members", async () => {
    renderPage("firewall");
    await ready();
    const lib = await openLibrary();
    await flip(lib, "Public IP and DDoS");
    const d = await replaceDialog();
    expect(d).toHaveAccessibleDescription("The right column is full. Pick a widget to turn off, and Public IP and DDoS takes its place.");
    expect(radios(d)).toEqual(["Recent drops", "Published ports", "Packet capture"]);
    expect(within(d).getByRole("radio", { name: /Packet capture/ })).toBeChecked();
  });

  it("Cancel changes nothing", async () => {
    const { server } = renderPage();
    await ready();
    const lib = await openLibrary();
    await flip(lib, "VM performance");
    const d = await replaceDialog();
    await userEvent.click(within(d).getByRole("radio", { name: /Last run/ }));
    await userEvent.click(within(d).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Replace a widget" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Add widgets" })).toBeInTheDocument();
    expect(titles(screen.getByTestId("r3"))).toEqual(["Last run", "Network traffic", "Recent events", "Speed test"]);
    expect(within(lib).getByRole("switch", { name: "VM performance" })).not.toBeChecked();
    await wait();
    expect(server.puts).toHaveLength(0);
  });

  it("focus returns to the switch after closing", async () => {
    renderPage();
    await ready();
    const lib = await openLibrary();
    await flip(lib, "VM performance");
    await replaceDialog();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Replace a widget" })).toBeNull();
    // Escape closed only Replace: the library stays open.
    expect(screen.getByRole("dialog", { name: "Add widgets" })).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(within(lib).getByRole("switch", { name: "VM performance" })));
    // And after Replace itself.
    await flip(lib, "VM performance");
    await userEvent.click(within(await replaceDialog()).getByRole("button", { name: "Replace" }));
    await waitFor(() => expect(document.activeElement).toBe(within(lib).getByRole("switch", { name: "VM performance" })));
  });

  it("a failed save reverts both widgets with the toast", async () => {
    renderPage("overview", {}, { "PUT /api/v1/prefs/overview": { status: 500, json: { error: { code: "internal", message: "Something broke" } } } });
    await ready();
    const lib = await openLibrary();
    await flip(lib, "VM performance");
    await userEvent.click(within(await replaceDialog()).getByRole("button", { name: "Replace" }));
    expect(titles(screen.getByTestId("r3"))).toEqual(["Last run", "VM performance", "Recent events", "Speed test"]);
    expect(await screen.findByText(/Couldn't save your Overview widgets: Something broke\. Put back as it was\./)).toBeInTheDocument();
    await waitFor(() => expect(titles(screen.getByTestId("r3"))).toEqual(["Last run", "Network traffic", "Recent events", "Speed test"]));
    expect(within(lib).getByRole("switch", { name: "VM performance" })).not.toBeChecked();
    expect(within(lib).getByRole("switch", { name: "Network traffic" })).toBeChecked();
  });
});
