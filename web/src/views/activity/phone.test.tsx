import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { setViewport } from "@/test/viewport";
import { activityRoutes, emptyActivity } from "./testkit";

vi.setConfig({ testTimeout: 20_000 });

describe("Activity on the phone", () => {
  it("phone shows last run and last note", async () => {
    setViewport("phone");
    renderApp("/activity", { routes: activityRoutes() });
    const run = await screen.findByRole("region", { name: "Last run" });
    expect(run).toHaveTextContent("Deploy");
    expect(run).toHaveTextContent("Running");
    const note = screen.getByRole("region", { name: "Last note" });
    expect(note).toHaveTextContent("drift");
    expect(note).toHaveTextContent("Firewall rules differ from the VM");
    // The desktop panels are not there.
    expect(screen.queryByRole("application", { name: /Activity timeline/ })).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("the Runs button lists runs in a sheet and a run opens its sheet", async () => {
    setViewport("phone");
    renderApp("/activity", { routes: activityRoutes() });
    await screen.findByRole("region", { name: "Last run" });
    await userEvent.click(screen.getByRole("button", { name: "Runs" }));
    const sheet = await screen.findByRole("dialog", { name: "Runs" });
    expect(within(sheet).getAllByRole("listitem")).toHaveLength(4);
    await userEvent.click(within(sheet).getByRole("button", { name: /Deploy.*Success/ }));
    await waitFor(() => expect(document.querySelector<HTMLElement>('output[aria-label="location"]')!).toHaveTextContent("/activity/runs/run-2"));
    expect(await screen.findByRole("dialog", { name: /run/i })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Runs" })).toBeNull();
  });

  it("the Notes and Changes buttons open their lists", async () => {
    setViewport("phone");
    renderApp("/activity", { routes: activityRoutes() });
    await screen.findByRole("region", { name: "Last run" });
    await userEvent.click(screen.getByRole("button", { name: "Notes" }));
    const notes = await screen.findByRole("dialog", { name: "Watchman notes" });
    expect(within(notes).getAllByRole("listitem")).toHaveLength(2);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await userEvent.click(screen.getByRole("button", { name: "Changes" }));
    const changes = await screen.findByRole("dialog", { name: "Config changes" });
    expect(within(changes).getAllByRole("listitem")).toHaveLength(2);
  });

  it("with nothing yet says so instead of showing blanks", async () => {
    setViewport("phone");
    renderApp("/activity", { routes: activityRoutes({ "GET /api/v1/activity": emptyActivity() }) });
    expect(await screen.findByText("No runs yet")).toBeInTheDocument();
    expect(screen.getByText("No notes yet")).toBeInTheDocument();
  });
});
