import { describe, expect, it } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { overviewFixture, prefsFixture, sessionFixture } from "@/test/fixtures";
import { formatRemaining } from "./StateChip";

// The top bar is the first banner: testing-library also counts the Overview's panel headers (a <header> inside <section>) as banners.
const banner = () => screen.getAllByRole("banner")[0];
const escape = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The chip says this state sentence (its accessible name; on screen it reads "Azure • UK South"). */
const stateSays = (text: string) =>
  waitFor(() => expect(within(banner()).getByRole("button", { name: /State:/ })).toHaveAccessibleName(new RegExp(`State: ${escape(text)}\\.`)));

describe("formatRemaining", () => {
  it("words a duration in hours and minutes", () => {
    expect(formatRemaining(3 * 3600_000 + 12 * 60_000)).toBe("3h 12m");
    expect(formatRemaining(45 * 60_000)).toBe("45m");
    expect(formatRemaining(2 * 3600_000)).toBe("2h");
    expect(formatRemaining(20_000)).toBe("under a minute");
    expect(formatRemaining(26 * 3600_000)).toBe("1d 2h");
  });
});

describe("state chip", () => {
  it("shows Running, the region and when it tears down, from /overview", async () => {
    renderApp("/", { routes: { "GET /api/v1/overview": overviewFixture("running", { auto_destroy_at: "2026-10-02T15:12:00.000Z" }) } });
    await stateSays("Running · UK South · tears down in 3h 12m");
  });

  it("leaves out the timer when there is none", async () => {
    renderApp("/");
    await stateSays("Running · UK South");
  });

  it("shows Destroyed with no cost when nothing exists", async () => {
    renderApp("/", { routes: { "GET /api/v1/overview": overviewFixture("destroyed") } });
    await stateSays("Destroyed · £0");
  });

  it.each([
    ["deploying", "Deploying · UK South"],
    ["destroying", "Tearing down · UK South"],
    ["hibernating", "Hibernating · UK South"],
    ["standby", "Standby · UK South"],
    ["resuming", "Resuming · UK South"],
    ["failed", "Failed · UK South"],
  ])("words the %s state", async (state, text) => {
    renderApp("/", { routes: { "GET /api/v1/overview": overviewFixture(state) } });
    await stateSays(text);
  });

  it("says the state is unknown (never a made-up one) when /overview cannot be read", async () => {
    renderApp("/", { routes: { "GET /api/v1/overview": { status: 500, json: { error: { code: "internal", message: "Something broke." } } } } });
    await stateSays("State unknown");
  });

  it("shows the read-only Production environment in the page header, not the top bar", () => {
    renderApp("/");
    expect(within(banner()).queryByText("Production")).toBeNull();
    const env = within(screen.getByRole("main")).getByRole("group", { name: "Environment" });
    expect(env).toHaveTextContent("Production");
    expect(within(env).queryByRole("button")).toBeNull();
  });
});

