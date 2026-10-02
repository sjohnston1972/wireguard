import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderApp } from "@/test/render";
import { setViewport } from "@/test/viewport";
import { draftData, firewallData } from "./testData";

vi.setConfig({ testTimeout: 20_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("firewall on the phone", () => {
  it("phone pins the draft bar and opens rules in sheets", async () => {
    setViewport("phone");
    renderApp("/firewall", { routes: { "GET /api/v1/firewall": firewallData({ draft: draftData() }) } });
    const lights = await screen.findByRole("list", { name: "Firewall at a glance" });
    expect(lights).toHaveTextContent(/Applied.*Active/);
    expect(lights).toHaveTextContent(/Rules.*4 of 6 on/);
    expect(lights).toHaveTextContent(/Recent drops.*342/);
    expect(lights).toHaveTextContent(/Default.*Deny/);
    // No desktop table on the phone: one line per rule instead.
    expect(screen.queryByRole("table")).toBeNull();
    const bar = screen.getByRole("region", { name: "Unpublished changes" });
    expect(bar).toHaveTextContent("2 unpublished changes");
    expect(bar).toHaveAttribute("data-pinned", "bottom");

    fireEvent.click(screen.getByRole("button", { name: /Web to the test server/ }));
    const sheet = await screen.findByRole("dialog", { name: "Web to the test server" });
    expect(sheet).toHaveAttribute("data-side", "bottom");
    fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), { timeout: 5000 });

    fireEvent.click(screen.getByRole("button", { name: "Drops" }));
    const drops = await screen.findByRole("dialog", { name: "Recent drops" });
    expect(drops).toHaveAttribute("data-side", "bottom");
    expect(within(drops).getByRole("button", { name: /Allow TCP 8080/ })).toBeInTheDocument();
  });

  it("without a draft the phone has no draft bar", async () => {
    setViewport("phone");
    renderApp("/firewall", { routes: { "GET /api/v1/firewall": firewallData() } });
    await screen.findByRole("list", { name: "Firewall at a glance" });
    expect(screen.queryByRole("region", { name: "Unpublished changes" })).toBeNull();
  });
});
