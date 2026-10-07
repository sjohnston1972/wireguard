// badge.test.tsx
//
// Plain English: labs redesign plan E8, the contract B and C build on. The
// status badge shows the word and tone statusBadge chose (a StatusPill, so a
// dot and a word, never colour alone); useLabViews derives each card's view
// once per answer, in lab number order; the details stub renders in all
// three containers.

import { describe, expect, it } from "vitest";
import { render, renderHook, screen } from "@testing-library/react";
import type { LabsResponse } from "@shared/api";
import { LabStatusBadge } from "./LabStatusBadge";
import { labView, labViews, useLabViews } from "./contract";
import { LabDetailsDrawer, LabDetailsPanel, LabDetailsView } from "./LabDetailsPanel";
import { card, catalogue, labs, session } from "./testData";

describe("LabStatusBadge", () => {
  it("shows the word and tone from badge", () => {
    const { container } = render(<LabStatusBadge badge={{ label: "Setup required", tone: "amber" }} />);
    const pill = container.querySelector(".pill")!;
    expect(pill).toHaveTextContent("Setup required");
    expect(pill).toHaveClass("pill--amber");
    expect(pill.querySelector(".pill__dot")).not.toBeNull();
  });

  it("shows a view's badge: Ready to run, Running, Checking…", () => {
    const { rerender, container } = render(<LabStatusBadge badge={labView(card(), true).badge} />);
    expect(container.querySelector(".pill")).toHaveTextContent("Ready to run");
    expect(container.querySelector(".pill")).toHaveClass("pill--green");
    rerender(<LabStatusBadge badge={labView(card({ running: session() }), true).badge} />);
    expect(container.querySelector(".pill")).toHaveTextContent("Running");
    rerender(<LabStatusBadge badge={labView(card(), false).badge} />);
    expect(container.querySelector(".pill")).toHaveTextContent("Checking…");
    expect(container.querySelector(".pill")).toHaveClass("pill--grey");
  });
});

describe("labView and useLabViews", () => {
  it("a view carries readiness, status, badge, topics, family and search text", () => {
    const v = labView(card({ blockers: [{ kind: "role", message: "Needs the role." }] }), true);
    expect(v).toMatchObject({ readiness: "setup-required", status: "none", badge: { label: "Setup required", tone: "amber" }, family: "identity" });
    expect(v.topics).toEqual(["Entra ID", "Private Link", "DNS", "Storage", "Virtual networks"]);
    expect(v.search).toContain("lab 6");
  });

  it("views are in lab number order", () => {
    expect(labViews(catalogue(), true).map((v) => v.card.number)).toEqual([1, 5, 6, 7, 20]);
  });

  it("derived views are computed once per data change", () => {
    const first = labs();
    const { result, rerender } = renderHook(({ data }: { data: LabsResponse | undefined }) => useLabViews({ data }), { initialProps: { data: first as LabsResponse | undefined } });
    const before = result.current;
    expect(before.loaded).toBe(true);
    expect(before.views).toHaveLength(5);
    expect(before.byId.get("az104-05-storage")?.card.number).toBe(5);
    rerender({ data: first });
    expect(result.current.views).toBe(before.views);
    rerender({ data: labs() });
    expect(result.current.views).not.toBe(before.views);
    rerender({ data: undefined });
    expect(result.current).toMatchObject({ views: [], loaded: false });
  });
});

describe("the details stub (C fills it in)", () => {
  const data = labs();
  const view = labView(data.labs[1], true);

  it("the panel, the drawer and the phone view each show the lab's title and badge", () => {
    const { unmount } = render(<LabDetailsPanel view={view} data={data} layout="wide" onSelect={() => {}} />);
    expect(screen.getByRole("heading", { level: 2, name: view.card.title })).toBeInTheDocument();
    expect(screen.getByRole("complementary")).toHaveTextContent(view.badge.label);
    unmount();
    const d = render(<LabDetailsDrawer view={view} data={data} layout="tablet" onSelect={() => {}} open onOpenChange={() => {}} />);
    expect(screen.getByRole("dialog", { name: view.card.title })).toHaveTextContent(view.badge.label);
    d.unmount();
    render(<LabDetailsView view={view} data={data} layout="phone" onSelect={() => {}} onBack={() => {}} />);
    expect(screen.getByRole("heading", { level: 2, name: view.card.title })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back to labs" })).toBeInTheDocument();
  });
});
