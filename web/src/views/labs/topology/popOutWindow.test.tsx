// Issue #93: a lab's diagram in a larger dialog, and popped out into its own
// browser window (/labs/:id/diagram?popout=1, chromeless) for a second screen.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { focusManager } from "@tanstack/react-query";
import type { LabDetail } from "@shared/api";
import { renderApp } from "@/test/render";
import { expectCentredModal } from "@/test/dialogs";
import { detailIdle, detailRunning, labs } from "../testData";
import { LAB, LAYOUT_API, PLANNED_URL, TOPOLOGY_API, layoutServer, liveOk, plannedGraph } from "./places.fixtures";
import { LAB_ENDED_BANNER, POPOUT_FEATURES, forgetPopOuts, popOutName, popOutUrl } from "./popOutWindow";

vi.setConfig({ testTimeout: 20_000 });
beforeAll(async () => {
  await import("@/views/labs");
  await import("./index");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  forgetPopOuts();
  focusManager.setFocused(undefined);
});

const routes = (detail: LabDetail | (() => LabDetail) = detailIdle(), more: Record<string, unknown> = {}) => {
  const first = typeof detail === "function" ? detail() : detail;
  return {
    "GET /api/v1/labs": labs({ running: first.session ? [first.session] : [] }),
    [`GET /api/v1/labs/${LAB}`]: detail,
    [`GET ${PLANNED_URL}`]: plannedGraph(),
    [`GET ${TOPOLOGY_API}`]: liveOk(),
    ...layoutServer().routes,
    ...more,
  };
};
const dialog = () => screen.findByRole("dialog", { name: /Blob security/ });
const fakeWindow = () => ({ closed: false, focus: vi.fn() }) as unknown as Window & { focus: ReturnType<typeof vi.fn> };
const POPOUT = `/labs/${LAB}/diagram?popout=1`;

describe("the larger Diagram tab", () => {
  it("the lab dialog widens while the Diagram tab is shown, and is its usual size on the readme", async () => {
    const user = userEvent.setup();
    renderApp(`/labs/${LAB}?view=diagram`, { routes: routes() });
    expectCentredModal(await dialog(), "xl");
    await user.click(within(await dialog()).getByRole("tab", { name: "Readme" }));
    await waitFor(async () => expectCentredModal(await dialog(), "lg"));
    await user.click(within(await dialog()).getByRole("tab", { name: "Diagram" }));
    await waitFor(async () => expectCentredModal(await dialog(), "xl"));
  });

  it("a running lab's dialog widens on the Diagram tab too", async () => {
    renderApp(`/labs/${LAB}?view=diagram`, { routes: routes(detailRunning()) });
    const el = await dialog();
    expectCentredModal(el, "xl");
    expect(el).toHaveClass("labs-modal--diagram");
  });
});