describe("state chip, de-crowded (V2)", () => {
  const chip = () => within(banner()).getByRole("button", { name: /State:/ });

  it('reads "Azure • UK South" on screen and keeps the whole state sentence for screen readers', async () => {
    renderApp("/", { routes: { "GET /api/v1/overview": overviewFixture("running", { auto_destroy_at: "2026-10-02T15:12:00.000Z" }) } });
    await waitFor(() => expect(chip()).toHaveAccessibleName(/Running · UK South · tears down in 3h 12m/));
    expect(within(chip()).getByText("Azure • UK South")).toBeInTheDocument();
  });

  it("colours the dot by state, and folds stale or disconnected into it", async () => {
    renderApp("/");
    await waitFor(() => expect(chip()).toHaveAttribute("data-tone", "ok"));
  });

  it("an old heartbeat turns the dot amber (stale) and says so in the chip's name", async () => {
    renderApp("/", { routes: { "GET /api/v1/overview": overviewFixture("running", { heartbeatStale: true }) } });
    await waitFor(() => expect(chip()).toHaveAttribute("data-tone", "stale"));
    expect(chip()).toHaveAccessibleName(/stale/i);
  });

  it("there is no separate visible Live/Stale text in the bar", async () => {
    renderApp("/");
    const conn = await within(banner()).findByRole("status", { name: "Connection" });
    expect(conn).toHaveClass("visually-hidden");
  });

  it("opens details (state, countdown, connection) from the keyboard", async () => {
    const user = userEvent.setup();
    renderApp("/", { routes: { "GET /api/v1/overview": overviewFixture("running", { auto_destroy_at: "2026-10-02T15:12:00.000Z" }) } });
    await waitFor(() => expect(chip()).toHaveAccessibleName(/tears down/));
    chip().focus();
    await user.keyboard("{Enter}");
    const details = await screen.findByRole("dialog", { name: "Environment state" });
    expect(details).toHaveTextContent("Running");
    expect(details).toHaveTextContent("tears down in 3h 12m");
    expect(details).toHaveTextContent(/Connection\s*Live/);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Environment state" })).toBeNull());
  });

  it("the wordmark's dot is the brand colour, not a state light", async () => {
    renderApp("/", { routes: { "GET /api/v1/overview": overviewFixture("failed") } });
    await waitFor(() => expect(chip()).toHaveAttribute("data-tone", "bad"));
    expect(banner().querySelector(".topbar__dot")).not.toHaveAttribute("data-tone");
  });
});

describe("connection indicator and banner", () => {
  it("shows Live when the overview is fresh and the VM is reporting", async () => {
    renderApp("/");
    await waitFor(() => expect(within(banner()).getByRole("status", { name: "Connection" })).toHaveTextContent("Live"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows Stale when the VM's heartbeat is older than two minutes", async () => {
    renderApp("/", { routes: { "GET /api/v1/overview": overviewFixture("running", { heartbeatStale: true }) } });
    await waitFor(() => expect(within(banner()).getByRole("status", { name: "Connection" })).toHaveTextContent("Stale"));
  });

  it("shows Disconnected plus a banner when the dashboard cannot be reached, and Retry tries again", async () => {
    let down = true;
    // Every call the page makes fails, the widget preferences' included.
    renderApp("/", { routes: { "GET /api/v1/overview": () => (down ? { networkError: true } : overviewFixture()), "GET /api/v1/session": () => (down ? { networkError: true } : sessionFixture()), "GET /api/v1/prefs": () => (down ? { networkError: true } : prefsFixture()) } });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Cannot reach the dashboard");
    // Reads refresh by themselves; writes are never re-sent, so the banner must not promise it.
    expect(alert).toHaveTextContent(/changes are not sent/i);
    expect(alert).not.toHaveTextContent(/trying again automatically/i);
    expect(within(banner()).getByRole("status", { name: "Connection" })).toHaveTextContent("Disconnected");

    down = false;
    await userEvent.setup().click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(within(banner()).getByRole("status", { name: "Connection" })).toHaveTextContent("Live");
  });
});

describe("session expired", () => {
  it("replaces the page with Session expired, sign in again on an opaque redirect", async () => {
    // An expired sign-in redirects every API call, the Clients page's own included.
    renderApp("/clients", {
      routes: { "GET /api/v1/overview": { opaqueRedirect: true }, "GET /api/v1/session": { opaqueRedirect: true }, "GET /api/v1/clients": { opaqueRedirect: true }, "GET /api/v1/prefs": { opaqueRedirect: true } },
    });
    const main = screen.getByRole("main");
    expect(await within(main).findByRole("heading", { name: "Session expired, sign in again" })).toBeInTheDocument();
    expect(within(main).getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(within(main).queryByRole("heading", { name: "Clients" })).toBeNull();
  });

  it("does the same for a 401 and for a login page returned instead of JSON", async () => {
    renderApp("/", { routes: { "GET /api/v1/overview": { text: "<html>login</html>" }, "GET /api/v1/session": { status: 401, json: { error: { code: "x", message: "y" } } }, "GET /api/v1/prefs": { status: 401, json: { error: { code: "x", message: "y" } } } } });
    expect(await screen.findByRole("heading", { name: "Session expired, sign in again" })).toBeInTheDocument();
  });
});
