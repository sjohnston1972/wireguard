// widget.test.tsx
//
// Plain English: the widget frame and its settings cog. Wrapping a panel in
// <Widget> adds only the cog (and, in a row, the move handle), marked
// data-widget-chrome; without them the markup is exactly the panel's. The
// cog's form is generated from the widget's settings in shared/widgets.ts.
import { describe, it, expect, afterEach, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import { prefsServer } from "@/test/fixtures";
import { setViewport } from "@/test/viewport";
import { Panel } from "@/components";
import { LayoutMenu, SAVE_DELAY_MS, Widget, WidgetCorner, useWidget, usePrefsStatus } from "@/widgets";

afterEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
  vi.restoreAllMocks();
});

/** Shows a widget's settings as JSON, so a test sees what a change did. */
function Settings({ id }: { id: string }) {
  const w = useWidget(id);
  return (
    <>
      <output aria-label="settings">{JSON.stringify(w.settings)}</output>
      <output aria-label="hidden">{String(w.hidden)}</output>
      <output aria-label="status">{usePrefsStatus()}</output>
    </>
  );
}
const settings = () => JSON.parse(screen.getByRole("status", { name: "settings", hidden: true }).textContent!);
const ready = () => waitFor(() => expect(screen.getByRole("status", { name: "status" })).toHaveTextContent("ready"));

/** React's generated ids differ when the tree around a component changes; compare markup without them. */
const plain = (html: string) => html.replace(/«r[0-9a-z]+»|:r[0-9a-z]+:|_r_[0-9a-z]+_/g, "ID");
/** The markup of `el` with every widget chrome element removed. */
function withoutChrome(el: HTMLElement): string {
  const copy = el.cloneNode(true) as HTMLElement;
  copy.querySelectorAll("[data-widget-chrome]").forEach((c) => c.remove());
  return plain(copy.innerHTML);
}

function renderWidget(ui: React.ReactNode, initial = {}) {
  const server = prefsServer(initial);
  const r = renderWithProviders(ui, { routes: server.routes });
  return { ...r, server };
}

async function openCog(title: string) {
  await userEvent.click(screen.getByRole("button", { name: `${title} settings` }));
  return screen.findByRole("dialog", { name: `${title} settings` });
}

