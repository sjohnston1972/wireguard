import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { QrCode } from "./QrCode";

const conf = (n: number) =>
  `[Interface]\nPrivateKey = ${"A".repeat(43)}=\nAddress = 10.13.13.${n}/32\nDNS = 10.13.13.1\n\n[Peer]\nPublicKey = ${"B".repeat(43)}=\nAllowedIPs = 10.13.13.0/24, 192.0.2.0/24\nEndpoint = wg.example.net:51820\nPersistentKeepalive = 25\n`;

describe("QrCode", () => {
  it("draws an SVG image with the given name and size, with the 4-module quiet zone", () => {
    render(<QrCode value="hello" label="QR code for the test config" size={200} />);
    const img = screen.getByRole("img", { name: "QR code for the test config" });
    expect(img.tagName.toLowerCase()).toBe("svg");
    expect(img).toHaveAttribute("width", "200");
    expect(img).toHaveAttribute("height", "200");
    // "hello" fits QR version 1: 21 modules, plus 4 on each side.
    expect(img).toHaveAttribute("viewBox", "0 0 29 29");
    expect(img.querySelector("path")!.getAttribute("d")).toMatch(/^M\d/);
  });

  it("draws what it is given: the same text the same, other text differently", () => {
    const { container, rerender } = render(<QrCode value={conf(2)} label="qr" />);
    const first = container.querySelector("path")!.getAttribute("d");
    rerender(<QrCode value={conf(2)} label="qr" />);
    expect(container.querySelector("path")!.getAttribute("d")).toBe(first);
    rerender(<QrCode value={conf(3)} label="qr" />);
    expect(container.querySelector("path")!.getAttribute("d")).not.toBe(first);
    // A whole client config needs a bigger symbol than version 1.
    expect(Number(screen.getByRole("img", { name: "qr" }).getAttribute("viewBox")!.split(" ")[2])).toBeGreaterThan(29);
  });

  it("says so, instead of throwing, when the text is too long for a QR code", () => {
    render(<QrCode value={"x".repeat(5000)} label="qr" />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText(/too long for a QR code/i)).toBeInTheDocument();
  });
});
