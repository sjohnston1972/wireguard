import { afterEach, describe, expect, it, vi } from "vitest";
import { createPrivateKey, createPublicKey, webcrypto } from "node:crypto";
import { NO_WEBCRYPTO, NO_X25519, confFileName, fillConfig, genKeypair } from "./wgkeys";

afterEach(() => vi.unstubAllGlobals());

const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** The X25519 public key for a raw 32-byte private key, worked out by Node independently of WebCrypto. */
function publicFor(privateB64: string): string {
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), Buffer.from(bytes(privateB64))]);
  const spki = createPublicKey(createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" })).export({ format: "der", type: "spki" });
  return Buffer.from(spki.subarray(spki.length - 32)).toString("base64");
}

describe("genKeypair", () => {
  it("makes a WireGuard key pair: 32-byte standard base64 keys, the public one derived from the private one", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const a = await genKeypair();
    const b = await genKeypair();
    for (const k of [a.privateKey, a.publicKey]) {
      expect(k).toMatch(/^[A-Za-z0-9+/]{43}=$/);
      expect(bytes(k)).toHaveLength(32);
    }
    expect(a.publicKey).toBe(publicFor(a.privateKey));
    expect(b.privateKey).not.toBe(a.privateKey);
  });

  it("says so when the browser cannot make X25519 keys", async () => {
    vi.stubGlobal("crypto", { subtle: { generateKey: () => Promise.reject(new DOMException("Unrecognized name.", "NotSupportedError")) } });
    await expect(genKeypair()).rejects.toThrow(NO_X25519);
    expect(NO_X25519).toBe(
      "This browser cannot make X25519 keys yet (needs Chrome 133+, Safari 17+ or Firefox 130+). Try another browser, or make the peer with 'npm run peer' on the laptop.",
    );
  });

  it("says so when the browser has no WebCrypto at all (an insecure origin)", async () => {
    vi.stubGlobal("crypto", {});
    await expect(genKeypair()).rejects.toThrow(NO_WEBCRYPTO);
  });
});

describe("confFileName", () => {
  it.each([
    ["Dev laptop (work) 2026", "dev-laptop-work.conf"],
    ["Phone", "phone.conf"],
    ["test_vm-2", "test_vm-2.conf"],
    ["abcdefghijklmn op", "abcdefghijklmn.conf"], // cut at 15 leaves a trailing dash: trimmed
    ["  --Tablet--  ", "tablet.conf"],
    ["***", "client.conf"],
  ])("%s -> %s (the WireGuard apps name the tunnel after it: at most 15 letters, digits, - or _)", (name, file) => {
    expect(confFileName(name)).toBe(file);
    expect(file.replace(/\.conf$/, "").length).toBeLessThanOrEqual(15);
  });
});

describe("fillConfig", () => {
  it("puts the private key where the server's template asks for it", () => {
    const t = "[Interface]\nPrivateKey = __CLIENT_PRIVATE_KEY__\nAddress = 10.13.13.9/32\n";
    expect(fillConfig(t, "cHJpdmF0ZQ==")).toBe("[Interface]\nPrivateKey = cHJpdmF0ZQ==\nAddress = 10.13.13.9/32\n");
  });
});
