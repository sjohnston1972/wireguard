// Labs redesign plan B6: the catalogue page, its three layouts, URL selection and states (spec §4, §9, §12; Review Focus 3 and 4).
import { beforeAll, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { setViewport } from "@/test/viewport";
import { labCoverageFixture } from "@/test/fixtures";
import { detailIdle, labs, session } from "./testData";

vi.setConfig({ testTimeout: 30_000 });
beforeAll(async () => {
  await import("@/views/labs");
});

const routes = (over: Record<string, unknown> = {}) => ({
  "GET /api/v1/labs": labs(),
  "GET /api/v1/labs/coverage": labCoverageFixture(),
  "GET /api/v1/labs/az104-06-blob-security": detailIdle(),
  ...over,
});
const loc = () => screen.getByLabelText("location").textContent ?? "";
const selectBtn = (title: RegExp) => screen.getByRole("button", { name: title, hidden: true });
const grid = () => screen.queryByRole("list", { name: "Labs" });
/** Every navigation after the first render, as "ACTION path?query". */
function track(router: ReturnType<typeof renderApp>["router"]) {
  const navs: string[] = [];
  router.subscribe((s) => navs.push(`${s.historyAction} ${s.location.pathname}${s.location.search}`));
  return navs;
}

describe("wide (1600 px)", () => {
  it("wide shows the grid and the panel with the first visible lab", async () => {
    const { router } = renderApp("/labs", { routes: routes() });
    const navs = track(router);
    const panel = await screen.findByRole("complementary", { name: "Users, groups and a custom role" });
    expect(panel).toHaveClass("labs-details");
    expect(grid()).toBeInTheDocument();
    expect(selectBtn(/^Users, groups/)).toHaveAttribute("aria-current", "true");
    // The page's parts, top to bottom.
    expect(screen.getByRole("heading", { level: 1, name: "Azure Labs" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Labs summary" })).toBeInTheDocument();
    expect(screen.getByRole("search", { name: "Filter labs" })).toBeInTheDocument();
    // The old sidebar and the enclosing panel are gone.
    expect(screen.queryByRole("region", { name: "Filters" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Catalogue" })).toBeNull();
    // the implicit first-visible selection never writes the URL
    expect(loc()).toBe("/labs");
    expect(navs).toEqual([]);
  });

  it("selecting a card writes ?lab with replace and shows it in the panel", async () => {
    const user = userEvent.setup();
    const { router } = renderApp("/labs?exam=AZ-104", { routes: routes() });
    await screen.findByRole("complementary", { name: "Users, groups and a custom role" });
    const navs = track(router);
    await user.click(selectBtn(/^Blob security/));
    expect(navs).toEqual(["REPLACE /labs?exam=AZ-104&lab=az104-06-blob-security"]);
    expect(await screen.findByRole("complementary", { name: /^Blob security/ })).toBeInTheDocument();
  });

  it("a filter that hides the selected lab drops ?lab once (one navigate)", async () => {
    const user = userEvent.setup();
    const { router } = renderApp("/labs?lab=az104-06-blob-security", { routes: routes() });
    await screen.findByRole("complementary", { name: /^Blob security/ });
    const navs = track(router);
    await user.click(within(screen.getByRole("search", { name: "Filter labs" })).getByRole("radio", { name: "AZ-305" }));
    // The filter's write, then one replace that removes ?lab; the first remaining lab is shown.
    await screen.findByRole("complementary", { name: /^Landing zone/ });
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(navs).toEqual(["REPLACE /labs?lab=az104-06-blob-security&exam=AZ-305", "REPLACE /labs?exam=AZ-305"]);
  });

  it("an unknown ?lab is dropped with one toast", async () => {
    const { router } = renderApp("/labs?lab=az104-99-nothing&exam=AZ-104", { routes: routes() });
    const navs = track(router);
    expect(await screen.findByText("Lab az104-99-nothing isn't in the catalogue.")).toBeInTheDocument();
    await waitFor(() => expect(loc()).toBe("/labs?exam=AZ-104"));
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(screen.getAllByText("Lab az104-99-nothing isn't in the catalogue.")).toHaveLength(1);
    expect(navs).toEqual(["REPLACE /labs?exam=AZ-104"]);
  });

  it("/labs/:id opens the dialog over the page with the lab selected", async () => {
    renderApp("/labs/az104-06-blob-security", { routes: routes() });
    expect(await screen.findByRole("dialog", { name: /Blob security/ })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: /^Blob security/, hidden: true })).toBeInTheDocument();
    expect(selectBtn(/^Blob security/)).toHaveAttribute("aria-current", "true");
    expect(loc()).toBe("/labs/az104-06-blob-security");
  });

  it("Back restores filters and selection", async () => {
    const { router } = renderApp("/labs?exam=AZ-104&lab=az104-05-storage", { routes: routes() });
    await screen.findByRole("complementary", { name: /^Storage accounts/ });
    // A session link or Start lab opens the dialog (a push), then Back.
    await act(() => router.navigate("/labs/az104-06-blob-security?exam=AZ-104&lab=az104-06-blob-security"));
    await screen.findByRole("dialog", { name: /Blob security/ });
    await act(() => router.navigate(-1));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(loc()).toBe("/labs?exam=AZ-104&lab=az104-05-storage");
    expect(within(screen.getByRole("search", { name: "Filter labs" })).getByRole("radio", { name: "AZ-104" })).toHaveAttribute("aria-checked", "true");
    expect(selectBtn(/^Storage accounts/)).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("complementary", { name: /^Storage accounts/ })).toBeInTheDocument();
  });

  it("selecting cards never posts deploy; a session card's link opens /labs/:id", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderApp("/labs", { routes: routes({ "GET /api/v1/labs": labs({ labs: labs().labs.map((c) => (c.number === 6 ? { ...c, running: session() } : c)), running: [session()] }) }) });
    await screen.findByRole("complementary", { name: "Users, groups and a custom role" });
    for (const t of [/^Storage accounts/, /^Azure Files/, /^Landing zone/]) await user.click(selectBtn(t));
    selectBtn(/^Users, groups/).focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(fetchMock!.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    const six = within(selectBtn(/^Blob security/).closest("article")!);
    await user.click(six.getByRole("link", { name: "Open session" }));
    expect(loc()).toBe("/labs/az104-06-blob-security?lab=az104-06-blob-security");
    expect(fetchMock!.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("a prerequisite hidden by 'Not run yet' clears only that filter, then is selected and announced", async () => {
    const user = userEvent.setup();
    // Lab 6 never run (shown by Not run yet); its prerequisite Lab 5 has run (hidden by it).
    const data = labs({ labs: labs().labs.map((c) => (c.number === 6 ? { ...c, runs: 0 } : c.number === 5 ? { ...c, runs: 3 } : c)) });
    const { router } = renderApp("/labs?q=storage&notrun=1&lab=az104-06-blob-security", { routes: routes({ "GET /api/v1/labs": data }) });
    const panel = await screen.findByRole("complementary", { name: /^Blob security/ });
    const navs = track(router);
    await user.click(within(panel).getByRole("link", { name: /^Lab 5: Storage accounts/ }));
    // Never the first visible lab: Lab 5 itself, with the search (which shows it) kept.
    expect(await screen.findByRole("complementary", { name: /^Storage accounts/ })).toBeInTheDocument();
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(navs).toEqual(["REPLACE /labs?q=storage&lab=az104-05-storage"]);
    expect(selectBtn(/^Storage accounts/)).toHaveAttribute("aria-current", "true");
    expect(await screen.findByText("Filters cleared to show Lab 5.")).toBeInTheDocument();
  });

  it("a prerequisite in another exam clears the exam filter only (other filters kept)", async () => {
    const user = userEvent.setup();
    const data = labs({ labs: labs().labs.map((c) => (c.number === 20 ? { ...c, prerequisites: ["az104-05-storage"] } : c)) });
    const { router } = renderApp("/labs?exam=AZ-305&type=explore&lab=az305-20-landing-zone", { routes: routes({ "GET /api/v1/labs": data }) });
    const panel = await screen.findByRole("complementary", { name: /^Landing zone/ });
    const navs = track(router);
    await user.click(within(panel).getByRole("link", { name: /^Lab 5: Storage accounts/ }));
    expect(await screen.findByRole("complementary", { name: /^Storage accounts/ })).toBeInTheDocument();
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(navs).toEqual(["REPLACE /labs?type=explore&lab=az104-05-storage"]);
    expect(within(screen.getByRole("search", { name: "Filter labs" })).getByRole("radio", { name: "All" })).toHaveAttribute("aria-checked", "true");
    expect(await screen.findByText("Filters cleared to show Lab 5.")).toBeInTheDocument();
  });

  it("/labs/:id/diagram unchanged: the diagram is the page", async () => {
    renderApp("/labs/az104-06-blob-security/diagram", { routes: routes() });
    expect(await within(screen.getByRole("main")).findByRole("heading", { level: 1, name: /Blob security/ })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Labs" })).toBeNull();
  });
});

describe("tablet (1024 px)", () => {
  it("tablet opens the drawer on activate (push) and Back closes it", async () => {
    const user = userEvent.setup();
    setViewport(1024);
    const { router } = renderApp("/labs?exam=AZ-104", { routes: routes() });
    await screen.findByRole("button", { name: /^Blob security/ });
    // No implicit selection and no inline panel.
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    const navs = track(router);
    await user.click(selectBtn(/^Blob security/));
    expect(navs).toEqual(["PUSH /labs?exam=AZ-104&lab=az104-06-blob-security"]);
    const drawer = await screen.findByRole("dialog", { name: /^Blob security/ });
    expect(drawer).toHaveAttribute("data-side", "right");
    await act(() => router.navigate(-1));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(loc()).toBe("/labs?exam=AZ-104");
  });

  it("Escape closes the drawer and goes back to the page it was opened from", async () => {
    const user = userEvent.setup();
    setViewport(1024);
    renderApp("/labs", { routes: routes() });
    await user.click(await screen.findByRole("button", { name: /^Blob security/ }));
    await screen.findByRole("dialog", { name: /^Blob security/ });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(loc()).toBe("/labs");
  });

  it("a prerequisite chosen in the drawer replaces ?lab; closing returns to the grid, not the previous lab, and focuses its card", async () => {
    const user = userEvent.setup();
    setViewport(1024);
    const { router } = renderApp("/labs?exam=AZ-104", { routes: routes() });
    await user.click(await screen.findByRole("button", { name: /^Blob security/ }));
    const drawer = await screen.findByRole("dialog", { name: /^Blob security/ });
    const navs = track(router);
    await user.click(within(drawer).getByRole("link", { name: /^Lab 5: Storage accounts/ }));
    expect(await screen.findByRole("dialog", { name: /^Storage accounts/ })).toBeInTheDocument();
    expect(navs).toEqual(["REPLACE /labs?exam=AZ-104&lab=az104-05-storage"]);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(loc()).toBe("/labs?exam=AZ-104");
    await waitFor(() => expect(selectBtn(/^Storage accounts/)).toHaveFocus());
  });

  it("a hidden prerequisite chosen in the drawer clears its filters; closing drops ?lab and focuses its card", async () => {
    const user = userEvent.setup();
    setViewport(1024);
    const data = labs({ labs: labs().labs.map((c) => (c.number === 6 ? { ...c, runs: 0 } : c.number === 5 ? { ...c, runs: 3 } : c)) });
    renderApp("/labs?notrun=1", { routes: routes({ "GET /api/v1/labs": data }) });
    await user.click(await screen.findByRole("button", { name: /^Blob security/ }));
    const drawer = await screen.findByRole("dialog", { name: /^Blob security/ });
    await user.click(within(drawer).getByRole("link", { name: /^Lab 5: Storage accounts/ }));
    expect(await screen.findByRole("dialog", { name: /^Storage accounts/ })).toBeInTheDocument();
    expect(loc()).toBe("/labs?lab=az104-05-storage");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(loc()).toBe("/labs");
    await waitFor(() => expect(selectBtn(/^Storage accounts/)).toHaveFocus());
  });

  it("/labs/:id?lab=:id opens the lab's dialog alone, never the drawer under it (one focus trap)", async () => {
    setViewport(1024);
    renderApp("/labs/az104-06-blob-security?lab=az104-06-blob-security", { routes: routes() });
    expect(await screen.findByRole("dialog", { name: /Blob security/ })).toHaveClass("labs-modal");
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(document.querySelector(".lab-details-drawer")).toBeNull();
  });

  it("a ?lab link opens the drawer whatever the filters hide", async () => {
    setViewport(1024);
    renderApp("/labs?exam=AZ-305&lab=az104-06-blob-security", { routes: routes() });
    expect(await screen.findByRole("dialog", { name: /^Blob security/ })).toBeInTheDocument();
    expect(loc()).toBe("/labs?exam=AZ-305&lab=az104-06-blob-security");
  });
});

describe("phone (390 px)", () => {
  it("phone shows one column and the full-width view", async () => {
    const user = userEvent.setup();
    setViewport("phone");
    const { router } = renderApp("/labs", { routes: routes() });
    await screen.findByRole("button", { name: /^Blob security/ });
    expect(screen.getByRole("button", { name: "Filters" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary")).toBeNull();
    const navs = track(router);
    await user.click(selectBtn(/^Blob security/));
    expect(navs).toEqual(["PUSH /labs?lab=az104-06-blob-security"]);
    // The view replaces the grid and the toolbar.
    expect(await screen.findByRole("region", { name: /^Blob security/ })).toHaveClass("labs-details-view");
    expect(grid()).toBeNull();
    expect(screen.queryByRole("search", { name: "Filter labs" })).toBeNull();
    // A full-width view right under the header: the strip and notices wait on the catalogue.
    expect(screen.queryByRole("region", { name: "Labs summary" })).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Azure Labs" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to labs" }));
    await waitFor(() => expect(grid()).toBeInTheDocument());
    expect(loc()).toBe("/labs");
    // Back focuses the card it came from.
    await waitFor(() => expect(selectBtn(/^Blob security/)).toHaveFocus());
  });

  it("phone: a prerequisite chosen in the view replaces ?lab; Back to labs returns to the grid and focuses its card", async () => {
    const user = userEvent.setup();
    setViewport("phone");
    const { router } = renderApp("/labs", { routes: routes() });
    await user.click(await screen.findByRole("button", { name: /^Blob security/ }));
    const view = await screen.findByRole("region", { name: /^Blob security/ });
    const navs = track(router);
    await user.click(within(view).getByRole("link", { name: /^Lab 5: Storage accounts/ }));
    expect(await screen.findByRole("region", { name: /^Storage accounts/ })).toBeInTheDocument();
    expect(navs).toEqual(["REPLACE /labs?lab=az104-05-storage"]);
    await user.click(screen.getByRole("button", { name: "Back to labs" }));
    await waitFor(() => expect(grid()).toBeInTheDocument());
    expect(loc()).toBe("/labs");
    await waitFor(() => expect(selectBtn(/^Storage accounts/)).toHaveFocus());
  });

  it("phone: a hidden setup banner stays hidden after the detail view comes and goes", async () => {
    const user = userEvent.setup();
    setViewport("phone");
    const data = labs({ labs: labs().labs.map((c) => (c.number === 1 ? { ...c, blockers: [{ kind: "role" as const, message: "Needs the role." }] } : c)) });
    renderApp("/labs", { routes: routes({ "GET /api/v1/labs": data }) });
    const banner = await screen.findByRole("region", { name: "Labs setup" });
    await user.click(within(banner).getByRole("button", { name: "Hide" }));
    expect(screen.queryByRole("region", { name: "Labs setup" })).toBeNull();
    await user.click(selectBtn(/^Blob security/));
    await screen.findByRole("region", { name: /^Blob security/ });
    await user.click(screen.getByRole("button", { name: "Back to labs" }));
    await waitFor(() => expect(grid()).toBeInTheDocument());
    expect(screen.queryByRole("region", { name: "Labs setup" })).toBeNull();
  });

  it("phone /labs/history is the Your labs page with the same header", async () => {
    setViewport("phone");
    renderApp("/labs/history", { routes: routes({ "GET /api/v1/labs/sessions": { sessions: [] } }) });
    expect(await within(screen.getByRole("main")).findByRole("heading", { level: 1, name: "Azure Labs" })).toBeInTheDocument();
    expect(await screen.findByText("No lab sessions yet")).toBeInTheDocument();
  });

  it("phone loading shows 3 skeleton cards", () => {
    setViewport("phone");
    renderApp("/labs", { routes: routes({ "GET /api/v1/labs": () => new Promise(() => {}) }) });
    expect(screen.getByRole("list", { name: "Labs" }).querySelectorAll(".lab-card--skeleton")).toHaveLength(3);
  });
});

describe("Start lab from the drawer or view, then closing the dialog (Review Focus 7)", () => {
  it.each([
    ["tablet", 1024],
    ["phone", "phone"],
  ] as const)("on the %s closing the dialog focuses the lab's card", async (_, size) => {
    const user = userEvent.setup();
    setViewport(size);
    renderApp("/labs?exam=AZ-104", { routes: routes() });
    await user.click(await screen.findByRole("button", { name: /^Blob security/ }));
    const details = size === "phone" ? await screen.findByRole("region", { name: /^Blob security/ }) : await screen.findByRole("dialog", { name: /^Blob security/ });
    await user.click(within(details).getByRole("link", { name: "Start lab" }));
    const dialog = await screen.findByRole("dialog", { name: /Blob security/ });
    expect(dialog).toHaveClass("labs-modal");
    expect(loc()).toBe("/labs/az104-06-blob-security?exam=AZ-104");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(loc()).toBe("/labs?exam=AZ-104");
    await waitFor(() => expect(selectBtn(/^Blob security/)).toHaveFocus());
  });
});

describe("states", () => {
  it("loading shows 6 skeleton cards and a panel skeleton", async () => {
    renderApp("/labs", { routes: routes({ "GET /api/v1/labs": () => new Promise(() => {}) }) });
    const list = await screen.findByRole("list", { name: "Labs" });
    expect(list.querySelectorAll(".lab-card--skeleton")).toHaveLength(6);
    const workspace = list.closest(".labs-workspace")!;
    expect(workspace).toHaveAttribute("aria-busy", "true");
    expect(workspace.querySelector(".labs-details-skeleton")).not.toBeNull();
    // The toolbar is there; the strip shows no number.
    expect(screen.getByRole("searchbox", { name: "Find a lab" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Labs summary" }).textContent).not.toMatch(/\d/);
    expect(screen.queryByText(/Showing \d/)).toBeNull();
  });

  it("error shows Retry", async () => {
    const user = userEvent.setup();
    let n = 0;
    renderApp("/labs", { routes: routes({ "GET /api/v1/labs": () => (n++ === 0 ? { status: 500, json: { error: { code: "internal", message: "The Worker could not read D1." } } } : labs()) }) });
    const alert = within(await screen.findByRole("alert"));
    expect(alert.getByText("Couldn't load the labs")).toBeInTheDocument();
    expect(alert.getByText(/The Worker could not read D1\./)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Azure Labs" })).toBeInTheDocument();
    await user.click(alert.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: /^Blob security/ })).toBeInTheDocument();
  });

  it("stale shows the StaleBanner and keeps badges", async () => {
    let n = 0;
    const { client } = renderApp("/labs", { routes: routes({ "GET /api/v1/labs": () => (n++ === 0 ? labs() : { status: 503, json: { error: { code: "down", message: "Down." } } }) }) });
    await screen.findByRole("complementary", { name: "Users, groups and a custom role" });
    await act(() => client.refetchQueries({ queryKey: ["labs"] }));
    expect(await screen.findByText(/^Couldn't refresh the labs; showing them as of \d\d:\d\d\.$/)).toBeInTheDocument();
    expect(screen.getAllByText("Ready to run").length).toBeGreaterThan(0);
    expect(screen.getByRole("list", { name: "Labs" })).toBeInTheDocument();
  });

  it("empty catalogue", async () => {
    renderApp("/labs", { routes: routes({ "GET /api/v1/labs": labs({ labs: [] }) }) });
    expect(await screen.findByText("No labs in the catalogue yet")).toBeInTheDocument();
    expect(grid()).toBeNull();
    expect(document.querySelector(".labs-details")).toBeNull();
  });

  it("no matches shows the empty state with Clear filters", async () => {
    const user = userEvent.setup();
    renderApp("/labs?exam=AZ-305&type=break-fix&lab=az305-20-landing-zone", { routes: routes() });
    expect(await screen.findByText("No labs match these filters")).toBeInTheDocument();
    // Nothing is shown, so nothing is selected: the panel is empty and ?lab is dropped.
    await waitFor(() => expect(loc()).toBe("/labs?exam=AZ-305&type=break-fix"));
    // No empty "Select a lab" box beside it: the empty state has the workspace to itself.
    expect(document.querySelector(".labs-details")).toBeNull();
    expect(document.querySelector(".labs-workspace")).toHaveClass("labs-workspace--single");
    const empty = screen.getByText("No labs match these filters").closest(".empty") as HTMLElement;
    await user.click(within(empty).getByRole("button", { name: "Clear filters" }));
    expect(await screen.findByRole("button", { name: /^Landing zone/ })).toBeInTheDocument();
  });
});
