// Plan L3.4: the lab modal while a session is live.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LabDetail, RunDetailResponse, RunLogResponse } from "@shared/api";
import { renderApp } from "@/test/render";
import { runDetailFixture } from "@/test/fixtures";
import { card, detailRunning, labs, run, session } from "./testData";

vi.setConfig({ testTimeout: 20_000 });
beforeAll(async () => {
  await import("@/views/labs");
});

const ID = "az104-06-blob-security";
const PATH = `/api/v1/labs/${ID}`;
const RUN = "lab-deploy-20261002115500-b6d2";

const deployingDetail = (): LabDetail => {
  const s = session({ state: "deploying", readyAt: null, autoDestroyAt: null, outputs: null, activeRun: run({ id: RUN, labId: ID, sessionId: "ls-20261002111500-b6r1" }) });
  return detailRunning({ card: card({ running: s }), session: s, runs: [s.activeRun!], resources: null });
};
const runDetail = (): RunDetailResponse => ({
  ...runDetailFixture(RUN),
  steps: [
    { name: "Check out, Parse payload", status: "completed", conclusion: "success", started_at: "2026-10-02T11:56:00.000Z", completed_at: "2026-10-02T11:56:10.000Z" },
    { name: "Collect run secrets", status: "completed", conclusion: "success", started_at: "2026-10-02T11:56:10.000Z", completed_at: "2026-10-02T11:56:20.000Z" },
    { name: "Start live log", status: "in_progress", conclusion: null, started_at: "2026-10-02T11:56:20.000Z", completed_at: null },
    { name: "Apply", status: "queued", conclusion: null, started_at: null, completed_at: null },
  ],
  active: true,
});
const liveLog = (updatedAt: string): RunLogResponse => ({
  log: "2026-10-02T11:56:21.000Z Terraform init\n2026-10-02T11:56:30.000Z azurerm_resource_group.lab: Creating...",
  source: "live",
  active: true,
  updatedAt,
});

const open = (detail: LabDetail, more: Record<string, unknown> = {}) =>
  renderApp(`/labs/${ID}`, { routes: { "GET /api/v1/labs": labs({ running: detail.session ? [detail.session] : [] }), [`GET ${PATH}`]: detail, ...more } });
const dialog = async () => within(await screen.findByRole("dialog", { name: /Blob security/ }));

