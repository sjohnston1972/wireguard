// readmeDiagram.test.tsx
//
// Plain English: a readme's diagram block (in place of a hand-drawn sketch)
// is a picture of its committed SVG with its alt text and caption; clicking
// it opens a viewer fitted to the window, with an "Actual size" toggle, that
// Escape closes. The readme shows it where the sketch was, and every diagram
// the catalogue names is in the build's URL map.

import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GuideIndex, ReadmeBlock } from "@shared/labs";
import { ReadmeDiagram, type DiagramBlock } from "./ReadmeDiagram";
import { ReadmeView } from "./ReadmeView";
import { GUIDE_URLS, guideUrl } from "./guides";

const block: DiagramBlock = { t: "diagram", kind: "architecture", file: "lab-x/architecture.svg", title: "Lab X: architecture", alt: "Architecture diagram. Two VMs.", width: 1200, height: 600 };
const urls = { "lab-x/architecture.svg": "/assets/architecture-abc.svg" };

describe("ReadmeDiagram", () => {
  it("shows the SVG with its alt text, size and caption, loaded lazily", () => {
    render(<ReadmeDiagram b={block} urls={urls} />);
    const img = screen.getByRole("img", { name: "Architecture diagram. Two VMs." });
    expect(img).toHaveAttribute("src", "/assets/architecture-abc.svg");
    expect(img).toHaveAttribute("loading", "lazy");
    expect(img).toHaveAttribute("width", "1200");
    expect(screen.getByText("Lab X: architecture").tagName).toBe("FIGCAPTION");
  });

  it("opens a viewer on click: fitted first, Actual size toggles, Escape closes", async () => {
    const user = userEvent.setup();
    render(<ReadmeDiagram b={block} urls={urls} />);
    await user.click(screen.getByRole("button", { name: "Enlarge: Lab X: architecture" }));
    const dialog = screen.getByRole("dialog", { name: "Lab X: architecture" });
    const body = within(dialog).getByTestId("labs-lightbox-body");
    expect(body).not.toHaveClass("labs-lightbox__body--full");
    const toggle = within(dialog).getByRole("button", { name: "Actual size" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await user.click(toggle);
    expect(body).toHaveClass("labs-lightbox__body--full");
    expect(within(dialog).getByRole("button", { name: "Fit to window" })).toHaveAttribute("aria-pressed", "true");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    // Opened again, it starts fitted.
    await user.click(screen.getByRole("button", { name: "Enlarge: Lab X: architecture" }));
    expect(within(screen.getByRole("dialog")).getByTestId("labs-lightbox-body")).not.toHaveClass("labs-lightbox__body--full");
  });

  it("says so when the build has no such file", () => {
    render(<ReadmeDiagram b={block} urls={{}} />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText(/is not in this build/)).toBeInTheDocument();
  });
});

describe("ReadmeView with diagrams", () => {
  // jsdom gives import.meta.url an http: scheme, so find the repo from the working directory (repo root or web/).
  const repo = [process.cwd(), join(process.cwd(), "..")].find((p) => existsSync(join(p, "shared/guides/index.json")))!;
  const index: GuideIndex = JSON.parse(readFileSync(join(repo, "shared/guides/index.json"), "utf8"));

  it("draws a diagram block where the sketch was, between the readme's other blocks", () => {
    const entry = index["az104-16-lb-appgw"]![0]!;
    const blocks: ReadmeBlock[] = [
      { t: "h", level: 2, text: "What it deploys" },
      { t: "diagram", kind: entry.kind, file: entry.file, title: entry.title, alt: entry.alt, width: entry.width, height: entry.height },
      { t: "h", level: 2, text: "Things to try" },
    ];
    render(<ReadmeView blocks={blocks} />);
    const img = screen.getByRole("img", { name: entry.alt });
    expect(img.getAttribute("src")).toBe(guideUrl(entry.file));
    expect(img.closest("figure")!.previousElementSibling).toHaveTextContent("What it deploys");
  });

  it("has a URL for every diagram the catalogue names", () => {
    const files = Object.values(index).flatMap((list) => list.map((e) => e.file));
    expect(files.length).toBeGreaterThan(40);
    for (const f of files) expect(guideUrl(f), f).toBeTruthy();
    expect(Object.keys(GUIDE_URLS).length).toBe(files.length);
  });
});
