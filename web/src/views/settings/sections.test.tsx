import "./slow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RestorePreviewResponse } from "@shared/api";
import { renderApp } from "@/test/render";
import { routesFor, runningOverview, settingsFixture } from "./testkit";

// The real downloader needs a browser (blobs, a temporary link); what matters
// here is that every download goes through @/api/download.
const dl = vi.hoisted(() => ({ downloadExport: vi.fn(async () => {}), downloadConfigBackup: vi.fn(async (_day: string) => {}) }));
vi.mock("@/api/download", () => dl);

beforeEach(() => {
  dl.downloadExport.mockClear();
  dl.downloadConfigBackup.mockClear();
});

const NOW = "2026-10-02T12:00:00.000Z";

describe("Settings sections", () => {
  it("schedules live under Automation with UK times and next start", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderApp("/settings/automation", { routes: { ...routesFor(), "PUT /api/v1/schedules/7": { ok: true, message: "Schedule switched off." } } });
    const list = await screen.findByRole("list", { name: "Schedules" });
    expect(within(list).getByText(/Mon–Fri · 08:00–18:00/)).toBeInTheDocument();
    expect(within(list).getByText("Usual settings")).toBeInTheDocument();
    expect(screen.getByText("tomorrow 08:00")).toBeInTheDocument();
    expect(screen.getAllByText("UK time").length).toBeGreaterThan(0);
    // Not a tab of its own.
    expect(screen.queryByRole("tab", { name: "Scheduling" })).toBeNull();

    await user.click(within(list).getByRole("switch"));
    await waitFor(() => expect(fetchMock!.callsTo("PUT", "/api/v1/schedules/7")).toHaveLength(1));
    expect(fetchMock!.callsTo("PUT", "/api/v1/schedules/7")[0]!.body).toEqual({ enabled: false });
  });

  it("adds a schedule with days, UK times and a profile", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderApp("/settings/automation", { routes: { ...routesFor(), "POST /api/v1/schedules": { ok: true, message: "Schedule added." } } });
    await user.click(await screen.findByRole("button", { name: "Add schedule" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a schedule" });
    await user.click(within(dialog).getByRole("button", { name: "Add schedule" }));
    await waitFor(() => expect(fetchMock!.callsTo("POST", "/api/v1/schedules")).toHaveLength(1));
    expect(fetchMock!.callsTo("POST", "/api/v1/schedules")[0]!.body).toEqual({ days: [1, 2, 3, 4, 5], start: "08:00", end: "18:00", profileId: null });
  });

  it("restore shows the preview counts before confirm", async () => {
    const user = userEvent.setup();
    const preview: RestorePreviewResponse = {
      token: "a".repeat(64),
      exportedAt: "2026-09-30T03:00:00.000Z",
      file: { peers: 4, fw_rules: 6 },
      current: { peers: 2, fw_rules: 3 },
      labels: { peers: "Clients", fw_rules: "Firewall rules" },
    } as unknown as RestorePreviewResponse;
    const { fetchMock } = renderApp("/settings/backup", {
      routes: { ...routesFor(), "POST /api/v1/backup/restore/preview": preview, "POST /api/v1/backup/restore/confirm": { ok: true, message: "Restored." } },
    });
    // Before a file: nothing to confirm.
    expect(await screen.findByRole("button", { name: "Choose export file" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Restore from this file/ })).toBeNull();

    const file = new File([JSON.stringify({ version: 1, exported_at: "2026-09-30T03:00:00.000Z", peers: [] })], "wg-export.json", { type: "application/json" });
    await user.upload(screen.getByLabelText("Export file"), file);

    const table = await screen.findByRole("table", { name: "Restore preview" });
    const row = (label: string) => within(within(table).getByRole("rowheader", { name: label }).closest("tr")!).getAllByRole("cell").map((c) => c.textContent);
    expect(row("Clients")).toEqual(["4", "2"]);
    expect(row("Firewall rules")).toEqual(["6", "3"]);
    // Previewing changed nothing.
    expect(fetchMock!.callsTo("POST", "/api/v1/backup/restore/confirm")).toHaveLength(0);
    expect(fetchMock!.callsTo("POST", "/api/v1/backup/restore/preview")[0]!.body).toMatchObject({ version: 1 });

    const go = screen.getByRole("button", { name: "Restore from this file" });
    expect(go).toBeDisabled();
    await user.type(screen.getByLabelText(/Type restore to confirm/i), "restore");
    await user.click(go);
    await waitFor(() => expect(fetchMock!.callsTo("POST", "/api/v1/backup/restore/confirm")).toHaveLength(1));
    expect(fetchMock!.callsTo("POST", "/api/v1/backup/restore/confirm")[0]!.body).toEqual({ token: "a".repeat(64), confirm: "restore" });
  });

  it("a file that is not JSON is refused in the page, without asking the server", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderApp("/settings/backup", { routes: routesFor() });
    await user.upload(await screen.findByLabelText("Export file"), new File(["not json"], "x.json", { type: "application/json" }));
    expect(await screen.findByText(/not a wg-admin export/)).toBeInTheDocument();
    expect(fetchMock!.callsTo("POST", "/api/v1/backup/restore/preview")).toHaveLength(0);
  });

  it("export downloads through downloadFile", async () => {
    const user = userEvent.setup();
    renderApp("/settings/backup", { routes: routesFor() });
    await user.click(await screen.findByRole("button", { name: "Download export" }));
    expect(dl.downloadExport).toHaveBeenCalledTimes(1);
    const list = screen.getByRole("list", { name: "Config backups by day" });
    expect(within(list).getByText("2026-10-01")).toBeInTheDocument();
    await user.click(within(list).getByRole("button", { name: "Download backup 2026-10-01" }));
    expect(dl.downloadConfigBackup).toHaveBeenCalledWith("2026-10-01");
  });

  it("release lock shows holder and age and needs confirmation", async () => {
    const user = userEvent.setup();
    const s = settingsFixture({ lock: { held: true, runId: "run-123", since: "2026-10-02T11:48:00.000Z" } });
    const ov = runningOverview();
    expect(ov.now).toBe(NOW);
    const { fetchMock } = renderApp("/settings/maintenance", { routes: { ...routesFor(s, ov), "POST /api/v1/lock/release": { ok: true, message: "Run lock released." } } });
    const lock = await screen.findByRole("region", { name: "Run lock" });
    expect(within(lock).getByText("run-123")).toBeInTheDocument();
    expect(within(lock).getByText("12 m ago")).toBeInTheDocument();

    await user.click(within(lock).getByRole("button", { name: "Release lock" }));
    const dialog = await screen.findByRole("dialog", { name: "Release the run lock" });
    const confirm = within(dialog).getByRole("button", { name: "Release lock" });
    expect(confirm).toBeDisabled();
    expect(fetchMock!.callsTo("POST", "/api/v1/lock/release")).toHaveLength(0);
    await user.type(within(dialog).getByLabelText(/Type release lock to confirm/i), "release lock");
    await user.click(confirm);
    await waitFor(() => expect(fetchMock!.callsTo("POST", "/api/v1/lock/release")).toHaveLength(1));
  });

  it("destroying infrastructure is typed, with its consequence in words", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderApp("/settings/maintenance", { routes: { ...routesFor(), "POST /api/v1/destroy": { ok: true, message: "Tear-down started." } } });
    await user.click(await screen.findByRole("button", { name: "Destroy infrastructure" }));
    const dialog = await screen.findByRole("dialog", { name: "Destroy infrastructure" });
    expect(within(dialog).getByText(/All clients lose their connection/)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/Type destroy to confirm/i), "destroy");
    await user.click(within(dialog).getByRole("button", { name: "Destroy infrastructure" }));
    await waitFor(() => expect(fetchMock!.callsTo("POST", "/api/v1/destroy")).toHaveLength(1));
    expect(fetchMock!.callsTo("POST", "/api/v1/destroy")[0]!.body).toEqual({ confirm: "destroy" });
  });

  it("push test and remove phone call their endpoints", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderApp("/settings/mobile", {
      routes: { ...routesFor(), "POST /api/v1/push/test": { ok: true, message: "Test alert sent to 1 phone(s)." }, "DELETE /api/v1/push/3": { ok: true, message: "Removed." } },
    });
    // The install QR is for the dashboard's address.
    expect(await screen.findByLabelText("QR code for https://wg.example.net")).toBeInTheDocument();
    // jsdom has no push support: said in words, not left blank.
    expect(await screen.findByText(/cannot receive alerts/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Send test notification" }));
    await waitFor(() => expect(fetchMock!.callsTo("POST", "/api/v1/push/test")).toHaveLength(1));

    const phones = screen.getByRole("list", { name: "Signed-up phones" });
    expect(within(phones).getByText("Android phone (app)")).toBeInTheDocument();
    await user.click(within(phones).getByRole("button", { name: "Remove Android phone (app)" }));
    await waitFor(() => expect(fetchMock!.callsTo("DELETE", "/api/v1/push/3")).toHaveLength(1));
  });

  it("security shows the short key, copies the full one, and explains rotation in a drawer", async () => {
    const user = userEvent.setup();
    renderApp("/settings/security", { routes: routesFor() });
    expect(await screen.findByText("wqbe4S5U…3yc=")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy Public key" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /How key rotation works/ }));
    const drawer = await screen.findByRole("dialog", { name: "How key rotation works" });
    expect(within(drawer).getByText("npm run keys -- --rotate")).toBeInTheDocument();
  });

  it("profiles: use goes to the reviewed deploy form; delete is typed", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderApp("/settings/deployment", { routes: { ...routesFor(), "DELETE /api/v1/profiles/2": { ok: true, message: "Profile deleted." } } });
    const list = await screen.findByRole("list", { name: "Profiles" });
    expect(within(list).getByText("Deployed now")).toBeInTheDocument();
    await user.click(within(list).getByRole("button", { name: "Delete EU exit (Amsterdam)" }));
    const dialog = await screen.findByRole("dialog", { name: /Delete EU exit/ });
    await user.type(within(dialog).getByLabelText(/Type delete to confirm/i), "delete");
    await user.click(within(dialog).getByRole("button", { name: "Delete profile" }));
    await waitFor(() => expect(fetchMock!.callsTo("DELETE", "/api/v1/profiles/2")).toHaveLength(1));
    await user.click(within(list).getAllByRole("button", { name: "Use" })[0]!);
    expect(screen.getByLabelText("location")).toHaveTextContent("/?action=deploy&profile=");
  });
});