describe("Pop out", () => {
  it("the tab's Pop out opens the chromeless diagram in a named pop-up window", async () => {
    const user = userEvent.setup();
    const win = fakeWindow();
    const open = vi.fn(() => win);
    vi.stubGlobal("open", open);
    renderApp(`/labs/${LAB}?view=diagram`, { routes: routes() });
    const d = within(await dialog());
    await user.click(await d.findByRole("button", { name: "Pop out" }));
    expect(POPOUT).toBe(popOutUrl(LAB));
    expect(open).toHaveBeenCalledWith(POPOUT, `wg-lab-diagram-${LAB}`, "popup,width=1400,height=900");
    expect(popOutName(LAB)).toBe(`wg-lab-diagram-${LAB}`);
    expect(POPOUT_FEATURES).toBe("popup,width=1400,height=900");
    // The main tab stays where it was.
    expect(screen.getByLabelText("location")).toHaveTextContent(`/labs/${LAB}?view=diagram`);
  });

  it("a second Pop out focuses the window already open instead of opening another", async () => {
    const user = userEvent.setup();
    const win = fakeWindow();
    const open = vi.fn(() => win);
    vi.stubGlobal("open", open);
    renderApp(`/labs/${LAB}?view=diagram`, { routes: routes() });
    const button = await within(await dialog()).findByRole("button", { name: "Pop out" });
    await user.click(button);
    await user.click(button);
    expect(open).toHaveBeenCalledTimes(1);
    expect(win.focus).toHaveBeenCalled();
    // Closed by the person: the next Pop out opens it again.
    (win as { closed: boolean }).closed = true;
    await user.click(button);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("the full screen has Pop out too", async () => {
    const user = userEvent.setup();
    const open = vi.fn(() => fakeWindow());
    vi.stubGlobal("open", open);
    renderApp(`/labs/${LAB}/diagram`, { routes: routes() });
    await user.click(await within(screen.getByRole("main")).findByRole("button", { name: "Pop out" }));
    expect(open).toHaveBeenCalledWith(POPOUT, popOutName(LAB), POPOUT_FEATURES);
  });

  it("a blocked pop-up says so and offers the diagram in a new tab", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("open", vi.fn(() => null));
    renderApp(`/labs/${LAB}?view=diagram`, { routes: routes() });
    const d = within(await dialog());
    await user.click(await d.findByRole("button", { name: "Pop out" }));
    const note = await d.findByRole("status", { name: /pop-up was blocked/i });
    expect(note).toHaveTextContent(/browser blocked the pop-up/i);
    const link = within(note).getByRole("link", { name: "Open the diagram in a new tab" });
    expect(link).toHaveAttribute("href", POPOUT);
    expect(link).toHaveAttribute("target", "_blank");
  });
});

describe("the pop-out window", () => {
  it("is chromeless: the lab's diagram and its controls, no app navigation, a way back, and its own title", async () => {
    renderApp(POPOUT, { routes: routes() });
    expect(await screen.findByRole("heading", { level: 1, name: /Blob security/ })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Phone" })).toBeNull();
    expect(screen.queryByRole("link", { name: "wg-admin home" })).toBeNull();
    const main = within(screen.getByRole("main"));
    await main.findByRole("region", { name: "Lab diagram" });
    expect(main.getByRole("searchbox", { name: "Search the diagram" })).toBeInTheDocument();
    expect(main.getByRole("switch", { name: "Show dependencies" })).toBeInTheDocument();
    expect(main.getByRole("button", { name: "Reset layout" })).toBeInTheDocument();
    expect(main.getByRole("button", { name: "Legend" })).toBeInTheDocument();
    // Nothing that would leave or duplicate the window.
    expect(main.queryByRole("button", { name: "Pop out" })).toBeNull();
    expect(main.queryByRole("link", { name: "Full screen" })).toBeNull();
    expect(main.queryByRole("button", { name: "Close" })).toBeNull();
    expect(main.getByRole("link", { name: "Back to dashboard" })).toHaveAttribute("href", `/labs/${LAB}`);
    await waitFor(() => expect(document.title).toBe(`${LAB} diagram · wg-admin`));
  });

  it("focus lands on the canvas", async () => {
    renderApp(POPOUT, { routes: routes() });
    const region = await within(screen.getByRole("main")).findByRole("region", { name: "Lab diagram" });
    await waitFor(() => expect(document.activeElement).toBe(region));
  });

  it("a running lab has the Live/Planned toggle and asks for the live view", async () => {
    const r = renderApp(POPOUT, { routes: routes(detailRunning()) });
    expect(await within(screen.getByRole("main")).findByRole("radiogroup", { name: "Diagram source" })).toBeInTheDocument();
    expect(r.fetchMock!.calls.some((c) => c.url.startsWith(TOPOLOGY_API))).toBe(true);
  });

  it("the lab ending while it is open shows the planned design with a banner", async () => {
    let detail = detailRunning();
    const r = renderApp(POPOUT, { routes: routes(() => detail) });
    const main = within(screen.getByRole("main"));
    await main.findByRole("radiogroup", { name: "Diagram source" });
    expect(main.queryByText(LAB_ENDED_BANNER)).toBeNull();
    detail = detailIdle();
    await act(() => r.client.invalidateQueries({ queryKey: ["labs", LAB] }));
    expect(await main.findByText(LAB_ENDED_BANNER)).toBeInTheDocument();
    expect(LAB_ENDED_BANNER).toBe("Lab ended — showing the planned design.");
    expect(main.queryByRole("radiogroup", { name: "Diagram source" })).toBeNull();
    expect(await main.findByRole("region", { name: "Lab diagram" })).toBeInTheDocument();
  });

  it("a lab that never ran shows the planned design without the ended banner", async () => {
    renderApp(POPOUT, { routes: routes() });
    const main = within(screen.getByRole("main"));
    await main.findByRole("region", { name: "Lab diagram" });
    expect(main.getByText(/Example addresses/)).toBeInTheDocument();
    expect(main.queryByText(LAB_ENDED_BANNER)).toBeNull();
  });

  it("an expired sign-in shows the app's signed-out screen, still without the app's chrome", async () => {
    renderApp(POPOUT, { routes: routes(detailIdle(), { [`GET /api/v1/labs/${LAB}`]: { status: 401, json: { error: "unauthorised" } } }) });
    expect(await screen.findByRole("heading", { name: "Session expired, sign in again" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
  });

  it("Back to dashboard focuses the window that opened it", async () => {
    const opener = fakeWindow();
    vi.stubGlobal("opener", opener);
    renderApp(POPOUT, { routes: routes() });
    const link = await within(screen.getByRole("main")).findByRole("link", { name: "Back to dashboard" });
    expect(fireEvent.click(link)).toBe(false); // handled: no navigation here
    expect(opener.focus).toHaveBeenCalled();
    expect(screen.getByLabelText("location")).toHaveTextContent(POPOUT);
  });

  it("with the main tab closed, Back to dashboard opens the app in a new tab", async () => {
    const opener = fakeWindow();
    (opener as { closed: boolean }).closed = true;
    vi.stubGlobal("opener", opener);
    renderApp(POPOUT, { routes: routes() });
    const link = await within(screen.getByRole("main")).findByRole("link", { name: "Back to dashboard" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(fireEvent.click(link)).toBe(true); // the browser follows the link
    expect(opener.focus).not.toHaveBeenCalled();
  });

  it("the canvas region is focusable from script but not a tab stop", async () => {
    renderApp(POPOUT, { routes: routes() });
    const region = await within(screen.getByRole("main")).findByRole("region", { name: "Lab diagram" });
    expect(region).toHaveAttribute("tabindex", "-1");
  });
});

describe("the arrangement between windows", () => {
  it("a diagram re-reads the saved arrangement when its window gets focus (a move made in the other window shows)", async () => {
    const r = renderApp(`/labs/${LAB}?view=diagram`, { routes: routes() });
    await within(await dialog()).findByRole("region", { name: "Lab diagram" });
    const reads = () => r.fetchMock!.calls.filter((c) => c.url.startsWith(LAYOUT_API) && c.method === "GET").length;
    const before = reads();
    expect(before).toBeGreaterThan(0);
    act(() => focusManager.setFocused(false));
    act(() => focusManager.setFocused(true));
    await waitFor(() => expect(reads()).toBe(before + 1));
  });
});
