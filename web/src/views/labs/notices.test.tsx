// Labs redesign plan B3: the notices and the consolidated setup banner (spec §8.2; Review Focus 2 and 5).
import { beforeAll, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LabBlocker, LabCard } from "@shared/api";
import type { LabExam } from "@shared/labs";
import { renderApp } from "@/test/render";
import { labCoverageFixture } from "@/test/fixtures";
import { card, labs } from "./testData";
import { fmtWhen } from "./model";

vi.setConfig({ testTimeout: 20_000 });
beforeAll(async () => {
  await import("@/views/labs");
});

const HERE = dirname(fileURLToPath(import.meta.url));

const ROLE: LabBlocker = { kind: "role", message: "Needs the governance role: run Check permissions in Settings → Labs." };
const GRAPH: LabBlocker = { kind: "graph", message: "Needs Graph users and groups: run Check permissions in Settings → Labs." };
const GITHUB: LabBlocker = { kind: "github", message: "GitHub is not connected, so labs can't be deployed." };
const BUDGET: LabBlocker = { kind: "budget", message: "This month's budget is used up (£20.00 of £20.00)." };

const lab = (n: number, exam: LabExam, blockers: LabBlocker[] = []): LabCard =>
  card({ id: `${exam.toLowerCase().replace("-", "")}-${String(n).padStart(2, "0")}-lab`, number: n, exam, exams: [exam], title: `Lab title ${n}`, blockers, unavailable: blockers[0]?.message ?? null, prerequisites: [] });

/** 12 labs: 9 need setup (6 AZ-104 with role or Graph, 3 AZ-305 with role), 3 AZ-104 ready. */
const twelve = (extra: LabBlocker[] = []) => [
  ...[1, 2, 3].map((n) => lab(n, "AZ-104", [ROLE, ...extra])),
  ...[4, 5, 6].map((n) => lab(n, "AZ-104", [GRAPH, ...extra])),
  ...[7, 8, 9].map((n) => lab(n, "AZ-104", extra)),
  ...[20, 21, 22].map((n) => lab(n, "AZ-305", [ROLE, ...extra])),
];

const routes = (over: Parameters<typeof labs>[0] = {}) => ({ "GET /api/v1/labs": labs({ labs: twelve(), ...over }), "GET /api/v1/labs/coverage": labCoverageFixture() });
const banner = async () => within(await screen.findByRole("region", { name: "Labs setup" }));

describe("the setup banner", () => {
  it("the banner counts all 9 affected labs while the exam filter shows 3", async () => {
    renderApp("/labs?exam=AZ-305", { routes: routes() });
    const b = await banner();
    expect(b.getByText("Some labs need additional Azure permissions.")).toBeInTheDocument();
    expect(b.getByText("9 of 12 labs are affected.")).toBeInTheDocument();
    await waitFor(() => expect(document.querySelectorAll("main article")).toHaveLength(3));
  });

  it("Complete setup links to /settings/labs", async () => {
    renderApp("/labs", { routes: routes() });
    const b = await banner();
    expect(b.getByRole("link", { name: "Complete setup" })).toHaveAttribute("href", "/settings/labs");
  });

  it("Hide hides the banner for the visit", async () => {
    const user = userEvent.setup();
    renderApp("/labs", { routes: routes() });
    const b = await banner();
    await user.click(b.getByRole("button", { name: "Hide" }));
    expect(screen.queryByRole("region", { name: "Labs setup" })).toBeNull();
  });

  it("last checked time or never checked", async () => {
    const checkedAt = "2026-10-01T09:30:00.000Z";
    const { unmount } = renderApp("/labs", { routes: routes({ permissions: { checkedAt, role: false, users: true, groups: true, message: null } }) });
    expect((await banner()).getByText(`Last checked ${fmtWhen(checkedAt)}`)).toBeInTheDocument();
    unmount();
    renderApp("/labs", { routes: routes() });
    expect((await banner()).getByText("Permissions have never been checked.")).toBeInTheDocument();
  });

  it("the permissions message is shown", async () => {
    const message = "The app registration lacks Group.ReadWrite.All on contoso.onmicrosoft.com.";
    renderApp("/labs", { routes: routes({ permissions: { checkedAt: "2026-10-01T09:30:00.000Z", role: true, users: false, groups: false, message } }) });
    expect((await banner()).getByText(message)).toBeInTheDocument();
  });

  it("no banner when no lab needs setup", async () => {
    renderApp("/labs", { routes: routes({ labs: [lab(7, "AZ-104"), lab(8, "AZ-104")] }) });
    await waitFor(() => expect(document.querySelectorAll("main article")).toHaveLength(2));
    expect(screen.queryByRole("region", { name: "Labs setup" })).toBeNull();
  });
});

