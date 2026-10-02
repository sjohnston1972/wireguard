// WireGuard keys made in the browser (ported from worker/public/app.js).
// The private key never leaves the page: the server gets the public key and
// answers with a config template; fillConfig puts the private key into it for
// the QR code and the .conf download only.

export const NO_WEBCRYPTO = "This browser has no WebCrypto. Use a current Chrome, Safari or Firefox.";
export const NO_X25519 =
  "This browser cannot make X25519 keys yet (needs Chrome 133+, Safari 17+ or Firefox 130+). Try another browser, or make the peer with 'npm run peer' on the laptop.";

/** Where the server's config template wants the private key. */
export const PRIVATE_KEY_SLOT = "__CLIENT_PRIVATE_KEY__";

export interface WgKeypair {
  /** 32 bytes, standard base64, as WireGuard writes keys. */
  privateKey: string;
  publicKey: string;
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
function b64urlToBytes(s: string): Uint8Array {
  let t = s.replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  return Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
}

/** A fresh X25519 key pair. Throws Error(NO_WEBCRYPTO) or Error(NO_X25519) when the browser cannot. */
export async function genKeypair(): Promise<WgKeypair> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error(NO_WEBCRYPTO);
  let kp: CryptoKeyPair;
  try {
    kp = (await subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  } catch {
    throw new Error(NO_X25519);
  }
  const jwk = await subtle.exportKey("jwk", kp.privateKey);
  if (!jwk.d || !jwk.x) throw new Error(NO_X25519);
  return { privateKey: b64(b64urlToBytes(jwk.d)), publicKey: b64(b64urlToBytes(jwk.x)) };
}

/**
 * The .conf file name for a client. The WireGuard apps name the tunnel after
 * the file: letters, digits, dashes and underscores, at most 15 characters on
 * Windows. "client.conf" when nothing usable is left.
 */
export function confFileName(name: string): string {
  const trim = (s: string) => s.replace(/^-+|-+$/g, "");
  const stem = trim(trim(name.replace(/[^a-z0-9_-]+/gi, "-")).slice(0, 15)).toLowerCase();
  return (stem || "client") + ".conf";
}

/** The finished config: the server's template with the browser's private key in place. */
export function fillConfig(template: string, privateKey: string): string {
  return template.split(PRIVATE_KEY_SLOT).join(privateKey);
}
