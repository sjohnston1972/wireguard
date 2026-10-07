// prefs.test.tsx
//
// Plain English: the app's copy of the widget preferences. They load with
// the shell, a change shows at once and is saved in the background after a
// quiet spell, one save per page at a time; a failed or conflicting save
// puts the page back as it was and says why.
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp, renderWithProviders } from "@/test/render";
import { prefsFixture, prefsServer } from "@/test/fixtures";
import { PREFS_MIRROR_KEY, SAVE_DELAY_MS, usePrefs, usePrefsStatus, useWidget } from "@/widgets";

// Renders the whole app (shell and a real view), which can take a few seconds while every test file
// runs at once: room beyond Vitest's default 5 s, as the view folders' own suites have.
vi.setConfig({ testTimeout: 20_000 });

afterEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* a test may have broken it on purpose */
  }
  vi.restoreAllMocks();
});

/** A widget's view of the preferences, with buttons for the changes the tests make. */
function Probe({ id = "overview.events" }: { id?: string }) {
  usePrefs();
  const w = useWidget(id);
  const status = usePrefsStatus();
  return (
    <div>
      <output aria-label="status">{status}</output>
      <output aria-label="rows">{String(w.settings.rows)}</output>
      <output aria-label="hidden">{String(w.hidden)}</output>
      <output aria-label="read-only">{String(w.readOnly)}</output>
      <button onClick={() => w.set("rows", 7)}>rows 7</button>
      <button onClick={() => w.set("rows", 8)}>rows 8</button>
      <button onClick={() => w.set("rows", 99)}>rows 99</button>
      <button onClick={() => w.hide()}>hide</button>
    </div>
  );
}

const out = (name: string) => screen.getByRole("status", { name });
const saved = { overview: { widgets: { "overview.events": { v: 1, s: { rows: 9 } } } } };

