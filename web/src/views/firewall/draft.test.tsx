import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { FirewallResponse } from "@shared/api";
import { renderApp } from "@/test/render";
import { draftData, firewallData } from "./testData";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const STALE = "The live rules changed since this draft began. Discard it and start again.";
const draftBar = () => screen.findByRole("region", { name: "Unpublished changes" });
const policy = () => screen.getByRole("status", { name: "Policy status" });

describe("the draft", () => {
  it("the draft bar shows the change count and Discard calls DELETE firewall/draft", async () => {
    let draft: FirewallResponse["draft"] = draftData();
    const { fetchMock } = renderApp("/firewall", {
      routes: {
        "GET /api/v1/firewall": () => firewallData({ draft }),
        "DELETE /api/v1/firewall/draft": () => {
          draft = null;
          return { ok: true, message: "Draft discarded." };
        },
      },
    });
    const bar = await draftBar();
    expect(bar).toHaveTextContent("2 unpublished changes");
    fireEvent.click(within(bar).getByRole("button", { name: "Discard changes" }));
    const dialog = await screen.findByRole("dialog", { name: /discard 2 unpublished changes/i });
    expect(fetchMock!.callsTo("DELETE", "/api/v1/firewall/draft")).toHaveLength(0); // asks first
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard draft" }));
    await waitFor(() => expect(fetchMock!.callsTo("DELETE", "/api/v1/firewall/draft")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Unpublished changes" })).toBeNull());
    expect(screen.queryByRole("button", { name: "Review & apply" })).toBeNull();
  });

  it("without a draft there is no draft bar and no apply or discard button", async () => {
    renderApp("/firewall", { routes: { "GET /api/v1/firewall": firewallData() } });
    await screen.findByRole("table", { name: "Firewall rules" });
    expect(screen.queryByRole("region", { name: "Unpublished changes" })).toBeNull();
    expect(screen.queryByRole("button", { name: /review & apply|discard/i })).toBeNull();
  });

  it("review lists added, removed, changed fields, moved and default", async () => {
    const draft = draftData({
      diff: {
        added: [{ id: 9, name: "SSH to workloads", place: 6 }],
        removed: [{ id: 4, name: "Block old printer", place: 4 }],
        changed: [{ id: 3, name: "Web to the test server", fields: [{ field: "ports", before: "443", after: "443, 8443" }] }],
        moved: [{ id: 5, name: "Workloads to the internet (updates)", from: 5, to: 1 }],
        defaultChanged: { before: "deny", after: "allow" },
      },
      changes: 5,
    });
    renderApp("/firewall", { routes: { "GET /api/v1/firewall": firewallData({ draft }) } });
    fireEvent.click(within(await draftBar()).getByRole("button", { name: "Review & apply" }));
    const dialog = await screen.findByRole("dialog", { name: /review 5 changes/i });
    const added = within(dialog).getByRole("list", { name: "Added" });
    expect(added).toHaveTextContent("SSH to workloads");
    expect(added).toHaveTextContent("rule 6");
    expect(within(dialog).getByRole("list", { name: "Removed" })).toHaveTextContent("Block old printer");
    const changed = within(dialog).getByRole("list", { name: "Changed" });
    expect(changed).toHaveTextContent("Web to the test server");
    expect(changed).toHaveTextContent("ports");
    expect(changed).toHaveTextContent("443");
    expect(changed).toHaveTextContent("443, 8443");
    expect(within(dialog).getByRole("list", { name: "Moved" })).toHaveTextContent(/Workloads to the internet \(updates\).*rule 5.*rule 1/);
    expect(within(dialog).getByRole("list", { name: "Default action" })).toHaveTextContent(/Deny.*Allow/);
    expect(within(dialog).queryByRole("alert")).toBeNull(); // not stale
  });

  it("a stale draft is flagged in the review", async () => {
    renderApp("/firewall", { routes: { "GET /api/v1/firewall": firewallData({ draft: draftData({ stale: true }) }) } });
    fireEvent.click(within(await draftBar()).getByRole("button", { name: "Review & apply" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("alert")).toHaveTextContent(/live rules changed since this draft began/i);
  });

  it("apply sends baseVersion and then shows waiting for VM until applied", async () => {
    let stage: "draft" | "pending" | "applied" = "draft";
    const answer = () =>
      stage === "draft"
        ? firewallData({ draft: draftData({ baseVersion: 4 }) })
        : firewallData({
            version: 5,
            draft: null,
            policy: stage === "pending" ? { hash: "f00d", state: "pending", text: "Changed: the VM picks it up within 30 seconds." } : { hash: "f00d", state: "applied", text: "Applied on the VM (rule set f00d)." },
          });
    const { fetchMock, client } = renderApp("/firewall", {
      routes: {
        "GET /api/v1/firewall": answer,
        "POST /api/v1/firewall/draft/apply": () => {
          stage = "pending";
          return { ok: true, message: "Applied 2 changes. The VM picks them up within 30 seconds." };
        },
      },
    });
    await draftBar();
    expect(policy()).toHaveTextContent("Active");
    fireEvent.click(screen.getByRole("button", { name: "Review & apply" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply 2 changes" }));
    await waitFor(() => expect(fetchMock!.callsTo("POST", "/api/v1/firewall/draft/apply")).toHaveLength(1));
    expect(fetchMock!.callsTo("POST", "/api/v1/firewall/draft/apply")[0].body).toEqual({ baseVersion: 4 });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(policy()).toHaveTextContent("Waiting for VM"));
    expect(screen.queryByRole("region", { name: "Unpublished changes" })).toBeNull();
    stage = "applied";
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["firewall"] });
    });
    await waitFor(() => expect(policy()).toHaveTextContent("Active"));
    expect(policy()).not.toHaveTextContent("Waiting for VM");
  });

  it("a 409 on apply keeps the draft bar and shows the message", async () => {
    const { fetchMock } = renderApp("/firewall", {
      routes: {
        "GET /api/v1/firewall": () => firewallData({ draft: draftData() }),
        "POST /api/v1/firewall/draft/apply": { status: 409, json: { error: { code: "conflict", message: STALE } } },
      },
    });
    fireEvent.click(within(await draftBar()).getByRole("button", { name: "Review & apply" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply 2 changes" }));
    await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent(STALE));
    expect(fetchMock!.callsTo("POST", "/api/v1/firewall/draft/apply")).toHaveLength(1);
    // The modal stays open with the reason; closing it leaves the draft as it was.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await draftBar()).toHaveTextContent("2 unpublished changes");
    expect(policy()).not.toHaveTextContent("Waiting for VM");
  });

  it("a 422 for a broken rule is shown in the modal", async () => {
    renderApp("/firewall", {
      routes: {
        "GET /api/v1/firewall": () => firewallData({ draft: draftData() }),
        "POST /api/v1/firewall/draft/apply": { status: 422, json: { error: { code: "refused", message: "Rule 6, SSH to workloads: ports must be 1-65535.", field: "rules" } } },
      },
    });
    fireEvent.click(within(await draftBar()).getByRole("button", { name: "Review & apply" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply 2 changes" }));
    await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent("Rule 6, SSH to workloads: ports must be 1-65535."));
  });

  it("refused by the VM shows the agent's error", async () => {
    const text = "The VM refused the last rule set and kept the previous one: iptables-restore: line 12 failed";
    renderApp("/firewall", { routes: { "GET /api/v1/firewall": firewallData({ policy: { hash: "beef", state: "refused", text } }) } });
    await screen.findByRole("table", { name: "Firewall rules" });
    expect(policy()).toHaveTextContent("Refused by the VM");
    expect(policy()).toHaveTextContent("iptables-restore: line 12 failed");
  });
});
