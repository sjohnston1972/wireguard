// labs.test.tsx
//
// Plain English: a client whose "Azure route" switch predates the lab pool
// (10.64.0.0/13) is flagged once, in the table and in its panel, until its
// config is fetched (Labs spec section 7.6).
import "./testSetup";
import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { clientList, clientRoutes } from "./testData";

const FLAG = "config out of date: get config";
const flagged = () => clientList().map((c) => (c.id === 3 ? { ...c, azure_vnet: 1, labsConfigDue: true } : c));
const rowFor = (t: HTMLElement, name: string) => within(t).getByText(name).closest("tr") as HTMLElement;

describe("Clients: config out of date for the labs", () => {
  it("a client with labsConfigDue says config out of date: get config", async () => {
    renderApp("/clients", { routes: clientRoutes({ clients: flagged() }) });
    const t = await screen.findByRole("table", { name: "Clients" });
    expect(within(rowFor(t, "laptop")).getByText(FLAG)).toBeInTheDocument();
    // Only that client, and the key-change tag is a different one.
    expect(within(t).getAllByText(FLAG)).toHaveLength(1);
    expect(within(rowFor(t, "build-server")).getByText("needs new config")).toBeInTheDocument();
  });

  it("no client is flagged when none is due", async () => {
    renderApp("/clients", { routes: clientRoutes() });
    const t = await screen.findByRole("table", { name: "Clients" });
    expect(within(t).queryByText(FLAG)).toBeNull();
  });

  it("its panel says why and offers Get new config", async () => {
    const user = userEvent.setup();
    renderApp("/clients/3", { routes: clientRoutes({ clients: flagged() }) });
    const p = await screen.findByRole("complementary", { name: "laptop" });
    const note = await within(p).findByRole("note", { name: "Config out of date" });
    expect(note).toHaveTextContent("does not include the labs network (10.64.0.0/13)");
    await user.click(within(note).getByRole("button", { name: "Get new config" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("the panel of an up-to-date client has no such note", async () => {
    renderApp("/clients/3", { routes: clientRoutes() });
    const p = await screen.findByRole("complementary", { name: "laptop" });
    expect(within(p).queryByRole("note", { name: "Config out of date" })).toBeNull();
  });
});
