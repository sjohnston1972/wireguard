// layout.test.tsx
//
// Plain English: rows of widgets. A hidden widget's width goes to the rest
// of its row; a stack or row with nothing left in it disappears. Widgets
// move within their own row only: by dragging the handle, by Alt+Arrow on
// it, or from the cog. The Layout menu brings hidden widgets back and
// resets the page.
import { describe, it, expect, afterEach, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import { prefsServer } from "@/test/fixtures";
import { setViewport } from "@/test/viewport";
import { Panel } from "@/components";
import type { PagePrefs } from "@shared/api";
import type { Registry } from "@shared/widgets";
import { LayoutMenu, Widget, WidgetCorner, WidgetRow, WidgetStack, usePrefsStatus, useRowItems, WIDGET_DRAG_TYPE } from "@/widgets";
import { canMoveIn, moveWithin, rowView, dropMove } from "./layout";

afterEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
  vi.restoreAllMocks();
});

// ── The rules, on a test-only page ────────────────────────────────────────

const reg: Registry = {
  widgets: ["a", "b", "c", "d", "e", "f", "g"].map((x) => ({ id: `overview.${x}`, page: "overview" as const, title: x.toUpperCase(), version: 1, settings: [], ...(x === "a" ? { pinned: true } : {}) })),
  layouts: {
    overview: {
      page: "overview",
      rows: [
        { id: "top", items: [{ widget: "overview.a", weight: 1 }] },
        { id: "mid", items: [{ widget: "overview.b", weight: 2 }, { widget: "overview.c", weight: 1 }, { stack: "st", weight: 1, widgets: ["overview.d", "sub"] }] },
        { id: "sub", in: "st", items: [{ widget: "overview.e", weight: 1 }, { widget: "overview.f", weight: 1 }] },
        { id: "low", items: [{ widget: "overview.g", weight: 1 }] },
      ],
    },
  },
};
const hide = (...ids: string[]): PagePrefs => ({ layout: { hidden: ids.map((x) => `overview.${x}`) } });

