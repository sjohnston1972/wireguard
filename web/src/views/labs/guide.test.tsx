// "Download PDF" lab guides: the button in the details panel and in the lab dialog's Readme tab, its progress
// while the PDF is made, the saved file's name, actionable errors and demo mode.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { demoStatusFixture } from "@/test/fixtures";
import { ApiError, NetworkError, SessionExpiredError } from "@/api/client";
import { renderDetails } from "./details.harness";
import { GUIDE_DEMO_OFF, guideErrorWords } from "./LabGuideButton";
import { detailIdle, labs } from "./testData";

vi.setConfig({ testTimeout: 20_000 });
beforeAll(async () => {
  await import("@/views/labs");
});

const ID = "az104-06-blob-security";
const DETAIL = `GET /api/v1/labs/${ID}`;
const PDF = `GET /api/v1/labs/${ID}/guide.pdf`;
const pdfReply = () =>
  new Response(new Blob(["%PDF-1.7 fake"], { type: "application/pdf" }), {
    status: 200,
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${ID} guide.pdf"` },
  });

function captureSaves() {
  const saved: string[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    saved.push(this.download);
  });
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:wg-admin/guide"), revokeObjectURL: vi.fn() }));
  return saved;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const panel = () => within(screen.getByRole("complementary", { name: /Blob security/ }));
const openPanel = (routes: Record<string, unknown> = {}) => {
  const data = labs();
  return renderDetails(data, { url: `/labs?lab=${ID}`, routes: { [DETAIL]: detailIdle({ card: data.labs.find((c) => c.id === ID)! }), ...routes } });
};

describe("Download PDF in the details panel", () => {
  it("says Preparing PDF… while the guide is made, then saves '<lab id> guide.pdf'", async () => {
    const user = userEvent.setup();
    const saved = captureSaves();
    let release!: () => void;
    const r = openPanel({ [PDF]: () => new Promise<Response>((done) => (release = () => done(pdfReply()))) });
    const p = panel();
    expect(p.getByRole("heading", { name: "Lab guide" })).toBeInTheDocument();
    await user.click(p.getByRole("button", { name: "Download PDF" }));
    const busy = await p.findByRole("button", { name: "Preparing PDF…" });
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(p.getByRole("status")).toHaveTextContent(/Preparing the PDF guide/);
    release();
    await waitFor(() => expect(saved).toEqual([`${ID} guide.pdf`]));
    expect(await p.findByRole("button", { name: "Download PDF" })).not.toHaveAttribute("aria-busy");
    const call = r.fetchMock!.calls.find((c) => c.url === `/api/v1/labs/${ID}/guide.pdf`)!;
    expect(call.init.redirect).toBe("manual");
  });

  it("a refusal shows the server's words under the button (Browser Rendering not enabled); Retry works", async () => {
    const user = userEvent.setup();
    const saved = captureSaves();
    let n = 0;
    openPanel({
      [PDF]: () =>
        ++n === 1
          ? { status: 503, json: { error: { code: "guide_unavailable", message: "Browser Rendering could not make the PDF. Check that Browser Rendering is enabled for the Cloudflare account." } } }
          : pdfReply(),
    });
    const p = panel();
    await user.click(p.getByRole("button", { name: "Download PDF" }));
    expect(await p.findByRole("alert")).toHaveTextContent("Check that Browser Rendering is enabled for the Cloudflare account.");
    expect(saved).toEqual([]);
    await user.click(p.getByRole("button", { name: "Download PDF" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(p.queryByRole("alert")).toBeNull();
  });

  it("in demo mode the button is off, saying why", async () => {
    openPanel({ "GET /api/v1/demo": demoStatusFixture({ on: true }) });
    const b = panel().getByRole("button", { name: "Download PDF" });
    await waitFor(() => expect(b).toBeDisabled());
    expect(b).toHaveAttribute("title", GUIDE_DEMO_OFF);
  });
});

describe("Download PDF in the lab dialog", () => {
  it("sits above the readme in the Readme tab", async () => {
    const user = userEvent.setup();
    const saved = captureSaves();
    renderApp(`/labs/${ID}`, { routes: { "GET /api/v1/labs": labs(), [DETAIL]: detailIdle(), [PDF]: () => pdfReply() } });
    const dialog = within(await screen.findByRole("dialog", { name: /Blob security/ }));
    const tab = within(dialog.getByRole("tabpanel"));
    const button = tab.getByRole("button", { name: "Download PDF" });
    expect(button.compareDocumentPosition(tab.getByRole("article", { name: "Readme" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.click(button);
    await waitFor(() => expect(saved).toEqual([`${ID} guide.pdf`]));
  });
});

describe("guideErrorWords", () => {
  it("says what to do next for each kind of failure", () => {
    expect(guideErrorWords(new SessionExpiredError())).toMatch(/Reload the page to sign in again/);
    expect(guideErrorWords(new NetworkError())).toMatch(/Check your connection/);
    expect(guideErrorWords(new ApiError(404, "not_found", "No such lab."))).toMatch(/no longer in the catalogue/);
    expect(guideErrorWords(new ApiError(503, "guide_busy", "This lab's PDF is being made by another request. Try again in a few seconds."))).toMatch(/Try again in a few seconds/);
    expect(guideErrorWords(new Error("x"))).toMatch(/Try again/);
  });
});
