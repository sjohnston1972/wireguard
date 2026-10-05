// Plan L3.6: the phone's own composition of the Labs tab (spec §10, Phone).
import { beforeAll, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { setViewport } from "@/test/viewport";
import { expectBottomSheet } from "@/test/dialogs";
import { labCoverageFixture } from "@/test/fixtures";
import { detailIdle, labs, session } from "./testData";

vi.setConfig({ testTimeout: 20_000 });
beforeAll(async () => {
  await import("@/views/labs");
});

const routes = () => ({
  "GET /api/v1/labs": labs({ running: [session({ labId: "az104-01-identity", title: "Users, groups and a custom role", id: "ls-1" })] }),
  "GET /api/v1/labs/az104-06-blob-security": detailIdle(),
  "GET /api/v1/labs/sessions": { sessions: [session({ labId: "az104-01-identity", title: "Users, groups and a custom role", id: "ls-1" })] },
  "GET /api/v1/labs/coverage": labCoverageFixture(),
});

describe("Labs on the phone", () => {
  it("phone: running labs with lights, time left, Extend and Tear down; Catalogue and Your labs open sheets; a lab opens as a sheet with Deploy", async () => {
    const user = userEvent.setup();
    setViewport("phone");
    renderApp("/labs", { routes: routes() });
    expect(await within(screen.getByRole("main")).findByRole("heading", { level: 1, name: "Labs" })).toBeInTheDocument();

    // One screen: the running labs, each with its light (a coloured word), time left, Extend and Tear down.
    const running = within(await screen.findByRole("region", { name: "Running labs" }));
    const item = within(running.getByRole("listitem"));
    expect(item.getByText("Running")).toHaveClass("labs-word--green");
    await waitFor(() => expect(item.getByText("1 h 15 min left")).toBeInTheDocument());
    expect(item.getByRole("button", { name: "Extend" })).toBeInTheDocument();
    expect(item.getByRole("button", { name: "Tear down" })).toBeInTheDocument();
    // The catalogue and history are a tap away, not on the page.
    expect(screen.queryByRole("region", { name: "Catalogue" })).toBeNull();
    expect(screen.queryByRole("table", { name: "Sessions" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Your labs" }));
    let sheet = await screen.findByRole("dialog", { name: "Your labs" });
    expectBottomSheet(sheet);
    expect(within(sheet).getByRole("table", { name: "Sessions" })).toBeInTheDocument();
    expect(within(sheet).getByRole("region", { name: "Coverage" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(screen.getByRole("button", { name: "Catalogue" }));
    sheet = await screen.findByRole("dialog", { name: "Catalogue" });
    expectBottomSheet(sheet);
    await user.click(within(sheet).getByRole("link", { name: /Blob security/ }));

    const lab = await screen.findByRole("dialog", { name: /Blob security/ });
    expectBottomSheet(lab);
    expect(within(lab).getByRole("button", { name: "Deploy" })).toBeEnabled();
    expect(screen.queryByRole("dialog", { name: "Catalogue" })).toBeNull();
  });

  it("nothing running says so", async () => {
    setViewport("phone");
    renderApp("/labs", { routes: { ...routes(), "GET /api/v1/labs": labs() } });
    expect(await screen.findByText("No labs running.")).toBeInTheDocument();
  });

  it("/labs/history opens Your labs on the phone", async () => {
    setViewport("phone");
    renderApp("/labs/history", { routes: routes() });
    const sheet = await screen.findByRole("dialog", { name: "Your labs" });
    expectBottomSheet(sheet);
  });
});