describe("rows (pure)", () => {
  it("lays a row out in the user's order with its weights as grid columns", () => {
    const v = rowView("overview", "mid", {}, reg);
    expect(v.items.map((i) => i.key)).toEqual(["overview.b", "overview.c", "st"]);
    expect(v.template).toBe("minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr)");
    expect(v.isDefault).toBe(true);
    expect(v.visible).toBe(true);
    expect(v.items[2]).toEqual({ key: "st", kind: "stack", weight: 1, members: ["overview.d", "sub"] });
    const moved = rowView("overview", "mid", { layout: { order: { mid: ["st", "overview.b", "overview.c"] } } }, reg);
    expect(moved.items.map((i) => i.key)).toEqual(["st", "overview.b", "overview.c"]);
    expect(moved.isDefault).toBe(false);
  });

  it("hiding a widget gives its weight to the rest of the row", () => {
    const v = rowView("overview", "mid", hide("c"), reg);
    expect(v.items.map((i) => i.key)).toEqual(["overview.b", "st"]);
    expect(v.template).toBe("minmax(0, 2fr) minmax(0, 1fr)");
    expect(v.isDefault).toBe(false);
  });

  it("a stack's hidden widgets leave it; a nested row with nothing visible leaves its stack", () => {
    expect(rowView("overview", "mid", hide("d"), reg).items[2]!.members).toEqual(["sub"]);
    expect(rowView("overview", "mid", hide("e", "f"), reg).items[2]!.members).toEqual(["overview.d"]);
    expect(rowView("overview", "sub", hide("e", "f"), reg).visible).toBe(false);
  });

  it("a stack with nothing visible leaves the row", () => {
    const v = rowView("overview", "mid", hide("d", "e", "f"), reg);
    expect(v.items.map((i) => i.key)).toEqual(["overview.b", "overview.c"]);
    expect(v.template).toBe("minmax(0, 2fr) minmax(0, 1fr)");
  });

  it("a row with nothing visible is not rendered", () => {
    expect(rowView("overview", "low", hide("g"), reg)).toMatchObject({ visible: false, items: [] });
    // A pinned widget never counts as hidden.
    expect(rowView("overview", "top", hide("a"), reg).visible).toBe(true);
  });

  it("moves step over hidden neighbours, stay in the row, and only direct items move", () => {
    expect(canMoveIn("overview", "overview.b", {}, reg)).toEqual({ movable: true, left: false, right: true, row: "mid", index: 0, count: 3 });
    expect(canMoveIn("overview", "overview.c", {}, reg)).toMatchObject({ movable: true, left: true, right: true, index: 1 });
    // In a stack, or alone in a row: no move controls.
    expect(canMoveIn("overview", "overview.d", {}, reg).movable).toBe(false);
    expect(canMoveIn("overview", "overview.g", {}, reg).movable).toBe(false);
    expect(canMoveIn("overview", "overview.a", {}, reg).movable).toBe(false);
    // A nested row's widgets move within it.
    expect(canMoveIn("overview", "overview.e", {}, reg)).toMatchObject({ movable: true, row: "sub", left: false, right: true });
    // Alone once the rest of the row is hidden.
    expect(canMoveIn("overview", "overview.b", hide("c", "d", "e", "f"), reg).movable).toBe(false);

    expect(moveWithin("overview", {}, "overview.b", "right", reg)).toEqual({ layout: { order: { mid: ["overview.c", "overview.b", "st"] } } });
    // c hidden: b moving right swaps with the stack, c keeps its place.
    expect(moveWithin("overview", hide("c"), "overview.b", "right", reg)!.layout!.order).toEqual({ mid: ["st", "overview.c", "overview.b"] });
    expect(moveWithin("overview", {}, "overview.b", "left", reg)).toBeNull();
    expect(moveWithin("overview", {}, "overview.d", "left", reg)).toBeNull();
  });

  it("a drop moves the dragged item to the target's place within the same row only", () => {
    expect(dropMove("overview", {}, { row: "mid", key: "overview.b" }, "st", reg)!.layout!.order).toEqual({ mid: ["overview.c", "st", "overview.b"] });
    expect(dropMove("overview", {}, { row: "mid", key: "st" }, "overview.b", reg)!.layout!.order).toEqual({ mid: ["st", "overview.b", "overview.c"] });
    // Onto a stack member means onto the stack.
    expect(dropMove("overview", {}, { row: "mid", key: "overview.b" }, "overview.d", reg)!.layout!.order).toEqual({ mid: ["overview.c", "st", "overview.b"] });
    expect(dropMove("overview", {}, { row: "sub", key: "overview.e" }, "overview.b", reg)).toBeNull();
    expect(dropMove("overview", {}, { row: "mid", key: "overview.b" }, "overview.b", reg)).toBeNull();
  });
});

// ── The components, on the real Overview layout ───────────────────────────
// r3: run 41, traffic 45, side(events, speedTest) 32; r4: health 54, costImpact 32, notes 32.

function Ready() {
  return <output aria-label="status">{usePrefsStatus()}</output>;
}
const ready = () => waitFor(() => expect(screen.getByRole("status", { name: "status", hidden: true })).toHaveTextContent("ready"));
const panel = (title: string) => <Panel title={title}>body</Panel>;

function OverviewRows() {
  return (
    <>
      <Ready />
      <WidgetRow page="overview" row="r3" className="ov-row ov-row--3">
        {{
          "overview.run": <Widget id="overview.run">{panel("Last run")}</Widget>,
          "overview.traffic": <Widget id="overview.traffic">{panel("Network traffic")}</Widget>,
          side: (
            <WidgetStack page="overview" stack="side" className="ov-side">
              {{
                "overview.events": <Widget id="overview.events">{panel("Recent events")}</Widget>,
                "overview.speedTest": <Widget id="overview.speedTest">{panel("Speed test")}</Widget>,
              }}
            </WidgetStack>
          ),
        }}
      </WidgetRow>
      <WidgetRow page="overview" row="r4" className="ov-row ov-row--4" data-testid="r4">
        {{
          "overview.health": <Widget id="overview.health">{panel("Health summary")}</Widget>,
          "overview.costImpact": <Widget id="overview.costImpact">{panel("Cost impact")}</Widget>,
          "overview.notes": <Widget id="overview.notes">{panel("Watchman notes")}</Widget>,
        }}
      </WidgetRow>
      <Widget id="overview.status" headerless>
        <section className="ov-banner">
          banner
          <WidgetCorner />
        </section>
      </Widget>
    </>
  );
}