describe("the frame", () => {
  it("Widget with chrome hidden renders the child panel's markup unchanged", async () => {
    const panels = [
      <Panel title="Live topology" status={<span>Healthy</span>} actions={<button type="button">View all</button>} className="ov-topo">
        <p>body</p>
      </Panel>,
      <Panel title="Live topology" scroll>
        <p>body</p>
      </Panel>,
      <Panel flush className="clients__table-panel">
        <table />
      </Panel>,
    ];
    for (const [i, panel] of panels.entries()) {
      const bare = renderWithProviders(<div data-testid={`bare${i}`}>{panel}</div>);
      const wrapped = renderWithProviders(
        <div data-testid={`wrapped${i}`}>
          <Settings id="overview.topology" />
          <Widget id="overview.topology">{panel}</Widget>
        </div>,
      );
      await ready();
      const w = screen.getByTestId(`wrapped${i}`);
      w.querySelectorAll("output").forEach((o) => o.remove());
      // The chrome is really there before it is taken out.
      expect(w.querySelectorAll("[data-widget-chrome]").length, `panel ${i}`).toBeGreaterThan(0);
      expect(withoutChrome(w), `panel ${i}`).toBe(plain(screen.getByTestId(`bare${i}`).innerHTML));
      bare.unmount();
      wrapped.unmount();
    }
  });

  it("a titled widget's cog sits after the panel actions and is named \"<Title> settings\"", async () => {
    renderWidget(
      <>
        <Settings id="overview.topology" />
        <Widget id="overview.topology">
          <Panel title="Live topology" actions={<button type="button">View all</button>}>
            body
          </Panel>
        </Widget>
        <Widget id="overview.health">
          <Panel title="Health summary">body</Panel>
        </Widget>
      </>,
    );
    await ready();
    const cog = screen.getByRole("button", { name: "Live topology settings" });
    expect(cog.previousElementSibling).toBe(screen.getByRole("button", { name: "View all" }));
    expect(cog.closest("[data-widget-chrome]")).not.toBeNull();
    // No actions: the cog is the header's last item.
    const health = screen.getByRole("button", { name: "Health summary settings" });
    expect(health.closest(".panel__head")!.lastElementChild).toBe(health.closest("[data-widget-chrome]"));
  });

  it("only the outermost panel of a widget carries its cog; widgetChrome={false} turns a sibling's off", async () => {
    renderWidget(
      <>
        <Settings id="overview.run" />
        <Widget id="overview.run">
          <div>
            <Panel title="Deployment pipeline">
              <Panel title="Inner">inner</Panel>
            </Panel>
            <Panel title="Live logs" widgetChrome={false}>
              logs
            </Panel>
          </div>
        </Widget>
      </>,
    );
    await ready();
    expect(screen.getAllByRole("button", { name: "Last run settings" })).toHaveLength(1);
    expect(screen.getByRole("region", { name: "Deployment pipeline" }).querySelector(".panel__head [data-widget-chrome]")).not.toBeNull();
  });

  it("a headerless widget's cog is a corner overlay reachable by Tab", async () => {
    renderWidget(
      <>
        <Settings id="clients.table" />
        <button type="button">before</button>
        <Widget id="clients.table" headerless>
          <Panel flush className="clients__table-panel">
            <table aria-label="Clients" />
          </Panel>
        </Widget>
        <Widget id="clients.kpis" headerless>
          <div className="kpis" role="group" aria-label="Client counts">
            <span>tiles</span>
            <WidgetCorner />
          </div>
        </Widget>
      </>,
    );
    await ready();
    const cog = screen.getByRole("button", { name: "Clients settings" });
    const corner = cog.closest(".wg-corner")!;
    expect(corner).toHaveAttribute("data-widget-chrome");
    expect(corner.parentElement).toHaveClass("panel");
    expect(corner.parentElement!.lastElementChild).toBe(corner);
    screen.getByRole("button", { name: "before" }).focus();
    await userEvent.tab();
    expect(cog).toHaveFocus();
    // A block that is not a Panel puts <WidgetCorner /> where it wants the overlay.
    const kpis = screen.getByRole("button", { name: "Client figures settings" });
    expect(kpis.closest(".wg-corner")!.parentElement).toBe(screen.getByRole("group", { name: "Client counts" }));
  });

  it("a hidden widget renders nothing", async () => {
    renderWidget(
      <>
        <Settings id="overview.topology" />
        <Widget id="overview.topology">
          <Panel title="Live topology">body</Panel>
        </Widget>
      </>,
      { overview: { layout: { hidden: ["overview.topology"] } } },
    );
    await ready();
    expect(screen.queryByRole("region", { name: "Live topology" })).toBeNull();
  });
});

