// layout.test.tsx
//
// Plain English: rows of widgets. A hidden widget's width goes to the rest
// of its row; a stack or row with nothing left in it disappears. Widgets
// move within their own row only: by dragging the handle, by Alt+Arrow on
// it, or from the cog. The Layout menu brings hidden widgets back and
// resets the page.
import { beforeAll, describe, it, expect, afterEach, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import { prefsServer } from "@/test/fixtures";
import { setViewport } from "@/test/viewport";
import { Panel } from "@/components";
import type { PagePrefs } from "@shared/api";
import type { Registry } from "@shared/widgets";
import { useState } from "react";
import { LayoutMenu, Widget, WidgetArrangement, WidgetCorner, WidgetRow, WidgetStack, usePagePrefs, usePrefsStatus, useRowItems, useWidget, SAVE_DELAY_MS, WIDGET_DRAG_TYPE } from "@/widgets";
import { canMoveIn, moveWithin, rowView, dropMove, type Arranged } from "./layout";
import { preloadLazy } from "@/test/lazy";

// Walks journeys through menus, dialogs and saves, which can take a few seconds while every test file
// runs at once: room beyond Vitest's default 5 s, as the view folders' own suites have.
vi.setConfig({ testTimeout: 20_000 });

beforeAll(preloadLazy);

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
  widgets: ["a", "b", "c", "d", "e", "f", "g"].map((x) => ({ id: `overview.${x}`, page: "overview" as const, title: x.toUpperCase(), description: `Test widget ${x}`, version: 1, settings: [], ...(x === "a" ? { pinned: true } : {}) })),
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
    expect(canMoveIn("overview", "overview.b", {}, reg)).toEqual({ movable: true, left: false, right: true, row: "mid", index: 0, count: 3, item: "overview.b", handle: true });
    expect(canMoveIn("overview", "overview.c", {}, reg)).toMatchObject({ movable: true, left: true, right: true, index: 1 });
    // Alone in a row: no move controls.
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
  });

  it("a stack that is a row's direct item moves as one: its top widget carries the handle, its members' moves move the stack", () => {
    // d is the stack's first widget: the stack's handle sits on it.
    expect(canMoveIn("overview", "overview.d", {}, reg)).toEqual({ movable: true, left: true, right: false, row: "mid", index: 2, count: 3, item: "st", handle: true });
    expect(moveWithin("overview", {}, "overview.d", "left", reg)).toEqual({ layout: { order: { mid: ["overview.b", "st", "overview.c"] } } });
    expect(moveWithin("overview", {}, "overview.d", "right", reg)).toBeNull();
    // A widget of a row nested in the stack still moves within its own row.
    expect(canMoveIn("overview", "overview.e", {}, reg)).toMatchObject({ item: "overview.e", row: "sub", handle: true });
    // Alone in its row (b and c hidden): the stack cannot move.
    expect(canMoveIn("overview", "overview.d", hide("b", "c"), reg).movable).toBe(false);
  });

  it("a row drawn differently for now (a variant) moves what is drawn and keeps the saved order a permutation of the declared row", () => {
    // As Overview during a run: b widens over c's slot and c joins the stack.
    const arranged: Arranged = { ...reg, variants: { overview: { mid: [{ widget: "overview.b", weight: 3 }, { stack: "st", weight: 1, widgets: ["overview.d", "overview.c"] }] } } };
    const v = rowView("overview", "mid", {}, arranged);
    expect(v.items.map((i) => i.key)).toEqual(["overview.b", "st"]);
    expect(v.items[1]!.members).toEqual(["overview.d", "overview.c"]);
    expect(v).toMatchObject({ isDefault: true, template: "minmax(0, 3fr) minmax(0, 1fr)" });
    // c is not a direct item now: it moves its stack, and the handle stays with d.
    expect(canMoveIn("overview", "overview.c", {}, arranged)).toEqual({ movable: true, left: true, right: false, row: "mid", index: 1, count: 2, item: "st", handle: false });
    expect(canMoveIn("overview", "overview.b", {}, arranged)).toMatchObject({ movable: true, item: "overview.b", index: 0, count: 2 });
    // b moving right swaps with the stack in the whole row's order; c keeps its place.
    const moved = moveWithin("overview", {}, "overview.b", "right", arranged)!;
    expect(moved.layout!.order).toEqual({ mid: ["st", "overview.c", "overview.b"] });
    expect(rowView("overview", "mid", moved, arranged).items.map((i) => i.key)).toEqual(["st", "overview.b"]);
    expect(rowView("overview", "mid", moved, arranged).isDefault).toBe(false);
    // Moving it back gives the declared order, which is not stored.
    expect(moveWithin("overview", moved, "overview.b", "left", arranged)!.layout!.order).toEqual({});
    // A drop onto c lands on its stack.
    expect(dropMove("overview", {}, { row: "mid", key: "overview.b" }, "overview.c", arranged)!.layout!.order).toEqual({ mid: ["overview.c", "st", "overview.b"] });
    // A widget the variant does not draw cannot move.
    const without: Arranged = { ...reg, variants: { overview: { mid: [{ widget: "overview.b", weight: 3 }, { stack: "st", weight: 1, widgets: ["overview.d"] }] } } };
    expect(canMoveIn("overview", "overview.c", {}, without).movable).toBe(false);
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
          "overview.vmPerformance": <Widget id="overview.vmPerformance">{panel("VM performance")}</Widget>,
        }}
      </WidgetRow>
      <WidgetRow page="overview" row="r4" className="ov-row ov-row--4" data-testid="r4">
        {{
          "overview.health": <Widget id="overview.health">{panel("Health summary")}</Widget>,
          "overview.costImpact": <Widget id="overview.costImpact">{panel("Cost impact")}</Widget>,
          "overview.notes": <Widget id="overview.notes">{panel("Watchman notes")}</Widget>,
          "overview.azureHealth": <Widget id="overview.azureHealth">{panel("Azure health")}</Widget>,
          "overview.vitals": <Widget id="overview.vitals">{panel("System vitals")}</Widget>,
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
    expect(server.puts[0]!.body.prefs).toEqual({ layout: { order: { r4: ["overview.costImpact", "overview.notes", "overview.health", "overview.azureHealth", "overview.vitals", "overview.runningLabs"] } } });
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
    expect(server.puts[0]!.body.prefs).toEqual({ layout: { order: { r3: ["overview.traffic", "side", "overview.run", "overview.vmPerformance"] } } });
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

  it("a widget in a stack or alone in its row has no move controls of its own", async () => {
    renderRows({ overview: { layout: { hidden: ["overview.costImpact", "overview.notes"] } } });
    await ready();
    expect(screen.queryByRole("button", { name: "Move Recent events" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Move Status banner" })).toBeNull();
    // Health is alone in its row now.
    expect(screen.queryByRole("button", { name: "Move Health summary" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Health summary settings" }));
    let dialog = await screen.findByRole("dialog", { name: "Health summary settings" });
    expect(within(dialog).queryByRole("button", { name: /^Move/ })).toBeNull();
    await userEvent.keyboard("{Escape}");
    // In a stack: only its column's moves.
    await userEvent.click(screen.getByRole("button", { name: "Recent events settings" }));
    dialog = await screen.findByRole("dialog", { name: "Recent events settings" });
    expect(within(dialog).queryByRole("button", { name: "Move left" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Move right" })).toBeNull();
    expect(screen.getByRole("button", { name: "Move Last run" })).toBeInTheDocument();
  });

  it("a stack in a row moves as one: its top widget's handle (Alt+Arrow, drag) and every member's cog move the column", async () => {
    const { server } = renderRows();
    await ready();
    // One handle for the column, on its top widget.
    const handle = screen.getByRole("button", { name: "Move Recent events column" });
    expect(screen.queryByRole("button", { name: /^Move Speed test/ })).toBeNull();
    handle.focus();
    await userEvent.keyboard("{Alt>}{ArrowLeft}{/Alt}");
    expect(titles(rowOf("Last run"))).toEqual(["Last run", "Recent events", "Speed test", "Network traffic"]);
    expect(screen.getByRole("button", { name: "Move Recent events column" })).toHaveFocus();
    expect(document.querySelector("[data-wg-announcer]")).toHaveTextContent("Recent events column moved to position 2 of 3");
    await userEvent.click(screen.getByRole("button", { name: "Speed test settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Speed test settings" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Move column left" }));
    expect(titles(rowOf("Last run"))).toEqual(["Recent events", "Speed test", "Last run", "Network traffic"]);
    expect(within(dialog).getByRole("button", { name: "Move column left" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Move column right" })).toBeEnabled();
    await userEvent.keyboard("{Escape}");
    // Dragged by its handle onto Network traffic: the column takes traffic's place.
    const dt = transfer({});
    fireEvent.dragStart(screen.getByRole("button", { name: "Move Recent events column" }), { dataTransfer: dt });
    fireEvent.drop(region("Network traffic"), { dataTransfer: dt });
    expect(titles(rowOf("Last run"))).toEqual(["Last run", "Network traffic", "Recent events", "Speed test"]);
    await waitFor(() => expect(server.puts.at(-1)?.body.prefs).toEqual({}));
  });

  it("in a variant arrangement a widget moved into a stack has no handle of its own and its cog moves the stack", async () => {
    // Overview during a run: the run widens over traffic's slot and traffic joins the side stack.
    const server = prefsServer({});
    renderWithProviders(
      <WidgetArrangement page="overview" rows={{ r3: [{ widget: "overview.run", weight: 86 }, { stack: "side", weight: 32, widgets: ["overview.events", "overview.traffic"] }] }}>
        <Ready />
        <WidgetRow page="overview" row="r3" className="ov-row ov-row--3">
          {{
            "overview.run": <Widget id="overview.run">{panel("Last run")}</Widget>,
            side: (
              <WidgetStack page="overview" stack="side" className="ov-side">
                {{
                  "overview.events": <Widget id="overview.events">{panel("Recent events")}</Widget>,
                  "overview.traffic": <Widget id="overview.traffic">{panel("Network traffic")}</Widget>,
                }}
              </WidgetStack>
            ),
          }}
        </WidgetRow>
      </WidgetArrangement>,
      { routes: server.routes },
    );
    await ready();
    expect(titles(rowOf("Last run"))).toEqual(["Last run", "Recent events", "Network traffic"]);
    expect(screen.queryByRole("button", { name: /^Move Network traffic/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Move Recent events column" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Network traffic settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Network traffic settings" });
    expect(within(dialog).queryByRole("button", { name: "Move left" })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Move column right" })).toBeDisabled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Move column left" }));
    expect(titles(rowOf("Last run"))).toEqual(["Recent events", "Network traffic", "Last run"]);
    // Saved as an order of the whole declared row: traffic keeps its place there.
    await waitFor(() => expect(server.puts).toHaveLength(1));
    expect(server.puts[0]!.body.prefs).toEqual({ layout: { order: { r3: ["side", "overview.traffic", "overview.run", "overview.vmPerformance"] } } });
  });
});

describe("the Layout menu", () => {
  it("is widget chrome, labelled Layout", async () => {
    renderRows();
    await ready();
    const button = screen.getByRole("button", { name: "Layout" });
    expect(button.closest("[data-widget-chrome]")).not.toBeNull();
  });

  it("Layout menu: Add widgets shows hidden ones as off and On brings one back", async () => {
    const { server } = renderRows({ overview: { layout: { hidden: ["overview.notes", "overview.speedTest"] } } });
    await ready();
    expect(screen.queryByRole("region", { name: "Watchman notes" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Layout" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Add widgets…" }));
    const lib = await screen.findByRole("dialog", { name: "Add widgets" });
    expect(within(lib).getByRole("switch", { name: "Speed test" })).not.toBeChecked();
    await userEvent.click(within(lib).getByRole("switch", { name: "Watchman notes" }));
    await userEvent.keyboard("{Escape}");
    expect(region("Watchman notes")).toBeInTheDocument();
    await waitFor(() => expect(server.puts).toHaveLength(1));
    expect(server.puts[0]!.body.prefs).toEqual({ layout: { hidden: ["overview.speedTest"] } });
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
    expect(server.puts[0]!.body).toEqual({ schema: 2, baseVersion: 1, prefs: {} });
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

// ── Default-off widgets (insights spec 9.1-9.3), on the real Overview layout ──

/** One widget's library controls, with the last answer from enable() on show. */
function LibraryProbe({ id }: { id: string }) {
  const w = useWidget(id);
  const [last, setLast] = useState("");
  const { shown } = usePagePrefs("overview");
  return (
    <div>
      <output aria-label={`${id} hidden`}>{String(w.hidden)}</output>
      <output aria-label="shown">{shown.join(",")}</output>
      <output aria-label="enable result">{last}</output>
      <button onClick={() => setLast(JSON.stringify(w.enable()))}>enable {id}</button>
      <button onClick={() => w.disable()}>disable {id}</button>
      <button onClick={() => setLast(String(w.replace("overview.traffic")))}>replace traffic with {id}</button>
    </div>
  );
}

function renderLibrary(id: string, initial: Partial<Record<"overview", PagePrefs>> = {}) {
  const server = prefsServer(initial);
  const r = renderWithProviders(
    <>
      <LayoutMenu page="overview" />
      <OverviewRows />
      <LibraryProbe id={id} />
    </>,
    { routes: server.routes },
  );
  return { ...r, server };
}

describe("default-off widgets", () => {
  it("a default-off widget renders nothing until shown", async () => {
    renderLibrary("overview.vitals");
    await ready();
    expect(screen.queryByRole("region", { name: "System vitals" })).toBeNull();
    expect(screen.getByRole("status", { name: "overview.vitals hidden" })).toHaveTextContent("true");
    // As shipped: r4 is untouched, so the view's own CSS keeps its columns.
    expect(titles(screen.getByTestId("r4"))).toEqual(["Health summary", "Cost impact", "Watchman notes"]);
    expect(screen.getByTestId("r4").style.gridTemplateColumns).toBe("");
    expect(rowOf("Last run").style.gridTemplateColumns).toBe("");
  });

  it("a shown default-off widget renders in its home row", async () => {
    renderLibrary("overview.vitals", { overview: { layout: { hidden: ["overview.costImpact"], shown: ["overview.vitals"] } } });
    await ready();
    expect(titles(screen.getByTestId("r4"))).toEqual(["Health summary", "Watchman notes", "System vitals"]);
    expect(screen.getByTestId("r4").style.gridTemplateColumns).toBe("minmax(0, 54fr) minmax(0, 32fr) minmax(0, 32fr)");
  });

  it("enable adds it to shown at its declared index and saves", async () => {
    // A saved order from before this project: notes first. Azure health comes in at its declared place (after notes' row-mates).
    const { server } = renderLibrary("overview.azureHealth", { overview: { layout: { order: { r4: ["overview.notes", "overview.health", "overview.costImpact"] }, hidden: ["overview.costImpact"] } } });
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "enable overview.azureHealth" }));
    expect(screen.getByRole("status", { name: "enable result" })).toHaveTextContent('{"ok":true}');
    expect(titles(screen.getByTestId("r4"))).toEqual(["Watchman notes", "Health summary", "Azure health"]);
    expect(screen.getByRole("status", { name: "shown" })).toHaveTextContent("overview.azureHealth");
    await waitFor(() => expect(server.puts).toHaveLength(1));
    expect(server.puts[0]!.body.prefs.layout).toMatchObject({ hidden: ["overview.costImpact"], shown: ["overview.azureHealth"] });
  });

  it("enable into a full row returns full with candidates and saves nothing", async () => {
    const { server } = renderLibrary("overview.vmPerformance");
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "enable overview.vmPerformance" }));
    expect(JSON.parse(screen.getByRole("status", { name: "enable result" }).textContent!)).toEqual({ ok: false, full: true, candidates: ["overview.run", "overview.traffic"], suggestion: "overview.traffic" });
    expect(screen.queryByRole("region", { name: "VM performance" })).toBeNull();
    await new Promise((r) => setTimeout(r, SAVE_DELAY_MS + 100));
    expect(server.puts).toHaveLength(0);
  });

  it("enable of a hidden existing widget into a full row is refused the same way", async () => {
    const { server } = renderLibrary("overview.notes", { overview: { layout: { hidden: ["overview.notes", "overview.costImpact"], shown: ["overview.azureHealth", "overview.vitals"] } } });
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "enable overview.notes" }));
    expect(JSON.parse(screen.getByRole("status", { name: "enable result" }).textContent!)).toMatchObject({ ok: false, full: true, candidates: ["overview.health", "overview.azureHealth", "overview.vitals"] });
    await new Promise((r) => setTimeout(r, SAVE_DELAY_MS + 100));
    expect(server.puts).toHaveLength(0);
  });

  it("replace hides the old widget and shows the new one in its place in one PUT", async () => {
    const { server } = renderLibrary("overview.vmPerformance");
    await ready();
    const before = rowView("overview", "r3", {}).template;
    await userEvent.click(screen.getByRole("button", { name: "replace traffic with overview.vmPerformance" }));
    expect(screen.getByRole("status", { name: "enable result" })).toHaveTextContent("true");
    expect(screen.queryByRole("region", { name: "Network traffic" })).toBeNull();
    const row = rowOf("Last run");
    expect(within(row).getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Last run", "VM performance", "Recent events", "Speed test"]);
    // The same weights in the same places: the row's geometry is unchanged.
    expect(row.style.gridTemplateColumns).toBe(before);
    await waitFor(() => expect(server.puts).toHaveLength(1));
    await new Promise((r) => setTimeout(r, SAVE_DELAY_MS + 100));
    expect(server.puts).toHaveLength(1);
    expect(server.puts[0]!.body.prefs).toEqual({ layout: { order: { r3: ["overview.run", "overview.vmPerformance", "side", "overview.traffic"] }, hidden: ["overview.traffic"], shown: ["overview.vmPerformance"] } });
  });

  it("replace refuses a widget that is not a candidate", async () => {
    const { server } = renderLibrary("overview.vitals");
    await ready();
    // Traffic is in r3, not in the vitals' home row r4.
    await userEvent.click(screen.getByRole("button", { name: "replace traffic with overview.vitals" }));
    expect(screen.getByRole("status", { name: "enable result" })).toHaveTextContent("false");
    await new Promise((r) => setTimeout(r, SAVE_DELAY_MS + 100));
    expect(server.puts).toHaveLength(0);
  });

  it("disable of a default-off widget removes it from shown", async () => {
    const { server } = renderLibrary("overview.vitals", { overview: { layout: { hidden: ["overview.costImpact"], shown: ["overview.vitals"] } } });
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "disable overview.vitals" }));
    expect(screen.queryByRole("region", { name: "System vitals" })).toBeNull();
    await waitFor(() => expect(server.puts).toHaveLength(1));
    expect(server.puts[0]!.body.prefs).toEqual({ layout: { hidden: ["overview.costImpact"] } });
  });

  it("Reset this page clears shown", async () => {
    const { server } = renderLibrary("overview.vitals", { overview: { layout: { hidden: ["overview.costImpact"], shown: ["overview.vitals"] } } });
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Layout" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Reset this page…" }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Reset" }));
    expect(screen.queryByRole("region", { name: "System vitals" })).toBeNull();
    expect(titles(screen.getByTestId("r4"))).toEqual(["Health summary", "Cost impact", "Watchman notes"]);
    await waitFor(() => expect(server.puts).toHaveLength(1));
    expect(server.puts[0]!.body).toEqual({ schema: 2, baseVersion: 1, prefs: {} });
  });

  it("the phone's Widget settings list a default-off widget only while it is on", async () => {
    setViewport("phone");
    renderLibrary("overview.vitals", { overview: { layout: { hidden: ["overview.costImpact"], shown: ["overview.vitals"] } } });
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Layout" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Widget settings" }));
    const sheet = await screen.findByRole("dialog", { name: "Overview widget settings" });
    const names = within(sheet).getAllByRole("button", { name: /settings$/ }).map((b) => b.textContent);
    expect(names).toContain("System vitals");
    expect(names).not.toContain("VM performance");
    expect(names).not.toContain("Azure health");
    // Hidden widgets that ship on are still listed, as before.
    expect(names).toContain("Cost impact");
  });

  it("Add widgets shows a default-off widget as off", async () => {
    renderLibrary("overview.vitals");
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Layout" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Add widgets…" }));
    const lib = await screen.findByRole("dialog", { name: "Add widgets" });
    expect(within(lib).getByRole("switch", { name: "System vitals" })).not.toBeChecked();
  });
});