/** A promise the test resolves itself. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("loading", () => {
  it("prefs load with the session and widgets read saved settings", async () => {
    const { fetchMock } = renderApp("/settings");
    await waitFor(() => expect(fetchMock!.callsTo("GET", "/api/v1/prefs").length).toBeGreaterThan(0));

    const server = prefsServer(saved);
    renderWithProviders(<Probe />, { routes: server.routes });
    await waitFor(() => expect(out("status")).toHaveTextContent("ready"));
    expect(out("rows")).toHaveTextContent("9");
    expect(out("hidden")).toHaveTextContent("false");
    expect(out("read-only")).toHaveTextContent("false");
  });

  it("the last good prefs are mirrored to localStorage and used while loading; a throwing localStorage is ignored", async () => {
    const server = prefsServer(saved);
    const first = renderWithProviders(<Probe />, { routes: server.routes });
    await waitFor(() => expect(out("status")).toHaveTextContent("ready"));
    expect(JSON.parse(localStorage.getItem(PREFS_MIRROR_KEY)!).pages.overview.prefs).toEqual(saved.overview);
    first.unmount();

    // Next visit: the server is slow, the mirror shows the saved settings meanwhile.
    const slow = deferred<unknown>();
    renderWithProviders(<Probe />, { routes: { "GET /api/v1/prefs": () => slow.promise } });
    expect(out("status")).toHaveTextContent("loading");
    expect(out("rows")).toHaveTextContent("9");
    expect(out("read-only")).toHaveTextContent("true");
    await act(async () => slow.resolve(prefsFixture()));
    await waitFor(() => expect(out("rows")).toHaveTextContent("5"));
  });

  it("a throwing localStorage is ignored", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    renderWithProviders(<Probe />, { routes: prefsServer(saved).routes });
    await waitFor(() => expect(out("status")).toHaveTextContent("ready"));
    expect(out("rows")).toHaveTextContent("9");
  });

  it("if prefs fail to load, cogs are read-only and nothing is saved", async () => {
    const { fetchMock } = renderWithProviders(<Probe />, { routes: { "GET /api/v1/prefs": { status: 500, json: { error: { code: "internal", message: "Something broke" } } } } });
    await waitFor(() => expect(out("status")).toHaveTextContent("failed"));
    expect(out("rows")).toHaveTextContent("5");
    expect(out("read-only")).toHaveTextContent("true");
    await userEvent.click(screen.getByRole("button", { name: "rows 7" }));
    await userEvent.click(screen.getByRole("button", { name: "hide" }));
    expect(out("rows")).toHaveTextContent("5");
    await new Promise((r) => setTimeout(r, SAVE_DELAY_MS + 100));
    expect(fetchMock!.calls.filter((c) => c.method === "PUT")).toHaveLength(0);
  });
});

describe("saving", () => {
  it("a change shows at once and saves after 600 ms", async () => {
    expect(SAVE_DELAY_MS).toBe(600);
    const server = prefsServer(saved);
    let putAt = 0;
    const put = server.routes["PUT /api/v1/prefs/overview"] as (r: unknown) => unknown;
    server.routes["PUT /api/v1/prefs/overview"] = (r: unknown) => {
      putAt = performance.now();
      return put(r);
    };
    renderWithProviders(<Probe />, { routes: server.routes });
    await waitFor(() => expect(out("status")).toHaveTextContent("ready"));
    const before = performance.now();
    await userEvent.click(screen.getByRole("button", { name: "rows 7" }));
    const after = performance.now();
    expect(out("rows")).toHaveTextContent("7");
    expect(server.puts).toHaveLength(0);
    await waitFor(() => expect(server.puts).toHaveLength(1));
    // The save went out a quiet spell after the change (which happened between before and after).
    expect(putAt - before).toBeGreaterThanOrEqual(SAVE_DELAY_MS - 5);
    expect(putAt - after).toBeLessThan(SAVE_DELAY_MS + 400);
    expect(server.puts[0]).toEqual({ page: "overview", body: { schema: 2, baseVersion: 1, prefs: { widgets: { "overview.events": { v: 1, s: { rows: 7 } } } } } });
    expect(out("rows")).toHaveTextContent("7");
    expect(server.state.pages.overview.version).toBe(2);
  });

  it("typing in a number field sends one save (changes in the quiet spell are coalesced)", async () => {
    const server = prefsServer(saved);
    renderWithProviders(<Probe />, { routes: server.routes });
    await waitFor(() => expect(out("status")).toHaveTextContent("ready"));
    await userEvent.click(screen.getByRole("button", { name: "rows 7" }));
    await userEvent.click(screen.getByRole("button", { name: "rows 8" }));
    await userEvent.click(screen.getByRole("button", { name: "rows 7" }));
    await waitFor(() => expect(server.puts).toHaveLength(1));
    await new Promise((r) => setTimeout(r, SAVE_DELAY_MS + 100));
    expect(server.puts).toHaveLength(1);
    expect(server.puts[0]!.body.prefs).toEqual({ widgets: { "overview.events": { v: 1, s: { rows: 7 } } } });
  });

  it("an invalid value is never applied or saved", async () => {
    const server = prefsServer(saved);
    renderWithProviders(<Probe />, { routes: server.routes });
    await waitFor(() => expect(out("status")).toHaveTextContent("ready"));
    await userEvent.click(screen.getByRole("button", { name: "rows 99" }));
    expect(out("rows")).toHaveTextContent("9");
    await new Promise((r) => setTimeout(r, SAVE_DELAY_MS + 100));
    expect(server.puts).toHaveLength(0);
  });

  it("changes made during a save are sent after it with the new version", async () => {
    const server = prefsServer(saved);
    const put = server.routes["PUT /api/v1/prefs/overview"] as (r: unknown) => unknown;
    const gate = deferred<void>();
    let calls = 0;
    server.routes["PUT /api/v1/prefs/overview"] = async (r: unknown) => {
      calls++;
      if (calls === 1) await gate.promise;
      return put(r);
    };
    renderWithProviders(<Probe />, { routes: server.routes });
    await waitFor(() => expect(out("status")).toHaveTextContent("ready"));
    await userEvent.click(screen.getByRole("button", { name: "rows 7" }));
    await waitFor(() => expect(calls).toBe(1));
    // While the first save is out: another change, and the quiet spell passes.
    await userEvent.click(screen.getByRole("button", { name: "hide" }));
    expect(out("hidden")).toHaveTextContent("true");
    await new Promise((r) => setTimeout(r, SAVE_DELAY_MS + 100));
    expect(calls).toBe(1);
    await act(async () => gate.resolve());
    await waitFor(() => expect(server.puts).toHaveLength(2));
    expect(server.puts[1]!.body).toEqual({ schema: 2, baseVersion: 2, prefs: { layout: { hidden: ["overview.events"] }, widgets: { "overview.events": { v: 1, s: { rows: 7 } } } } });
    await waitFor(() => expect(server.state.pages.overview.version).toBe(3));
    expect(out("hidden")).toHaveTextContent("true");
    expect(out("rows")).toHaveTextContent("7");
  });

  it("a hidden tab flushes the pending save", async () => {
    const server = prefsServer(saved);
    renderWithProviders(<Probe />, { routes: server.routes });
    await waitFor(() => expect(out("status")).toHaveTextContent("ready"));
    await userEvent.click(screen.getByRole("button", { name: "rows 7" }));
    const clickedAt = performance.now();
    const vis = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(server.puts).toHaveLength(1));
    expect(performance.now() - clickedAt).toBeLessThan(SAVE_DELAY_MS - 100);
    vis.mockRestore();
  });

  it("the save sent as the tab is hidden or closed uses keepalive, so it outlives the page", async () => {
    const server = prefsServer(saved);
    const { fetchMock } = renderWithProviders(<Probe />, { routes: server.routes });
    await waitFor(() => expect(out("status")).toHaveTextContent("ready"));
    // Hidden.
    await userEvent.click(screen.getByRole("button", { name: "rows 7" }));
    const vis = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(server.puts).toHaveLength(1));
    vis.mockRestore();
    const puts = () => fetchMock!.calls.filter((c) => c.method === "PUT");
    expect(puts()[0]!.init.keepalive).toBe(true);
    // Closed (pagehide, which some browsers fire without a visibilitychange).
    await userEvent.click(screen.getByRole("button", { name: "rows 8" }));
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    await waitFor(() => expect(server.puts).toHaveLength(2));
    expect(puts()[1]!.init.keepalive).toBe(true);
    expect(server.puts[1]!.body.prefs).toEqual({ widgets: { "overview.events": { v: 1, s: { rows: 8 } } } });
    // An ordinary save after the quiet spell does not need it.
    await userEvent.click(screen.getByRole("button", { name: "rows 7" }));
    await waitFor(() => expect(server.puts).toHaveLength(3));
    expect(puts()[2]!.init.keepalive).toBeFalsy();
  });
});

describe("re-renders", () => {
  const two = { overview: { widgets: { "overview.events": { v: 1, s: { rows: 9 } }, "overview.speedTest": { v: 1, s: { shown: 2 } } } } };

  function Loader() {
    usePrefs();
    return null;
  }

  function Counted({ id, renders, seen }: { id: string; renders: Record<string, number>; seen: Record<string, unknown[]> }) {
    const w = useWidget(id);
    renders[id] = (renders[id] ?? 0) + 1;
    (seen[id] ??= []).push(w.settings);
    return (
      <div>
        <output aria-label={`${id} status`}>{w.status}</output>
        <button onClick={() => w.set(id === "overview.events" ? "rows" : "shown", id === "overview.events" ? 7 : 4)}>change {id}</button>
      </div>
    );
  }

  it("a change re-renders only the widget it changes, and the others keep the same settings object", async () => {
    const renders: Record<string, number> = {};
    const seen: Record<string, unknown[]> = {};
    renderWithProviders(
      <>
        <Loader />
        <Counted id="overview.events" renders={renders} seen={seen} />
        <Counted id="overview.speedTest" renders={renders} seen={seen} />
        <Counted id="overview.health" renders={renders} seen={seen} />
      </>,
      { routes: prefsServer(two).routes },
    );
    await waitFor(() => expect(out("overview.events status")).toHaveTextContent("ready"));
    await waitFor(() => expect(out("overview.health status")).toHaveTextContent("ready"));
    const before = { ...renders };
    const speedSettings = seen["overview.speedTest"]!.at(-1);
    await userEvent.click(screen.getByRole("button", { name: "change overview.events" }));
    expect(renders["overview.events"]).toBeGreaterThan(before["overview.events"]!);
    expect(renders["overview.speedTest"]).toBe(before["overview.speedTest"]);
    expect(renders["overview.health"]).toBe(before["overview.health"]);
    expect(seen["overview.speedTest"]!.at(-1)).toBe(speedSettings);
  });

  it("the localStorage copy is read once per load, not once per widget", async () => {
    const server = prefsServer(two);
    const first = renderWithProviders(<Probe />, { routes: server.routes });
    await waitFor(() => expect(out("status")).toHaveTextContent("ready"));
    first.unmount();
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    const slow = deferred<unknown>();
    const renders: Record<string, number> = {};
    renderWithProviders(
      <>
        <Loader />
        <Counted id="overview.events" renders={renders} seen={{}} />
        <Counted id="overview.speedTest" renders={renders} seen={{}} />
        <Counted id="overview.health" renders={renders} seen={{}} />
      </>,
      { routes: { "GET /api/v1/prefs": () => slow.promise } },
    );
    expect(out("overview.events status")).toHaveTextContent("loading");
    expect(getItem.mock.calls.filter(([k]) => k === PREFS_MIRROR_KEY)).toHaveLength(1);
    await act(async () => slow.resolve(structuredClone(server.state)));
    await waitFor(() => expect(out("overview.events status")).toHaveTextContent("ready"));
    expect(getItem.mock.calls.filter(([k]) => k === PREFS_MIRROR_KEY)).toHaveLength(1);
  });
});

describe("a save that fails", () => {
  for (const [what, reply, said] of [
    ["500", { status: 500, json: { error: { code: "internal", message: "Something broke (reference ab12)." } } }, "Something broke (reference ab12)."],
    ["NetworkError", { networkError: true }, "Cannot reach the dashboard"],
  ] as const) {
    it(`a failed save puts the page back and says so (${what})`, async () => {
      const server = prefsServer(saved);
      server.routes["PUT /api/v1/prefs/overview"] = reply;
      renderWithProviders(<Probe />, { routes: server.routes });
      await waitFor(() => expect(out("status")).toHaveTextContent("ready"));
      await userEvent.click(screen.getByRole("button", { name: "rows 7" }));
      await userEvent.click(screen.getByRole("button", { name: "hide" }));
      expect(out("rows")).toHaveTextContent("7");
      expect(await screen.findByText(`Couldn't save your Overview widgets: ${said}. Put back as it was.`.replace("..", "."))).toBeInTheDocument();
      expect(out("rows")).toHaveTextContent("9");
      expect(out("hidden")).toHaveTextContent("false");
    });
  }

  it("a 409 refetches and shows the other device's layout", async () => {
    const server = prefsServer(saved);
    renderWithProviders(<Probe />, { routes: server.routes });
    await waitFor(() => expect(out("status")).toHaveTextContent("ready"));
    // Another device saves first: the events widget hidden, version 2.
    server.state.pages.overview = { version: 2, updatedAt: "2026-10-02T12:05:00.000Z", prefs: { layout: { hidden: ["overview.events"] } } };
    await userEvent.click(screen.getByRole("button", { name: "rows 7" }));
    expect(await screen.findByText("Changed on another device. Showing the latest.")).toBeInTheDocument();
    await waitFor(() => expect(out("hidden")).toHaveTextContent("true"));
    expect(out("rows")).toHaveTextContent("5");
    expect(server.puts).toHaveLength(1);
  });

  it("a refetch landing between a change and its save does not let the save win: 409, the other device's change stays", async () => {
    const server = prefsServer(saved);
    const { client } = renderWithProviders(<Probe />, { routes: server.routes });
    await waitFor(() => expect(out("status")).toHaveTextContent("ready"));
    await userEvent.click(screen.getByRole("button", { name: "rows 7" }));
    // Another device saves while this change waits, and a refetch (window focus) brings its version here.
    server.state.pages.overview = { version: 2, updatedAt: "2026-10-02T12:05:00.000Z", prefs: { layout: { hidden: ["overview.events"] } } };
    await act(async () => {
      await client.refetchQueries({ queryKey: ["prefs"] });
    });
    expect(out("rows")).toHaveTextContent("7");
    await waitFor(() => expect(server.puts).toHaveLength(1));
    // The save names the version the change was made on, so the server refuses it.
    expect(server.puts[0]!.body.baseVersion).toBe(1);
    expect(await screen.findByText("Changed on another device. Showing the latest.")).toBeInTheDocument();
    await waitFor(() => expect(out("hidden")).toHaveTextContent("true"));
    expect(out("rows")).toHaveTextContent("5");
    expect(server.state.pages.overview).toMatchObject({ version: 2, prefs: { layout: { hidden: ["overview.events"] } } });
  });

  it("the store sends schema 2", async () => {
    const server = prefsServer(saved);
    renderWithProviders(<Probe />, { routes: server.routes });
    await waitFor(() => expect(out("status")).toHaveTextContent("ready"));
    await userEvent.click(screen.getByRole("button", { name: "hide" }));
    await waitFor(() => expect(server.puts).toHaveLength(1));
    expect(server.puts[0]!.body.schema).toBe(2);
    expect(server.state.pages.overview.version).toBe(2);
  });

  it("the fake server, like the Worker, answers a save without schema 2 with 409 outdated", () => {
    const server = prefsServer();
    const put = server.routes["PUT /api/v1/prefs/cost"] as (r: { body: unknown }) => { status?: number; json?: { error: { code: string; field: string } } };
    expect(put({ body: { baseVersion: 0, prefs: {} } })).toMatchObject({ status: 409, json: { error: { code: "outdated", field: "schema" } } });
    expect(server.state.pages.cost.version).toBe(0);
  });

  it("a 409 outdated from a missing schema says reload", async () => {
    const server = prefsServer(saved);
    server.routes["PUT /api/v1/prefs/overview"] = { status: 409, json: { error: { code: "outdated", message: "This tab is running an older dashboard. Reload to change widget settings.", field: "schema" } } };
    renderWithProviders(<Probe />, { routes: server.routes });
    await waitFor(() => expect(out("status")).toHaveTextContent("ready"));
    await userEvent.click(screen.getByRole("button", { name: "hide" }));
    expect(await screen.findByText("This tab is running an older dashboard. Reload to change widget settings.")).toBeInTheDocument();
    expect(out("hidden")).toHaveTextContent("false");
  });

  it("a 409 outdated says reload", async () => {
    const server = prefsServer(saved);
    server.routes["PUT /api/v1/prefs/overview"] = { status: 409, json: { error: { code: "outdated", message: "This tab is running an older dashboard. Reload to change widget settings.", field: "widgets.overview.events.v" } } };
    renderWithProviders(<Probe />, { routes: server.routes });
    await waitFor(() => expect(out("status")).toHaveTextContent("ready"));
    await userEvent.click(screen.getByRole("button", { name: "rows 7" }));
    expect(await screen.findByText("This tab is running an older dashboard. Reload to change widget settings.")).toBeInTheDocument();
    expect(out("rows")).toHaveTextContent("9");
  });
});
