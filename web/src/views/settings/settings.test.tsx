import "./slow";
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider, useLocation, useNavigate } from "react-router-dom";
import { renderApp, testQueryClient } from "@/test/render";
import { mockFetch } from "@/test/mockFetch";
import { defaultRoutes } from "@/test/fixtures";
import { ToastProvider } from "@/components/feedback/Toast";
import { SettingsPage } from "./index";
import { routesFor, settingsFixture } from "./testkit";

const loc = () => screen.getByLabelText("location");
const tab = (name: string | RegExp) => screen.findByRole("tab", { name });

/** SettingsPage alone in a router with a Back button, to prove the URL is the source of truth. */
function withBack(url: string) {
  mockFetch({ ...defaultRoutes(), ...routesFor() });
  function Back() {
    const nav = useNavigate();
    const l = useLocation();
    return (
      <>
        <button onClick={() => nav(-1)}>Back</button>
        <output aria-label="where">{l.pathname}</output>
      </>
    );
  }
  const router = createMemoryRouter(
    [
      {
        path: "/settings/:section?",
        element: (
          <>
            <SettingsPage />
            <Back />
          </>
        ),
      },
    ],
    { initialEntries: ["/settings/overview", url], initialIndex: 1 },
  );
  render(
    <QueryClientProvider client={testQueryClient()}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("Settings sections", () => {
  it("tabs follow /settings/:section and Back restores the section", async () => {
    const user = userEvent.setup();
    withBack("/settings/deployment");
    expect(await tab("Deployment")).toHaveAttribute("aria-selected", "true");
    await user.click(await tab("Security"));
    expect(screen.getByLabelText("where")).toHaveTextContent("/settings/security");
    expect(await tab("Security")).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByLabelText("where")).toHaveTextContent("/settings/deployment");
    expect(await tab("Deployment")).toHaveAttribute("aria-selected", "true");
    // The seven sections, in the palette's order.
    const names = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(names).toEqual(["Overview", "Deployment", "Automation", "Security", "Backup & Recovery", "Mobile", "Labs", "Maintenance"]);
  });

  it("an unknown section falls back to overview", async () => {
    renderApp("/settings/nonsense", { routes: routesFor() });
    expect(await tab("Overview")).toHaveAttribute("aria-selected", "true");
    expect(loc()).toHaveTextContent("/settings/overview");
  });

  it("editing marks the section dirty; Discard restores; Save sends only changed keys", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderApp("/settings/automation", { routes: { ...routesFor(), "PUT /api/v1/settings": { ok: true, message: "Settings saved." } } });
    const idle = await screen.findByLabelText(/Idle limit/);
    expect(idle).toHaveValue("0");
    expect(screen.queryByRole("region", { name: "Unsaved changes" })).toBeNull();

    await user.clear(idle);
    await user.type(idle, "15");
    const bar = screen.getByRole("region", { name: "Unsaved changes" });
    expect(await tab(/unsaved changes in Automation/i)).toBeInTheDocument();

    await user.click(within(bar).getByRole("button", { name: "Discard" }));
    expect(screen.getByLabelText(/Idle limit/)).toHaveValue("0");
    expect(screen.queryByRole("region", { name: "Unsaved changes" })).toBeNull();

    await user.clear(screen.getByLabelText(/Idle limit/));
    await user.type(screen.getByLabelText(/Idle limit/), "15");
    await user.click(within(screen.getByRole("region", { name: "Unsaved changes" })).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetchMock!.callsTo("PUT", "/api/v1/settings")).toHaveLength(1));
    expect(fetchMock!.callsTo("PUT", "/api/v1/settings")[0]!.body).toEqual({ idle_destroy_minutes: "15" });
  });

  it("shows the server's message at the field and keeps what was typed", async () => {
    const user = userEvent.setup();
    renderApp("/settings/automation", {
      routes: { ...routesFor(), "PUT /api/v1/settings": { status: 400, json: { error: { code: "bad_input", message: "idle_destroy_minutes did not look right.", field: "idle_destroy_minutes" } } } },
    });
    const idle = await screen.findByLabelText(/Idle limit/);
    await user.clear(idle);
    await user.type(idle, "99999");
    await user.click(within(screen.getByRole("region", { name: "Unsaved changes" })).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("idle_destroy_minutes did not look right.")).toBeInTheDocument();
    expect(screen.getByLabelText(/Idle limit/)).toHaveValue("99999");
  });

  it("a switch on Deployment saves just that key", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderApp("/settings/deployment", { routes: { ...routesFor(), "PUT /api/v1/settings": { ok: true, message: "Settings saved." } } });
    await user.click(await screen.findByRole("switch", { name: /Test VM/ }));
    await user.click(within(screen.getByRole("region", { name: "Unsaved changes" })).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetchMock!.callsTo("PUT", "/api/v1/settings")).toHaveLength(1));
    expect(fetchMock!.callsTo("PUT", "/api/v1/settings")[0]!.body).toEqual({ test_vm: true });
  });

  it("leaving a dirty section asks first, in the page, not with confirm()", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm");
    renderApp("/settings/automation", { routes: routesFor() });
    const idle = await screen.findByLabelText(/Idle limit/);
    await user.clear(idle);
    await user.type(idle, "15");

    await user.click(await tab(/Security/));
    const ask = await screen.findByRole("dialog", { name: /Leave without saving/i });
    expect(loc()).toHaveTextContent("/settings/automation");

    await user.click(within(ask).getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByLabelText(/Idle limit/)).toHaveValue("15");

    await user.click(await tab(/Security/));
    await user.click(within(await screen.findByRole("dialog", { name: /Leave without saving/i })).getByRole("button", { name: "Discard and leave" }));
    expect(loc()).toHaveTextContent("/settings/security");
    await user.click(await tab(/Automation/));
    expect(await screen.findByLabelText(/Idle limit/)).toHaveValue("0");
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("unsaved edits: the top nav's Overview link asks first; Keep editing stays, Discard and leave goes", async () => {
    const user = userEvent.setup();
    renderApp("/settings/automation", { routes: routesFor() });
    const idle = await screen.findByLabelText(/Idle limit/);
    await user.clear(idle);
    await user.type(idle, "15");
    const main = screen.getByRole("navigation", { name: "Main" });

    await user.click(within(main).getByRole("link", { name: "Overview" }));
    const ask = await screen.findByRole("dialog", { name: /Leave without saving/i });
    expect(loc()).toHaveTextContent("/settings/automation");
    await user.click(within(ask).getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(loc()).toHaveTextContent("/settings/automation");
    expect(screen.getByLabelText(/Idle limit/)).toHaveValue("15");

    await user.click(within(main).getByRole("link", { name: "Overview" }));
    await user.click(within(await screen.findByRole("dialog", { name: /Leave without saving/i })).getByRole("button", { name: "Discard and leave" }));
    await waitFor(() => expect(loc()).toHaveTextContent(/^\/$/));
  });

  it("unsaved edits: the command palette asks before it navigates", async () => {
    const user = userEvent.setup();
    renderApp("/settings/automation", { routes: routesFor() });
    const idle = await screen.findByLabelText(/Idle limit/);
    await user.clear(idle);
    await user.type(idle, "15");
    await user.keyboard("{Control>}k{/Control}");
    const palette = await screen.findByRole("dialog", { name: /command/i });
    await user.type(within(palette).getByRole("combobox"), "Cost");
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog", { name: /Leave without saving/i })).toBeInTheDocument();
    expect(loc()).toHaveTextContent("/settings/automation");
  });

  it("the header shows the estimated cost per day, marked as an estimate", async () => {
    renderApp("/settings", { routes: { ...routesFor(settingsFixture()) } });
    // 0.0157 x 24 = 0.3768
    const cost = await screen.findByRole("group", { name: /estimated cost per day/i });
    expect(within(cost).getByText("£0.38")).toBeInTheDocument();
    expect(within(cost).getByText("Estimated cost")).toBeInTheDocument();
  });
});
