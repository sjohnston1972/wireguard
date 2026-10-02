import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";

// Whole-app journeys through the palette (about 5 s under a full parallel run; the
// nine-action walk below has its own, longer limit).
vi.setConfig({ testTimeout: 15_000 });

const loc = () => screen.getByLabelText("location");

async function openPalette(user: ReturnType<typeof userEvent.setup>) {
  await user.keyboard("{Control>}k{/Control}");
  return screen.findByRole("dialog", { name: "Command palette" });
}

describe("command palette", () => {
  it("opens with Ctrl+K and closes with Escape, restoring focus", async () => {
    const user = userEvent.setup();
    renderApp("/");
    expect(screen.queryByRole("dialog")).toBeNull();
    const dialog = await openPalette(user);
    expect(within(dialog).getByRole("combobox")).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("opens with Cmd+K and from the search button (the phone's search icon)", async () => {
    const user = userEvent.setup();
    renderApp("/");
    await user.keyboard("{Meta>}k{/Meta}");
    expect(await screen.findByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
  });

  it("lists the six tabs and every Settings section", async () => {
    const user = userEvent.setup();
    renderApp("/");
    const dialog = await openPalette(user);
    for (const t of ["Overview", "Clients", "Firewall", "Activity", "Cost", "Settings"]) expect(within(dialog).getByRole("option", { name: `Go to ${t}` })).toBeInTheDocument();
    for (const s of ["Overview", "Deployment", "Automation", "Security", "Backup & Recovery", "Mobile", "Maintenance"]) expect(within(dialog).getByRole("option", { name: `Settings: ${s}` })).toBeInTheDocument();
  });

  it("finds a client by name and goes to it with the keyboard", async () => {
    const user = userEvent.setup();
    renderApp("/");
    const dialog = await openPalette(user);
    await user.type(within(dialog).getByRole("combobox"), "test-phone");
    const opt = await within(dialog).findByRole("option", { name: /test-phone/ });
    expect(opt).toHaveTextContent("10.13.13.2");
    await user.keyboard("{Enter}");
    expect(loc()).toHaveTextContent("/clients/1");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("finds a client by IP", async () => {
    const user = userEvent.setup();
    renderApp("/");
    const dialog = await openPalette(user);
    await user.type(within(dialog).getByRole("combobox"), "10.13.13.3");
    await within(dialog).findByRole("option", { name: /Home site/ });
    // The fuzzy search may keep weaker matches, but the exact IP ranks first.
    await waitFor(() => expect(within(dialog).getAllByRole("option")[0]).toHaveTextContent("Home site"));
  });

  it("finds a firewall rule by name and the latest run", async () => {
    const user = userEvent.setup();
    renderApp("/");
    const dialog = await openPalette(user);
    await user.type(within(dialog).getByRole("combobox"), "telemetry");
    await user.click(await within(dialog).findByRole("option", { name: /Block telemetry/ }));
    expect(loc()).toHaveTextContent("/firewall/rules/8");

    await openPalette(user);
    await user.type(within(screen.getByRole("dialog")).getByRole("combobox"), "latest run");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(loc()).toHaveTextContent("/activity/runs/run-42"));
  });

  it("actions only navigate to the view with an action parameter", async () => {
    const user = userEvent.setup();
    const r = renderApp("/cost");
    const cases: [string, string][] = [
      ["Deploy", "/?action=deploy"],
      ["Tear down", "/?action=destroy"],
      ["Hibernate", "/?action=hibernate"],
      ["Resume", "/?action=resume"],
      ["Extend", "/?action=extend"],
      ["Speed test", "/?action=speedtest"],
      ["Add client", "/clients?action=add"],
      ["Add firewall rule", "/firewall?action=add-rule"],
      ["Start capture", "/firewall?action=capture"],
    ];
    for (const [name, to] of cases) {
      const dialog = await openPalette(user);
      await user.click(within(dialog).getByRole("option", { name: new RegExp(`^${name}`) }));
      await waitFor(() => expect(loc()).toHaveTextContent(to));
    }
    expect(r.fetchMock!.calls.filter((c) => c.method !== "GET")).toEqual([]);
  }, 30_000);

  it("navigates with arrow keys and Enter", async () => {
    const user = userEvent.setup();
    renderApp("/");
    const dialog = await openPalette(user);
    await user.type(within(dialog).getByRole("combobox"), "go to");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(loc()).not.toHaveTextContent(/^\/$/);
  });
});
