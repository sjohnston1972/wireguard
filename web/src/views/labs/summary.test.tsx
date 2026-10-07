// Labs redesign plan B2: the summary strip (spec §8.1). Real counts only: no completion.
import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";
import { setViewport } from "@/test/viewport";
import { card, labs, session } from "./testData";
import { LabsSummaryStrip } from "./LabsSummaryStrip";

const strip = () => within(screen.getByRole("region", { name: "Labs summary" }));

describe("the summary strip", () => {
  it("All exams: 2 of 5 labs run (labs with runs > 0), with a Coverage link", () => {
    renderWithProviders(<LabsSummaryStrip data={labs()} exam={null} />, { routes: null });
    const s = strip();
    expect(s.getByText("All exams")).toBeInTheDocument();
    const run = s.getByText("2 of 5 labs run");
    expect(run).toHaveAttribute("title", "A lab counts once it has run for 15 minutes or more");
    expect(s.getByRole("link", { name: "Coverage" })).toHaveAttribute("href", "/labs/history");
    // No completion feature (Appendix A).
    expect(s.queryByRole("progressbar")).toBeNull();
    expect(s.queryByText(/complete/i)).toBeNull();
  });

  it("AZ-305 counts AZ-305 and tagged labs", () => {
    const data = labs({ labs: [...labs().labs, card({ id: "az104-11-tagged", number: 11, exam: "AZ-104", exams: ["AZ-104", "AZ-305"], runs: 1 })] });
    renderWithProviders(<LabsSummaryStrip data={data} exam="AZ-305" />, { routes: null });
    const s = strip();
    expect(s.getByText("AZ-305")).toBeInTheDocument();
    // Lab 20 (AZ-305, never run) and lab 11 (tagged AZ-305, run once).
    expect(s.getByText("1 of 2 labs run")).toBeInTheDocument();
  });

  it("1 of 3 running, with the address slots on a wide screen", () => {
    renderWithProviders(<LabsSummaryStrip data={labs({ running: [session()], slots: { used: 1, total: 32 } })} exam={null} />, { routes: null });
    const s = strip();
    expect(s.getByText("1 of 3 running")).toBeInTheDocument();
    expect(s.queryByText(/limit reached/)).toBeNull();
    expect(s.getByText("· 1 of 32 address slots")).toBeInTheDocument();
  });

  it("limit reached at 3 of 3, in amber with the words", () => {
    const three = [session({ id: "a" }), session({ id: "b", labId: "az104-05-storage" }), session({ id: "c", labId: "az104-07-file-share" })];
    renderWithProviders(<LabsSummaryStrip data={labs({ running: three })} exam={null} />, { routes: null });
    const item = strip().getByText("3 of 3 running").closest("li")!;
    expect(item).toHaveTextContent("3 of 3 running, limit reached");
    expect(item).toHaveClass("labs-summary__item--amber");
  });

  it("no address slots below 1200 px", () => {
    setViewport(1024);
    renderWithProviders(<LabsSummaryStrip data={labs()} exam={null} />, { routes: null });
    expect(strip().queryByText(/address slots/)).toBeNull();
  });

  it("Auto-cleanup on only when autoCleanup", () => {
    const { unmount } = renderWithProviders(<LabsSummaryStrip data={labs({ autoCleanup: true })} exam={null} />, { routes: null });
    const on = strip().getByText("Auto-cleanup on");
    expect(on.closest("li")).toHaveAttribute("title", "Checked every 5 minutes: each lab is torn down at its timer or hard stop.");
    unmount();
    renderWithProviders(<LabsSummaryStrip data={labs({ autoCleanup: false })} exam={null} />, { routes: null });
    // Never "off" guessed from the client: the item is left out.
    expect(strip().queryByText(/Auto-cleanup/)).toBeNull();
  });

  it("skeleton pills while loading, never a number", () => {
    renderWithProviders(<LabsSummaryStrip data={undefined} exam={null} />, { routes: null });
    const region = screen.getByRole("region", { name: "Labs summary" });
    expect(region).toHaveAttribute("aria-busy", "true");
    expect(region.querySelectorAll(".skeleton")).toHaveLength(3);
    expect(region.textContent ?? "").not.toMatch(/\d/);
  });
});