describe("the other notices", () => {
  it("GitHub not connected shows its own notice and the banner still counts only role and Graph labs", async () => {
    // Every lab has the github blocker; 9 also need setup.
    renderApp("/labs", { routes: routes({ labs: twelve([GITHUB]) }) });
    const gh = within(await screen.findByRole("region", { name: "GitHub not connected" }));
    expect(gh.getByText("Labs can't be deployed: GitHub is not connected.")).toBeInTheDocument();
    expect(gh.getByRole("link", { name: "Open the setup checklist" })).toHaveAttribute("href", "/settings/overview");
    expect((await banner()).getByText("9 of 12 labs are affected.")).toBeInTheDocument();
  });

  it("the budget notice is separate", async () => {
    renderApp("/labs", { routes: routes({ labs: [lab(7, "AZ-104", [BUDGET]), lab(1, "AZ-104", [ROLE, BUDGET])] }) });
    const budget = within(await screen.findByRole("region", { name: "Budget reached" }));
    expect(budget.getByText(BUDGET.message)).toBeInTheDocument();
    expect(budget.getByRole("link", { name: "Review the budget" })).toHaveAttribute("href", "/settings/automation");
    // The banner is its own block and counts only the setup lab.
    const b = await banner();
    expect(b.getByText("1 of 2 labs are affected.")).toBeInTheDocument();
    expect(b.queryByText(BUDGET.message)).toBeNull();
  });

  it("notices come in order: leftovers, GitHub, budget, setup", async () => {
    const orphans = [{ labId: "az104-07-lab", names: ["rg-lab-az104-07-lab"], since: "2026-10-02T10:00:00.000Z" }];
    renderApp("/labs", { routes: routes({ labs: twelve([GITHUB, BUDGET]), orphans }) });
    await banner();
    const names = ["Lab leftovers", "GitHub not connected", "Budget reached", "Labs setup"];
    const regions = names.map((name) => screen.getByRole("region", { name }));
    for (let i = 1; i < regions.length; i++) expect(regions[i - 1]!.compareDocumentPosition(regions[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The leftovers notice is the target of a leftovers blocker's "Clean up" fix.
    expect(document.getElementById("labs-orphans")).toContainElement(regions[0]!);
  });
});

// ── Review Focus 5: tokens only, and the banner's text readable on its tint in both themes ──

const STYLES = join(HERE, "..", "..", "styles");
function block(css: string, selector: string): Record<string, string> {
  const i = css.indexOf(selector + " {");
  const body = css.slice(css.indexOf("{", i) + 1, css.indexOf("}", i));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}
const dark = block(readFileSync(join(STYLES, "tokens.css"), "utf8"), ":root");
const light = { ...dark, ...block(readFileSync(join(STYLES, "themes.css"), "utf8"), ':root[data-theme="light"]') };
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
/** color-mix(in srgb, a p%, b). */
const mix = (a: string, p: number, b: string) => rgb(a).map((x, i) => x * p + rgb(b)[i]! * (1 - p));
const lum = (c: number[]) => {
  const [r, g, b] = c.map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: number[], b: number[]) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};

describe("banner tokens and contrast", () => {
  const css = readFileSync(join(HERE, "LabsNotices.css"), "utf8");

  it("banner and badge text use --text-primary on the amber tint", () => {
    expect(css).toMatch(/\.labs-banner\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--amber\) 12%, var\(--bg-panel\)\)/);
    expect(css).toMatch(/\.labs-banner\s*\{[^}]*color:\s*var\(--text-primary\)/);
    expect(css).toMatch(/\.labs-banner__icon\s*\{[^}]*color:\s*var\(--amber\)/);
  });

  for (const [name, t] of Object.entries({ dark, light })) {
    it(`${name}: banner text is at least 4.5:1 and its icon 3:1 on the tint`, () => {
      const tint = mix(t["--amber"]!, 0.12, t["--bg-panel"]!);
      expect(contrast(rgb(t["--text-primary"]!), tint)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(rgb(t["--text-secondary"]!), tint)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(rgb(t["--amber"]!), tint)).toBeGreaterThanOrEqual(3);
    });
  }

  it("new labs CSS has no hex colours", () => {
    const mine = readdirSync(HERE).filter((f) => /^Lab(s[A-Z]\w*|CatalogueGrid|Card)\.css$/.test(f));
    expect(mine).toEqual(expect.arrayContaining(["LabsHeader.css", "LabsSummaryStrip.css", "LabsNotices.css"]));
    for (const f of mine) expect([f, readFileSync(join(HERE, f), "utf8").match(/#[0-9a-f]{3,8}\b/gi)]).toEqual([f, null]);
  });
});