function renderRows(initial: Partial<Record<"overview", PagePrefs>> = {}) {
  const server = prefsServer(initial);
  const r = renderWithProviders(
    <>
      <LayoutMenu page="overview" />
      <OverviewRows />
    </>,
    { routes: server.routes },
  );
  return { ...r, server };
}

const titles = (row: HTMLElement) => within(row).getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
const region = (name: string) => screen.getByRole("region", { name });
const rowOf = (name: string) => region(name).closest(".ov-row") as HTMLElement;

/** A stand-in for the browser's DataTransfer, with the types a real drag would carry. */
function transfer(types: Record<string, string>) {
  const data = { ...types };
  return {
    get types() {
      return Object.keys(data);
    },
    getData: (t: string) => data[t] ?? "",
    setData: (t: string, v: string) => void (data[t] = v),
    effectAllowed: "all",
    dropEffect: "none",
    setDragImage: () => {},
  };
}

describe("rows (components)", () => {
  it("renders a row in the user's order; its own CSS keeps the columns until something changes", async () => {
    const { server } = renderRows({ overview: { layout: { order: { r4: ["overview.notes", "overview.health", "overview.costImpact"] } } } });
    await ready();
    expect(titles(screen.getByTestId("r4"))).toEqual(["Watchman notes", "Health summary", "Cost impact"]);
    expect(screen.getByTestId("r4").style.gridTemplateColumns).toBe("minmax(0, 32fr) minmax(0, 54fr) minmax(0, 32fr)");
    expect(rowOf("Last run").style.gridTemplateColumns).toBe("");
    expect(rowOf("Last run")).toHaveClass("ov-row", "ov-row--3");
    expect(server.puts).toHaveLength(0);
  });

  it("hiding a widget gives its weight to the rest of the row", async () => {
    renderRows({ overview: { layout: { hidden: ["overview.costImpact"] } } });
    await ready();
    expect(titles(screen.getByTestId("r4"))).toEqual(["Health summary", "Watchman notes"]);
    expect(screen.getByTestId("r4").style.gridTemplateColumns).toBe("minmax(0, 54fr) minmax(0, 32fr)");
  });

  it("a stack with nothing visible leaves the row; a row with nothing visible is not rendered", async () => {
    renderRows({ overview: { layout: { hidden: ["overview.events", "overview.speedTest", "overview.health", "overview.costImpact", "overview.notes"] } } });
    await ready();
    expect(document.querySelector(".ov-side")).toBeNull();
    expect(rowOf("Last run").style.gridTemplateColumns).toBe("minmax(0, 41fr) minmax(0, 45fr)");
    expect(screen.queryByTestId("r4")).toBeNull();
  });

  it("useRowItems gives views that keep their own markup the same answer", async () => {
    let seen: ReturnType<typeof useRowItems> | null = null;
    function Probe() {
      seen = useRowItems("overview", "r3");
      return null;
    }
    renderWithProviders(
      <>
        <Ready />
        <Probe />
      </>,
      { routes: prefsServer({ overview: { layout: { hidden: ["overview.traffic"] } } }).routes },
    );
    await ready();
    expect(seen!).toMatchObject({ visible: true, isDefault: false, template: "minmax(0, 41fr) minmax(0, 32fr)" });
    expect(seen!.items.map((i) => i.key)).toEqual(["overview.run", "side"]);
  });
});

