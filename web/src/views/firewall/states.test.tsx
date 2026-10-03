import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderApp } from "@/test/render";
import { firewallData } from "./testData";

vi.setConfig({ testTimeout: 20_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("firewall states", () => {
  it("shows a skeleton shaped like the page while loading", async () => {
    renderApp("/firewall", { routes: { "GET /api/v1/firewall": () => new Promise(() => {}) } });
    const loading = await screen.findByRole("status", { name: "Loading the firewall" });
    expect(loading.querySelectorAll(".skeleton--tile")).toHaveLength(5);
    expect(within(loading).getByTestId("rules-skeleton").querySelectorAll(".skeleton--row").length).toBeGreaterThan(3);
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("shows the API's message on a 500 and Retry loads the page", async () => {
    let calls = 0;
    renderApp("/firewall", {
      routes: {
        "GET /api/v1/firewall": () => (++calls === 1 ? { status: 500, json: { error: { code: "internal", message: "The database is not answering." } } } : firewallData()),
      },
    });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The database is not answering.");
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("table", { name: "Firewall rules" })).toBeInTheDocument();
    expect(calls).toBe(2);
  });

  it("with no rules says so and offers Add rule; no drops says so too", async () => {
    renderApp("/firewall", {
      routes: { "GET /api/v1/firewall": firewallData({ rules: [], drops: { recent: [], last24h: 0, uniqueSources24h: 0, previous24h: 0, hourly24h: [] } }) },
    });
    const rules = await screen.findByRole("region", { name: "Firewall rules" });
    expect(rules).toHaveTextContent("No rules yet");
    expect(rules).toHaveTextContent("Every flow follows the default action (deny)");
    // The default action still shows, last and alone.
    expect(within(rules).getByRole("table", { name: "Firewall rules" })).toHaveTextContent("Default (catch all)");
    const drops = screen.getByRole("region", { name: "Recent drops" });
    expect(drops).toHaveTextContent("No recent drops");
    fireEvent.click(within(rules).getAllByRole("button", { name: "Add rule" })[0]);
    expect(await screen.findByRole("dialog", { name: "Add rule" })).toBeInTheDocument();
  });

  it("the shared fixture's rules render with the default row last", async () => {
    renderApp("/firewall"); // default routes: firewallFixture()
    const table = await screen.findByRole("table", { name: "Firewall rules" });
    expect(table).toHaveTextContent("Block telemetry");
    expect(table).toHaveTextContent("Default (catch all)");
  });

  it("when the VM is not running the policy says so and capture explains why it cannot start", async () => {
    renderApp("/firewall", {
      routes: {
        "GET /api/v1/firewall": firewallData({ running: false, policy: { hash: "abc", state: "not_running", text: "Not running: this rule set is loaded at the next deploy or resume." } }),
      },
    });
    await screen.findByRole("table", { name: "Firewall rules" });
    expect(screen.getByRole("status", { name: "Policy status" })).toHaveTextContent("Not running");
    const capture = screen.getByRole("region", { name: "Packet capture" });
    expect(within(capture).getByRole("button", { name: "Start capture" })).toBeDisabled();
    expect(capture).toHaveTextContent("The VM is not running.");
    await waitFor(() => expect(screen.getByRole("group", { name: "Packet capture" })).toHaveTextContent("Unavailable"));
  });
});
