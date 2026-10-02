import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";

const TABS = ["Overview", "Clients", "Firewall", "Activity", "Cost", "Settings"];

describe("AppShell", () => {
  it("shows the six tabs in order in the main navigation", () => {
    renderApp("/");
    const nav = screen.getByRole("navigation", { name: "Main" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(TABS);
  });

  it("shows the wordmark and a banner landmark", () => {
    renderApp("/");
    expect(screen.getByRole("banner")).toHaveTextContent("wg-admin");
  });

  it.each([
    ["/", "Overview"],
    ["/clients", "Clients"],
    ["/clients/abc", "Clients"],
    ["/firewall", "Firewall"],
    ["/firewall/rules/7", "Firewall"],
    ["/activity", "Activity"],
    ["/activity/runs/12", "Activity"],
    ["/settings", "Settings"],
    ["/settings/profiles", "Settings"],
  ])("marks exactly the right tab as current at %s", (url, current) => {
    renderApp(url);
    const nav = screen.getByRole("navigation", { name: "Main" });
    const marked = within(nav).getAllByRole("link", { current: "page" });
    expect(marked.map((l) => l.textContent)).toEqual([current]);
  });

  it("marks the same tab in the phone tab bar", () => {
    renderApp("/firewall");
    const bar = screen.getByRole("navigation", { name: "Phone" });
    const marked = within(bar).getAllByRole("link", { current: "page" });
    expect(marked.map((l) => l.textContent)).toEqual(["Firewall"]);
  });

  it("renders a placeholder page with its title inside the shell", () => {
    renderApp("/nowhere");
    const main = screen.getByRole("main");
    expect(within(main).getByRole("heading", { level: 1, name: "Not found" })).toBeInTheDocument();
    expect(main).toHaveTextContent("Built in plan 4");
  });

  it.each([
    ["/activity/runs/12", "Run 12"],
    ["/settings/profiles", "Settings"],
  ])("has a placeholder for the detail route %s", (url, title) => {
    renderApp(url);
    expect(within(screen.getByRole("main")).getByRole("heading", { level: 1, name: title })).toBeInTheDocument();
  });

  it("lets a keyboard user tab through every tab and activate one with Enter", async () => {
    const user = userEvent.setup();
    renderApp("/");
    const nav = screen.getByRole("navigation", { name: "Main" });
    const links = within(nav).getAllByRole("link");

    await user.tab();
    // Skip link first, then the wordmark link, then the tabs.
    let guard = 0;
    while (document.activeElement !== links[0] && guard++ < 10) await user.tab();
    expect(links[0]).toHaveFocus();
    for (const link of links.slice(1)) {
      await user.tab();
      expect(link).toHaveFocus();
    }

    await user.keyboard("{Enter}");
    expect(within(nav).getByRole("link", { current: "page" })).toHaveTextContent("Settings");
  });

  it("offers a skip link that targets the main region", () => {
    renderApp("/");
    const skip = screen.getByRole("link", { name: "Skip to content" });
    expect(skip).toHaveAttribute("href", "#main");
    expect(screen.getByRole("main")).toHaveAttribute("id", "main");
  });
});