describe("moving", () => {
  it("drag by the handle reorders within the row and saves the order", async () => {
    const { server } = renderRows();
    await ready();
    const handle = screen.getByRole("button", { name: "Move Health summary" });
    expect(handle).toHaveAttribute("draggable", "true");
    const dt = transfer({});
    fireEvent.dragStart(handle, { dataTransfer: dt });
    expect(dt.types).toContain(WIDGET_DRAG_TYPE);
    const target = region("Watchman notes");
    expect(fireEvent.dragOver(target, { dataTransfer: dt })).toBe(false); // a drop target: the browser is told a drop is allowed
    fireEvent.drop(target, { dataTransfer: dt });
    fireEvent.dragEnd(handle, { dataTransfer: dt });
    expect(titles(screen.getByTestId("r4"))).toEqual(["Cost impact", "Watchman notes", "Health summary"]);
    await waitFor(() => expect(server.puts).toHaveLength(1));
    expect(server.puts[0]!.body.prefs).toEqual({ layout: { order: { r4: ["overview.costImpact", "overview.notes", "overview.health"] } } });
  });

  it("a drop without the widget data type is ignored", async () => {
    const { server } = renderRows();
    await ready();
    // What the firewall rules table's own drag carries: text/plain only.
    const dt = transfer({ "text/plain": "Allow DNS" });
    const target = region("Watchman notes");
    expect(fireEvent.dragOver(target, { dataTransfer: dt })).toBe(true); // not a drop target
    fireEvent.drop(target, { dataTransfer: dt });
    expect(titles(screen.getByTestId("r4"))).toEqual(["Health summary", "Cost impact", "Watchman notes"]);
    await new Promise((r) => setTimeout(r, 700));
    expect(server.puts).toHaveLength(0);
  });

  it("a widget cannot be dropped into another row", async () => {
    const { server } = renderRows();
    await ready();
    const dt = transfer({});
    fireEvent.dragStart(screen.getByRole("button", { name: "Move Health summary" }), { dataTransfer: dt });
    const other = region("Network traffic");
    expect(fireEvent.dragOver(other, { dataTransfer: dt })).toBe(true);
    fireEvent.drop(other, { dataTransfer: dt });
    expect(titles(rowOf("Network traffic"))).toEqual(["Last run", "Network traffic", "Recent events", "Speed test"]);
    expect(titles(screen.getByTestId("r4"))).toEqual(["Health summary", "Cost impact", "Watchman notes"]);
    await new Promise((r) => setTimeout(r, 700));
    expect(server.puts).toHaveLength(0);
  });

  it("Alt+ArrowRight on the move handle moves the widget one place, keeps focus and announces the position", async () => {
    const { server } = renderRows();
    await ready();
    const handle = screen.getByRole("button", { name: "Move Last run" });
    handle.focus();
    await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}");
    expect(titles(rowOf("Last run"))).toEqual(["Network traffic", "Last run", "Recent events", "Speed test"]);
    expect(screen.getByRole("button", { name: "Move Last run" })).toHaveFocus();
    expect(document.querySelector("[data-wg-announcer]")).toHaveTextContent("Last run moved to position 2 of 3");
    await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}");
    expect(titles(rowOf("Last run"))).toEqual(["Network traffic", "Recent events", "Speed test", "Last run"]);
    expect(document.querySelector("[data-wg-announcer]")).toHaveTextContent("Last run moved to position 3 of 3");
    // At the end: nothing moves; plain arrows do nothing.
    await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}{ArrowLeft}");
    expect(titles(rowOf("Last run"))).toEqual(["Network traffic", "Recent events", "Speed test", "Last run"]);
    await waitFor(() => expect(server.puts).toHaveLength(1));
    expect(server.puts[0]!.body.prefs).toEqual({ layout: { order: { r3: ["overview.traffic", "side", "overview.run"] } } });
  });

  it("Move left / Move right in the cog", async () => {
    renderRows();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Cost impact settings" }));
    let dialog = await screen.findByRole("dialog", { name: "Cost impact settings" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Move left" }));
    expect(titles(screen.getByTestId("r4"))).toEqual(["Cost impact", "Health summary", "Watchman notes"]);
    dialog = screen.getByRole("dialog", { name: "Cost impact settings" });
    expect(within(dialog).getByRole("button", { name: "Move left" })).toBeDisabled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Move right" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Move right" }));
    expect(titles(screen.getByTestId("r4"))).toEqual(["Health summary", "Watchman notes", "Cost impact"]);
    expect(within(dialog).getByRole("button", { name: "Move right" })).toBeDisabled();
  });

  it("a widget in a stack or alone in its row has no move controls", async () => {
    renderRows({ overview: { layout: { hidden: ["overview.costImpact", "overview.notes"] } } });
    await ready();
    expect(screen.queryByRole("button", { name: "Move Recent events" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Move Status banner" })).toBeNull();
    // Health is alone in its row now.
    expect(screen.queryByRole("button", { name: "Move Health summary" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Recent events settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Recent events settings" });
    expect(within(dialog).queryByRole("button", { name: "Move left" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Move right" })).toBeNull();
    expect(screen.getByRole("button", { name: "Move Last run" })).toBeInTheDocument();
  });
});

describe("the Layout menu", () => {
  it("is widget chrome, labelled Layout", async () => {
    renderRows();
    await ready();
    const button = screen.getByRole("button", { name: "Layout" });
    expect(button.closest("[data-widget-chrome]")).not.toBeNull();
  });

  it("Layout menu: Show hidden widgets lists hidden ones and Show brings one back", async () => {
    const { server } = renderRows({ overview: { layout: { hidden: ["overview.notes", "overview.speedTest"] } } });
    await ready();
    expect(screen.queryByRole("region", { name: "Watchman notes" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Layout" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("Show hidden widgets")).toBeInTheDocument();
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Show Speed test", "Show Watchman notes", "Reset this page…"]);
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Show Watchman notes" }));
    expect(region("Watchman notes")).toBeInTheDocument();
    await waitFor(() => expect(server.puts).toHaveLength(1));
    expect(server.puts[0]!.body.prefs).toEqual({ layout: { hidden: ["overview.speedTest"] } });
  });

  it("Layout menu says No hidden widgets when none are", async () => {
    renderRows();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Layout" }));
    const menu = await screen.findByRole("menu");
    const none = within(menu).getByRole("menuitem", { name: "No hidden widgets" });
    expect(none).toHaveAttribute("aria-disabled", "true");
  });

  it("Reset this page asks in a Modal, then resets order, hidden and every widget", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    const { server } = renderRows({
      overview: { layout: { order: { r4: ["overview.notes", "overview.health", "overview.costImpact"] }, hidden: ["overview.speedTest"] }, widgets: { "overview.events": { v: 1, s: { rows: 9 } } } },
    });
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Layout" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Reset this page…" }));
    const modal = await screen.findByRole("dialog", { name: "Reset Overview to its default layout and settings?" });
    await userEvent.click(within(modal).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(server.puts).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Layout" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Reset this page…" }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Reset" }));
    expect(titles(screen.getByTestId("r4"))).toEqual(["Health summary", "Cost impact", "Watchman notes"]);
    expect(region("Speed test")).toBeInTheDocument();
    await waitFor(() => expect(server.puts).toHaveLength(1));
    expect(server.puts[0]!.body).toEqual({ baseVersion: 1, prefs: {} });
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("the phone Layout menu lists every widget and opens its settings", async () => {
    setViewport("phone");
    renderRows();
    await ready();
    // Order is desktop-only: no move handles on the phone.
    expect(screen.queryByRole("button", { name: /^Move / })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Layout" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Widget settings" }));
    const sheet = await screen.findByRole("dialog", { name: "Overview widget settings" });
    expect(within(sheet).getAllByRole("button", { name: /settings$/ }).map((b) => b.textContent)).toEqual([
      "Status banner",
      "Live topology",
      "Key metrics",
      "Last run",
      "Network traffic",
      "Recent events",
      "Speed test",
      "Health summary",
      "Cost impact",
      "Watchman notes",
    ]);
    // Topology is not on this test page at all, and can still be set.
    await userEvent.click(within(sheet).getByRole("button", { name: "Live topology settings" }));
    const settings = await screen.findByRole("dialog", { name: "Live topology settings" });
    expect(within(settings).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Display"]);
    expect(within(settings).getByRole("switch", { name: "Edge labels: UDP port" })).toBeChecked();
  });
});
