import { afterEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { downloadText } from "./download";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("downloadText", () => {
  it("saves text made in the browser as a file, sends nothing, and lets go of the blob", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const clicked: { href: string; download: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, download: this.download });
    });
    const blobs: Blob[] = [];
    const create = vi.fn((b: Blob) => {
      blobs.push(b);
      return "blob:wg-admin/conf";
    });
    const revoke = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));

    downloadText("laptop.conf", "[Interface]\nPrivateKey = abc\n");

    expect(clicked).toEqual([{ href: "blob:wg-admin/conf", download: "laptop.conf" }]);
    expect(blobs[0]!.type).toBe("text/plain");
    expect(await blobs[0]!.text()).toBe("[Interface]\nPrivateKey = abc\n");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(document.querySelector("a[download]")).toBeNull();
    await waitFor(() => expect(revoke).toHaveBeenCalledWith("blob:wg-admin/conf"));
  });
});
