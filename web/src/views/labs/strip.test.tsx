// Plan L3.2: the running strip.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { HOUR, MIN, at, labs, run, session } from "./testData";

vi.setConfig({ testTimeout: 20_000 });
beforeAll(async () => {
  await import("@/views/labs");
});

const deploying = () =>
  session({
    id: "ls-20261002115500-a5r1",
    labId: "az104-05-storage",
    title: "Storage accounts: redundancy, access tiers, lifecycle",
    state: "deploying",
    peering: "waiting",
    readyAt: null,
    autoDestroyAt: null,
    requestedAt: at(-5 * MIN),
    maxUntil: at(-5 * MIN + 6 * HOUR),
    costGbp: 0.0001,
    activeRun: run(),
  });
const running = () => session(); // lab 6: running, peered, 1 h 15 min left, £0.0071 so far

const strip = async () => within(await screen.findByRole("region", { name: "Running labs" }));
const chip = (s: ReturnType<typeof within>, title: RegExp) => within(s.getByRole("link", { name: title }).closest("li")!);
const ok = { ok: true, message: "Done." };

describe("the running strip", () => {
  it("hidden when nothing runs", async () => {
    renderApp("/labs", { routes: { "GET /api/v1/labs": labs() } });
    await screen.findByRole("region", { name: "Catalogue" });
    expect(screen.queryByRole("region", { name: "Running labs" })).toBeNull();
  });

  it("a chip per session with state, step 3/16, time left, cost so far and peering word", async () => {
    renderApp("/labs", { routes: { "GET /api/v1/labs": labs({ running: [deploying(), running()] }) } });
    const s = await strip();
    expect(s.getAllByRole("listitem")).toHaveLength(2);
    const five = chip(s, /Storage accounts/);
    expect(five.getByText("Deploying 3/16")).toBeInTheDocument();
    expect(five.getByText("Peer waiting")).toBeInTheDocument();
    expect(five.getByText("£0.0001 so far")).toBeInTheDocument();
    // No Extend while it deploys.
    expect(five.queryByRole("button", { name: /Extend/ })).toBeNull();
    const six = chip(s, /Blob security/);
    expect(six.getByText("Running")).toBeInTheDocument();
    await waitFor(() => expect(six.getByText("1 h 15 min left")).toBeInTheDocument());
    expect(six.getByText("£0.0071 so far")).toBeInTheDocument();
    expect(six.getByText("Peered")).toBeInTheDocument();
    expect(six.getByRole("link", { name: /Blob security/ })).toHaveAttribute("href", "/labs/az104-06-blob-security");
  });

  it("no cost yet is said in words, never £0", async () => {
    renderApp("/labs", { routes: { "GET /api/v1/labs": labs({ running: [session({ costGbp: null })] }) } });
    const s = await strip();
    expect(s.getByText("cost not known yet")).toBeInTheDocument();
    expect(s.queryByText(/£0.00 so far/)).toBeNull();
  });

  it("Extend offers 1h, 2h and to max", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderApp("/labs", { routes: { "GET /api/v1/labs": labs({ running: [running()] }), "POST /api/v1/labs/az104-06-blob-security/extend": ok } });
    const s = await strip();
    await user.click(s.getByRole("button", { name: "Extend" }));
    const menu = within(await screen.findByRole("menu"));
    expect(menu.getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["1 hour", "2 hours", expect.stringMatching(/^To max \(until \d\d:\d\d\)$/)]);
    await user.click(menu.getByRole("menuitem", { name: "2 hours" }));
    await waitFor(() => expect(fetchMock!.callsTo("POST", "/api/v1/labs/az104-06-blob-security/extend")).toHaveLength(1));
    expect(fetchMock!.callsTo("POST", "/api/v1/labs/az104-06-blob-security/extend")[0]!.body).toEqual({ hours: 2 });
  });

  it("Extend to max is the only extend offered under an hour from max", async () => {
    const user = userEvent.setup();
    const late = session({ autoDestroyAt: at(20 * MIN), maxUntil: at(50 * MIN) });
    const { fetchMock } = renderApp("/labs", { routes: { "GET /api/v1/labs": labs({ running: [late] }), "POST /api/v1/labs/az104-06-blob-security/extend": ok } });
    const s = await strip();
    await user.click(s.getByRole("button", { name: "Extend" }));
    const menu = within(await screen.findByRole("menu"));
    expect(menu.getAllByRole("menuitem")).toHaveLength(1);
    await user.click(menu.getByRole("menuitem", { name: /^To max/ }));
    await waitFor(() => expect(fetchMock!.callsTo("POST", "/api/v1/labs/az104-06-blob-security/extend")[0]?.body).toEqual({ toMax: true }));
  });

  it("no Extend once the timer is at its maximum", async () => {
    const atMax = session({ autoDestroyAt: at(50 * MIN), maxUntil: at(50 * MIN) });
    renderApp("/labs", { routes: { "GET /api/v1/labs": labs({ running: [atMax] }) } });
    const s = await strip();
    expect(s.queryByRole("button", { name: "Extend" })).toBeNull();
  });

  it("Tear down asks in a confirm dialog", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderApp("/labs", { routes: { "GET /api/v1/labs": labs({ running: [running()] }), "POST /api/v1/labs/az104-06-blob-security/destroy": ok } });
    const s = await strip();
    await user.click(s.getByRole("button", { name: "Tear down" }));
    let dialog = within(await screen.findByRole("dialog", { name: /Tear down Blob security/ }));
    expect(dialog.getByText(/rg-lab-az104-06-blob-security/)).toBeInTheDocument();
    await user.click(dialog.getByRole("button", { name: "Keep it" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fetchMock!.callsTo("POST", "/api/v1/labs/az104-06-blob-security/destroy")).toHaveLength(0);

    await user.click(s.getByRole("button", { name: "Tear down" }));
    dialog = within(await screen.findByRole("dialog", { name: /Tear down Blob security/ }));
    await user.click(dialog.getByRole("button", { name: "Tear down now" }));
    await waitFor(() => expect(fetchMock!.callsTo("POST", "/api/v1/labs/az104-06-blob-security/destroy")).toHaveLength(1));
    expect(fetchMock!.callsTo("POST", "/api/v1/labs/az104-06-blob-security/destroy")[0]!.body).toEqual({ confirm: true });
  });

  it("leftovers the sweep found are listed with Clean up, which asks first", async () => {
    const user = userEvent.setup();
    const orphans = [
      { labId: "az104-08-vms", names: ["rg-lab-az104-08-vms", "lab-az104-08-vms-ann"], since: at(-2 * HOUR) },
      { labId: null, names: ["lab-odd-thing"], since: at(-HOUR) },
    ];
    const { fetchMock } = renderApp("/labs", { routes: { "GET /api/v1/labs": labs({ orphans }), "POST /api/v1/labs/orphans/cleanup": { ok: true, message: "Cleaning up." } } });
    const box = within(await screen.findByRole("region", { name: "Lab leftovers" }));
    const items = box.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("rg-lab-az104-08-vms, lab-az104-08-vms-ann");
    expect(within(items[1]!).queryByRole("button", { name: /Clean up/ })).toBeNull();
    await user.click(within(items[0]!).getByRole("button", { name: "Clean up az104-08-vms" }));
    const dialog = within(await screen.findByRole("dialog", { name: /Clean up az104-08-vms/ }));
    await user.click(dialog.getByRole("button", { name: "Clean up now" }));
    await waitFor(() => expect(fetchMock!.callsTo("POST", "/api/v1/labs/orphans/cleanup")[0]?.body).toEqual({ lab_id: "az104-08-vms" }));
  });

  it("a session tearing down offers no Extend and no second Tear down", async () => {
    const going = session({ state: "tearing_down", activeRun: run({ action: "destroy", step: { done: 4, of: 11, name: "Unpeer" }, labId: "az104-06-blob-security" }) });
    renderApp("/labs", { routes: { "GET /api/v1/labs": labs({ running: [going] }) } });
    const s = await strip();
    expect(s.getByText("Tearing down 4/11")).toBeInTheDocument();
    expect(s.queryByRole("button", { name: "Extend" })).toBeNull();
    expect(s.queryByRole("button", { name: "Tear down" })).toBeNull();
  });
});