describe("the cog", () => {
  function cogFor(id: string, title: string, initial = {}) {
    return renderWidget(
      <>
        <Settings id={id} />
        <Widget id={id}>
          <Panel title={title}>body</Panel>
        </Widget>
      </>,
      initial,
    );
  }

  it("the cog shows only non-empty sections Data, Thresholds, Display", async () => {
    cogFor("overview.keyMetrics", "Key metrics");
    await ready();
    let dialog = await openCog("Key metrics");
    expect(within(dialog).getByRole("heading", { name: "Key metrics settings" })).toBeInTheDocument();
    expect(within(dialog).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Data", "Thresholds", "Display"]);
    await userEvent.keyboard("{Escape}");
    cogFor("overview.topology", "Live topology");
    dialog = await openCog("Live topology");
    expect(within(dialog).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Display"]);
    await userEvent.keyboard("{Escape}");
    cogFor("cost.insights", "Insights");
    dialog = await openCog("Insights");
    expect(within(dialog).queryAllByRole("heading", { level: 3 })).toEqual([]);
    expect(within(dialog).getByRole("button", { name: "Reset to default" })).toBeDisabled();
  });

  it("form: enum with 4 options or fewer is a segmented control", async () => {
    cogFor("overview.events", "Recent events");
    await ready();
    const dialog = await openCog("Recent events");
    const group = within(dialog).getByRole("radiogroup", { name: "Range" });
    expect(within(group).getByRole("radio", { name: "24h" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(within(group).getByRole("radio", { name: "7d" }));
    expect(settings().range).toBe("7d");
  });

  it("form: enum with more options is a select", async () => {
    cogFor("overview.keyMetrics", "Key metrics");
    await ready();
    const dialog = await openCog("Key metrics");
    await userEvent.click(within(dialog).getByRole("combobox", { name: "Starting range" }));
    await userEvent.click(await screen.findByRole("option", { name: "30d" }));
    expect(settings().range).toBe("30d");
  });

  it("form: boolean is a switch", async () => {
    cogFor("overview.events", "Recent events");
    await ready();
    const dialog = await openCog("Recent events");
    const sw = within(dialog).getByRole("switch", { name: "Detail line" });
    expect(sw).toBeChecked();
    await userEvent.click(sw);
    expect(settings().detail).toBe(false);
  });

  it("form: number with unit commits on Enter or blur; an invalid number shows its message and is not saved", async () => {
    const { server } = cogFor("firewall.capture", "Packet capture");
    await ready();
    const dialog = await openCog("Packet capture");
    const box = within(dialog).getByRole("textbox", { name: "Starting seconds" });
    expect(box).toHaveValue("30");
    expect(within(dialog).getByText("s", { selector: ".wg-unit" })).toBeInTheDocument();
    await userEvent.clear(box);
    await userEvent.type(box, "45{Enter}");
    expect(settings().seconds).toBe(45);
    await userEvent.clear(box);
    await userEvent.type(box, "31");
    expect(settings().seconds).toBe(45);
    await userEvent.tab();
    expect(within(dialog).getByText("Starting seconds must be in steps of 5.")).toBeInTheDocument();
    expect(box).toHaveAttribute("aria-invalid", "true");
    expect(settings().seconds).toBe(45);
    await waitFor(() => expect(server.puts).toHaveLength(1));
    expect(server.puts[0]!.body.prefs).toEqual({ widgets: { "firewall.capture": { v: 1, s: { seconds: 45 } } } });
  });

  it("typing in a number field sends one save", async () => {
    const { server } = cogFor("overview.events", "Recent events");
    await ready();
    const dialog = await openCog("Recent events");
    const box = within(dialog).getByRole("textbox", { name: "Rows" });
    await userEvent.clear(box);
    await userEvent.type(box, "10");
    await userEvent.tab();
    expect(settings().rows).toBe(10);
    await waitFor(() => expect(server.puts).toHaveLength(1));
    await new Promise((r) => setTimeout(r, SAVE_DELAY_MS + 100));
    expect(server.puts).toHaveLength(1);
  });

  it("form: multi keeps at least minSelected on", async () => {
    cogFor("overview.traffic", "Network traffic");
    await ready();
    const dialog = await openCog("Network traffic");
    const group = within(dialog).getByRole("group", { name: "Series" });
    await userEvent.click(within(group).getByRole("button", { name: "Out" }));
    expect(settings().series).toEqual(["in"]);
    await userEvent.click(within(group).getByRole("button", { name: "In" }));
    expect(settings().series).toEqual(["in"]);
    expect(within(group).getByRole("button", { name: "In" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(within(group).getByRole("button", { name: "Out" }));
    expect(settings().series).toEqual(["in", "out"]);
  });

  it("form: a threshold is a Warn and a Bad number, each with an Off switch", async () => {
    cogFor("overview.keyMetrics", "Key metrics");
    await ready();
    const dialog = await openCog("Key metrics");
    const latency = within(dialog).getByRole("group", { name: "Latency (average)" });
    const warnOn = within(latency).getByRole("switch", { name: "Latency (average): Warn on" });
    expect(warnOn).not.toBeChecked();
    expect(within(latency).getByRole("textbox", { name: "Latency (average): Warn" })).toBeDisabled();
    await userEvent.click(warnOn);
    expect(settings().latency).toEqual({ warn: 999, bad: null });
    const warn = within(latency).getByRole("textbox", { name: "Latency (average): Warn" });
    await userEvent.clear(warn);
    await userEvent.type(warn, "50{Enter}");
    expect(settings().latency).toEqual({ warn: 50, bad: null });
    await userEvent.click(within(latency).getByRole("switch", { name: "Latency (average): Bad on" }));
    expect(settings().latency).toEqual({ warn: 50, bad: 1000 });
    await userEvent.clear(warn);
    await userEvent.type(warn, "1000{Enter}");
    expect(within(latency).getByText("Warn must be below Bad.")).toBeInTheDocument();
    expect(settings().latency).toEqual({ warn: 50, bad: 1000 });
    await userEvent.click(within(latency).getByRole("switch", { name: "Latency (average): Warn on" }));
    expect(settings().latency).toEqual({ warn: null, bad: 1000 });
  });

  it("threshold hint says it colours this dashboard only", async () => {
    cogFor("cost.kpis", "Cost figures");
    await ready();
    const dialog = await openCog("Cost figures");
    expect(within(dialog).getByText("Colours this dashboard only. Alerts are unchanged.")).toBeInTheDocument();
  });

  it("Reset to default is disabled until something differs, then clears the widget", async () => {
    const { server } = cogFor("overview.events", "Recent events");
    await ready();
    const dialog = await openCog("Recent events");
    const reset = within(dialog).getByRole("button", { name: "Reset to default" });
    expect(reset).toBeDisabled();
    await userEvent.click(within(dialog).getByRole("switch", { name: "Detail line" }));
    expect(reset).toBeEnabled();
    await userEvent.click(reset);
    expect(settings()).toMatchObject({ detail: true, rows: 5 });
    expect(reset).toBeDisabled();
    await waitFor(() => expect(server.puts.length).toBeGreaterThan(0));
    await waitFor(() => expect(server.state.pages.overview.prefs).toEqual({}));
  });

  it("Hide widget hides it; Hide widget is absent on a pinned widget", async () => {
    renderWidget(
      <>
        <Settings id="overview.events" />
        <Widget id="overview.events">
          <Panel title="Recent events">body</Panel>
        </Widget>
        <Widget id="overview.status" headerless>
          <section className="ov-banner">
            banner
            <WidgetCorner />
          </section>
        </Widget>
      </>,
    );
    await ready();
    let dialog = await openCog("Status banner");
    expect(within(dialog).queryByRole("button", { name: "Hide widget" })).toBeNull();
    await userEvent.keyboard("{Escape}");
    dialog = await openCog("Recent events");
    await userEvent.click(within(dialog).getByRole("button", { name: "Hide widget" }));
    expect(screen.getByRole("status", { name: "hidden" })).toHaveTextContent("true");
    expect(screen.queryByRole("region", { name: "Recent events" })).toBeNull();
  });

  for (const size of ["desktop", "phone"] as const) {
    it(`after Hide widget, focus moves to the page's Layout button and the change is announced (${size})`, async () => {
      if (size === "phone") setViewport("phone");
      renderWidget(
        <>
          <Settings id="overview.events" />
          <LayoutMenu page="overview" />
          <Widget id="overview.events">
            <Panel title="Recent events">body</Panel>
          </Widget>
        </>,
      );
      await ready();
      const dialog = await openCog("Recent events");
      await userEvent.click(within(dialog).getByRole("button", { name: "Hide widget" }));
      expect(screen.getByRole("status", { name: "hidden" })).toHaveTextContent("true");
      const layout = screen.getByRole("button", { name: "Layout" });
      await waitFor(() => expect(document.activeElement).toBe(layout));
      // Still there once the closing dialog has had its say about focus.
      await new Promise((r) => setTimeout(r, 50));
      expect(document.activeElement).toBe(layout);
      expect(document.querySelector("[data-wg-announcer]")).toHaveTextContent("Recent events hidden. Show it from Layout.");
    });
  }

  it("on the phone the cog opens a bottom sheet with the same sections", async () => {
    setViewport("phone");
    cogFor("overview.keyMetrics", "Key metrics");
    await ready();
    const sheet = await openCog("Key metrics");
    expect(sheet).toHaveAttribute("data-side", "bottom");
    expect(within(sheet).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Data", "Thresholds", "Display"]);
    await userEvent.click(within(sheet).getByRole("switch", { name: "Sub-lines" }));
    expect(settings().subLines).toBe(false);
  });

  it("if prefs fail to load, the cog says so and changes nothing", async () => {
    renderWithProviders(
      <>
        <Settings id="overview.events" />
        <Widget id="overview.events">
          <Panel title="Recent events">body</Panel>
        </Widget>
      </>,
      { routes: { "GET /api/v1/prefs": { status: 500, json: { error: { code: "internal", message: "Something broke" } } } } },
    );
    await waitFor(() => expect(screen.getByRole("status", { name: "status" })).toHaveTextContent("failed"));
    const dialog = await openCog("Recent events");
    expect(within(dialog).getByText("Widget settings couldn't be loaded, so changes can't be saved right now.")).toBeInTheDocument();
    expect(within(dialog).getByRole("switch", { name: "Detail line" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Hide widget" })).toBeDisabled();
  });
});
