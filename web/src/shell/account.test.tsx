import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { sessionFixture } from "@/test/fixtures";
import { initialsOf } from "./AccountMenu";

describe("initialsOf", () => {
  it("takes the first letters of the name parts of an email", () => {
    expect(initialsOf("ada.lovelace@example.com")).toBe("AL");
    expect(initialsOf("steven@example.com")).toBe("ST");
    expect(initialsOf("a_b-c@x.y")).toBe("AB");
    expect(initialsOf("")).toBe("");
  });
});

describe("account menu", () => {
  it("shows the signed-in email and initials from /session", async () => {
    renderApp("/");
    const trigger = await screen.findByRole("button", { name: /Account menu/ });
    await waitFor(() => expect(trigger).toHaveTextContent("dev@localhost"));
    expect(trigger).toHaveTextContent("DE");
  });

  it("opens from the keyboard and offers the theme toggle and Sign out through Access", async () => {
    const user = userEvent.setup();
    renderApp("/");
    const trigger = await screen.findByRole("button", { name: /Account menu/ });
    trigger.focus();
    await user.keyboard("{Enter}");
    const menu = await screen.findByRole("menu");
    const signOut = within(menu).getByRole("menuitem", { name: "Sign out" });
    expect(signOut).toHaveAttribute("href", "/cdn-cgi/access/logout");
    expect(within(menu).getByRole("menuitem", { name: /theme/i })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("switches the theme from the menu", async () => {
    const user = userEvent.setup();
    document.documentElement.setAttribute("data-theme", "dark");
    renderApp("/");
    const trigger = await screen.findByRole("button", { name: /Account menu/ });
    await user.click(trigger);
    await user.click(await screen.findByRole("menuitem", { name: "Switch to light theme" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    document.documentElement.removeAttribute("data-theme");
  });
});

describe("unread watchman notes", () => {
  const note = (id: number) => ({ id, at: "2026-10-02T10:00:00.000Z", kind: "warn", message: "n" + id, run_id: null, acknowledged: 0 });

  it("shows nothing when there are no unread notes", async () => {
    renderApp("/");
    await screen.findByRole("button", { name: /Account menu/ });
    expect(screen.queryByRole("link", { name: /unread/i })).toBeNull();
  });

  it("shows the count, links to the notes, and marks them read when opened", async () => {
    const user = userEvent.setup();
    const r = renderApp("/", { routes: { "GET /api/v1/session": sessionFixture({ notes: [note(1), note(2)] }), "POST /api/v1/notes/ack": { ok: true, message: "Notes marked as read." } } });
    const link = await screen.findByRole("link", { name: "2 unread watchman notes" });
    expect(link).toHaveTextContent("2");
    await user.click(link);
    expect(screen.getByLabelText("location")).toHaveTextContent("/activity?tab=notes");
    expect(r.fetchMock!.callsTo("POST", "/api/v1/notes/ack")).toHaveLength(1);
  });

  it("uses the singular for one note", async () => {
    renderApp("/", { routes: { "GET /api/v1/session": sessionFixture({ notes: [note(1)] }) } });
    expect(await screen.findByRole("link", { name: "1 unread watchman note" })).toBeInTheDocument();
  });
});
