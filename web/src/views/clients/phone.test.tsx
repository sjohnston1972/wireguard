import "./testSetup";
import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { setViewport } from "@/test/viewport";
import { clientRoutes } from "./testData";

describe("Clients on the phone", { timeout: 20_000 }, () => {
  it("phone rows open a sheet", async () => {
    setViewport("phone");
    const user = userEvent.setup();
    renderApp("/clients", { routes: clientRoutes() });
    const list = await screen.findByRole("list", { name: "Clients" });
    expect(screen.queryByRole("table")).not.toBeInTheDocument();

    // One line per device: a light, the name, the latency or the state.
    const phone = within(list).getByRole("button", { name: /^phone/ });
    expect(phone).toHaveTextContent("32 ms");
    expect(within(list).getByRole("button", { name: /^laptop/ })).toHaveTextContent("Offline");
    expect(within(list).getByRole("button", { name: /^build-server/ })).toHaveTextContent("Loading onto VM");

    await user.click(phone);
    const sheet = await screen.findByRole("dialog", { name: "phone" });
    expect(sheet).toHaveAttribute("data-side", "bottom");
    expect(within(sheet).getByRole("tab", { name: "Overview" })).toBeInTheDocument();
    expect(within(sheet).getByRole("tab", { name: "Configuration" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "location", hidden: true })).toHaveTextContent("/clients/2");
  });

  it("Add a client opens the wizard as a sheet", async () => {
    setViewport("phone");
    const user = userEvent.setup();
    renderApp("/clients", { routes: clientRoutes() });
    await screen.findByRole("list", { name: "Clients" });
    await user.click(screen.getByRole("button", { name: "Add client" }));
    const sheet = await screen.findByRole("dialog", { name: "Add client" });
    expect(sheet).toHaveAttribute("data-side", "bottom");
  });
});
