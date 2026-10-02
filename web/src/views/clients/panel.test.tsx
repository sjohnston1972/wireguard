import "./testSetup";
import { describe, expect, it } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { renderRouted } from "./testRender";
import { clientList, clientRoutes } from "./testData";

const location = () => screen.getByRole("status", { name: "location" });
const panel = (name: string) => screen.findByRole("complementary", { name });

describe("Client panel", { timeout: 20_000 }, () => {
  it("opening a row sets /clients/:id and Back closes the panel", async () => {
    const user = userEvent.setup();
    const { router } = renderRouted("/clients", clientRoutes());
    const table = await screen.findByRole("table", { name: "Clients" });
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();

    await user.click(within(table).getByText("laptop"));
    expect(location()).toHaveTextContent("/clients/3");
    const p = await panel("laptop");
    expect(within(p).getAllByText(/10\.13\.13\.4/).length).toBeGreaterThan(0);
    expect(within(p).getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");

    await act(() => router.navigate(-1));
    expect(location()).toHaveTextContent(/^\/clients$/);
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();

    // The close button returns to the list as well.
    await user.click(within(table).getByText("phone"));
    const p2 = await panel("phone");
    await user.click(within(p2).getByRole("button", { name: "Close" }));
    expect(location()).toHaveTextContent(/^\/clients$/);
  });

  it("route toggles send PUT with only the changed field", async () => {
    const user = userEvent.setup();
    const laptop = clientList().find((c) => c.id === 3)!;
    const { fetchMock } = renderApp("/clients/3", {
      routes: { ...clientRoutes(), "PUT /api/v1/clients/3": { peer: { ...laptop, tunnel_dns: 1 } } },
    });
    const p = await panel("laptop");
    await user.click(within(p).getByRole("tab", { name: "Configuration" }));

    const home = within(p).getByRole("switch", { name: /Home LAN/ });
    const vnet = within(p).getByRole("switch", { name: /Azure VNet/ });
    const dns = within(p).getByRole("switch", { name: /Tunnel DNS/ });
    expect(home).toHaveAttribute("aria-checked", "true");
    expect(vnet).toHaveAttribute("aria-checked", "true");
    expect(dns).toHaveAttribute("aria-checked", "false");

    await user.click(dns);
    await waitFor(() => expect(fetchMock!.callsTo("PUT", "/api/v1/clients/3")).toHaveLength(1));
    expect(fetchMock!.callsTo("PUT", "/api/v1/clients/3")[0]!.body).toEqual({ tunnel_dns: true });

    await user.click(home);
    await waitFor(() => expect(fetchMock!.callsTo("PUT", "/api/v1/clients/3")).toHaveLength(2));
    expect(fetchMock!.callsTo("PUT", "/api/v1/clients/3")[1]!.body).toEqual({ home_lan: false });
  });

  it("the home site offers enable/disable only", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderApp("/clients/1", {
      routes: { ...clientRoutes(), "PUT /api/v1/clients/1": { peer: { ...clientList()[0], enabled: 0 } } },
    });
    const p = await panel("home-site");
    expect(within(p).queryByRole("button", { name: /Get new config/ })).not.toBeInTheDocument();
    expect(within(p).queryByRole("button", { name: /Delete/ })).not.toBeInTheDocument();

    await user.click(within(p).getByRole("tab", { name: "Configuration" }));
    expect(within(p).queryByRole("switch", { name: /Home LAN|Azure VNet|Tunnel DNS/ })).not.toBeInTheDocument();
    expect(within(p).queryByRole("combobox", { name: /Expiry/ })).not.toBeInTheDocument();
    expect(within(p).getByText(/npm run home/)).toBeInTheDocument();

    await user.click(within(p).getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(fetchMock!.callsTo("PUT", "/api/v1/clients/1")).toHaveLength(1));
    expect(fetchMock!.callsTo("PUT", "/api/v1/clients/1")[0]!.body).toEqual({ enabled: false });

    // The row menu offers the same: no re-key and no delete.
    const table = screen.getByRole("table", { name: "Clients" });
    await user.click(within(table).getByRole("button", { name: "Actions for home-site" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).queryByRole("menuitem", { name: /Get new config|Delete/ })).not.toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Disable" })).toBeInTheDocument();
  });

  it("Delete needs the typed name", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderApp("/clients/3", {
      routes: { ...clientRoutes(), "DELETE /api/v1/clients/3": { ok: true, message: "Deleted laptop." } },
    });
    const p = await panel("laptop");
    await user.click(within(p).getByRole("button", { name: "Delete" }));

    const dialog = await screen.findByRole("dialog", { name: /Delete laptop/ });
    const confirm = within(dialog).getByRole("button", { name: "Delete client" });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Type laptop to confirm"), "lapto");
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Type laptop to confirm"), "p");
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    await waitFor(() => expect(fetchMock!.callsTo("DELETE", "/api/v1/clients/3")).toHaveLength(1));
    await waitFor(() => expect(location()).toHaveTextContent(/^\/clients$/));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