describe("the lab modal, running", () => {
  it("steps and live log from the lab run", async () => {
    open(deployingDetail(), { [`GET /api/v1/runs/${RUN}`]: runDetail(), [`GET /api/v1/runs/${RUN}/log`]: liveLog(new Date().toISOString()) });
    const d = await dialog();
    expect(d.getByText("Deploying 3/16")).toBeInTheDocument();
    const track = within(await d.findByRole("list", { name: "Run progress" }));
    expect(track.getAllByRole("listitem").map((li) => li.querySelector(".act__step-name")!.textContent)).toEqual(["Check out, Parse payload", "Collect run secrets", "Start live log", "Apply"]);
    const log = await d.findByRole("log", { name: "Live log" });
    await waitFor(() => expect(log).toHaveTextContent("azurerm_resource_group.lab: Creating..."));
    expect(d.getByText("Streaming")).toBeInTheDocument();
    expect(d.getByRole("link", { name: /Open in Activity/ })).toHaveAttribute("href", `/activity/runs/${RUN}`);
  });

  it("a live log with nothing new for over 30 s says Stalled", async () => {
    open(deployingDetail(), { [`GET /api/v1/runs/${RUN}`]: runDetail(), [`GET /api/v1/runs/${RUN}/log`]: liveLog(new Date(Date.now() - 120_000).toISOString()) });
    const d = await dialog();
    expect(await d.findByText("Stalled")).toBeInTheDocument();
  });

  it("resources with a portal link to rg-lab-<id>", async () => {
    open(detailRunning(), { "GET /api/v1/runs/lab-deploy-20261002111500-b6d1": { ...runDetailFixture("lab-deploy-20261002111500-b6d1"), active: false }, "GET /api/v1/runs/lab-deploy-20261002111500-b6d1/log": { log: "", source: "github", active: false, updatedAt: null } });
    const d = await dialog();
    const res = within(d.getByRole("table", { name: "Resources" }));
    expect(res.getByText("l06k3x9q")).toBeInTheDocument();
    expect(res.getByText("storageAccounts")).toBeInTheDocument();
    expect(res.getByText("Succeeded")).toBeInTheDocument();
    const portal = d.getByRole("link", { name: /rg-lab-az104-06-blob-security in the Azure portal/ });
    expect(portal).toHaveAttribute("href", expect.stringContaining("/resourceGroups/rg-lab-az104-06-blob-security"));
    expect(portal).toHaveAttribute("target", "_blank");
  });

  it("no resources from Azure is said in words", async () => {
    open(detailRunning({ resources: null }));
    const d = await dialog();
    expect(d.getByText("Azure did not list the resources just now.")).toBeInTheDocument();
  });

  it("private IPs and connect lines", async () => {
    const s = session({ outputs: { privateIps: { "pe-blob": "10.64.0.4", "vm-lab": "10.64.0.5" }, connect: ["ssh azureuser@10.64.0.5"], users: {} } });
    open(detailRunning({ session: s, card: card({ running: s }) }));
    const d = await dialog();
    const ips = within(d.getByRole("region", { name: "Private IPs" }));
    expect(ips.getByText("pe-blob")).toBeInTheDocument();
    expect(ips.getByText("10.64.0.5")).toBeInTheDocument();
    expect(ips.getByText("ssh azureuser@10.64.0.5")).toBeInTheDocument();
    expect(ips.getAllByRole("button", { name: /Copy/ }).length).toBeGreaterThanOrEqual(3);
  });

  it("Show reveals the password and user names and hides them on close", async () => {
    const user = userEvent.setup();
    const secret = { adminPassword: "Fake-Pa55word-x", users: { ann: "lab-az104-06-blob-security-ann@contoso.onmicrosoft.com" } };
    const { fetchMock } = open(detailRunning(), { [`GET ${PATH}/secret`]: secret });
    let d = await dialog();
    expect(d.queryByText("Fake-Pa55word-x")).toBeNull();
    await user.click(d.getByRole("button", { name: "Show" }));
    expect(await d.findByText("Fake-Pa55word-x")).toBeInTheDocument();
    expect(d.getByText("lab-az104-06-blob-security-ann@contoso.onmicrosoft.com")).toBeInTheDocument();
    await user.click(d.getByRole("button", { name: "Hide" }));
    expect(d.queryByText("Fake-Pa55word-x")).toBeNull();

    await user.click(d.getByRole("button", { name: "Show" }));
    expect(await d.findByText("Fake-Pa55word-x")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByText("Fake-Pa55word-x")).toBeNull();

    // Reopened: hidden again, and Show asks the server again (never cached).
    await user.click((await screen.findAllByRole("link", { name: /Blob security/ }))[0]!);
    d = await dialog();
    expect(d.queryByText("Fake-Pa55word-x")).toBeNull();
    await user.click(d.getByRole("button", { name: "Show" }));
    await d.findByText("Fake-Pa55word-x");
    expect(fetchMock!.callsTo("GET", `${PATH}/secret`)).toHaveLength(3);
  });

  it("note saves", async () => {
    const user = userEvent.setup();
    const s = session({ note: "SAS worked." });
    const { fetchMock } = open(detailRunning({ session: s, card: card({ running: s }) }), { "PUT /api/v1/labs/sessions/ls-20261002111500-b6r1/note": { ok: true, message: "Note saved." } });
    const d = await dialog();
    const note = d.getByRole("textbox", { name: "Note" });
    expect(note).toHaveValue("SAS worked.");
    expect(d.getByRole("button", { name: "Save note" })).toBeDisabled();
    await user.type(note, " Revoking the policy broke it.");
    expect(d.getByText(/41 of 2000/)).toBeInTheDocument();
    await user.click(d.getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(fetchMock!.callsTo("PUT", "/api/v1/labs/sessions/ls-20261002111500-b6r1/note")).toHaveLength(1));
    expect(fetchMock!.callsTo("PUT", "/api/v1/labs/sessions/ls-20261002111500-b6r1/note")[0]!.body).toEqual({ note: "SAS worked. Revoking the policy broke it." });
  });

  it("break-fix What was broken stays closed", async () => {
    const readme: LabDetail["readme"] = [
      { t: "h", level: 2, text: "Symptom" },
      { t: "p", inlines: [{ t: "text", text: "The VM cannot mount the share." }] },
      { t: "details", summary: "What was broken", blocks: [{ t: "p", inlines: [{ t: "text", text: "The service endpoint was missing." }] }] },
    ];
    const detail = detailRunning({ readme, card: card({ type: "break-fix", running: session() }) });
    const { client } = open(detail);
    const d = await dialog();
    const details = (await d.findByText("What was broken")).closest("details")!;
    expect(details).not.toHaveAttribute("open");
    // A refresh (the 15 s poll) never opens it.
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["labs"] });
    });
    expect(d.getByText("What was broken").closest("details")).not.toHaveAttribute("open");
  });

  it("Tear down cancels a deploy in progress first", async () => {
    const user = userEvent.setup();
    const { fetchMock } = open(deployingDetail(), {
      [`GET /api/v1/runs/${RUN}`]: runDetail(),
      [`GET /api/v1/runs/${RUN}/log`]: liveLog(new Date().toISOString()),
      [`POST ${PATH}/cancel`]: { ok: true, message: "Cancelling, then tearing down." },
      [`POST ${PATH}/destroy`]: { ok: true, message: "Tearing down." },
    });
    const d = await dialog();
    await user.click(within(d.getByRole("contentinfo")).getByRole("button", { name: "Tear down" }));
    const confirm = within(await screen.findByRole("dialog", { name: /^Tear down/ }));
    expect(confirm.getByText(/Cancels the deploy in progress/)).toBeInTheDocument();
    await user.click(confirm.getByRole("button", { name: "Cancel and tear down" }));
    await waitFor(() => expect(fetchMock!.callsTo("POST", `${PATH}/cancel`)).toHaveLength(1));
    expect(fetchMock!.callsTo("POST", `${PATH}/destroy`)).toHaveLength(0);
  });

  it("the footer offers Extend while running, with time left and cost so far", async () => {
    const user = userEvent.setup();
    open(detailRunning(), { [`POST ${PATH}/extend`]: { ok: true, message: "Extended." } });
    const d = await dialog();
    const foot = within(d.getByRole("contentinfo"));
    await waitFor(() => expect(foot.getByText("1 h 15 min left")).toBeInTheDocument());
    expect(foot.getByText("£0.0071 so far")).toBeInTheDocument();
    await user.click(foot.getByRole("button", { name: "Extend" }));
    expect(await screen.findByRole("menuitem", { name: "1 hour" })).toBeInTheDocument();
  });
});
