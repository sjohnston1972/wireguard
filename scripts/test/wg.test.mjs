import { test } from "node:test";
import assert from "node:assert/strict";
import { genKeypair, publicKeyFrom, isWgKey, parsePublicKey, renderClientConf } from "../lib/wg.mjs";

test("genKeypair produces 32-byte base64 keys and a matching public key", () => {
  const { privateKey, publicKey } = genKeypair();
  assert.ok(isWgKey(privateKey), "private key shape");
  assert.ok(isWgKey(publicKey), "public key shape");
  assert.equal(publicKeyFrom(privateKey), publicKey);
  assert.ok(parsePublicKey(publicKey));
});

test("publicKeyFrom matches the RFC 7748 X25519 base-point vector", () => {
  // RFC 7748 section 6.1: Alice's private key and public key.
  const priv = Buffer.from("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a", "hex").toString("base64");
  const pub = Buffer.from("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a", "hex").toString("base64");
  assert.equal(publicKeyFrom(priv), pub);
});

test("isWgKey rejects wrong lengths", () => {
  assert.equal(isWgKey("abc"), false);
  assert.equal(isWgKey(""), false);
  assert.equal(isWgKey(undefined), false);
});

test("renderClientConf uses the DNS endpoint and split-tunnel AllowedIPs", () => {
  const conf = renderClientConf({
    clientPrivateKey: "CLIENTPRIV=",
    clientIp: "10.13.13.2",
    serverPublicKey: "SERVERPUB=",
    endpoint: "wg.clydeford.net:51820",
    serverIp: "10.13.13.1",
    tunnelCidr: "10.13.13.0/24",
    homeLanCidr: "192.168.1.0/24",
  });
  assert.match(conf, /Endpoint = wg\.clydeford\.net:51820/);
  assert.match(conf, /AllowedIPs = 10\.13\.13\.1\/32, 10\.13\.13\.0\/24, 192\.168\.1\.0\/24/);
  assert.doesNotMatch(conf, /DNS =/);
  assert.match(conf, /PersistentKeepalive = 25/);
});

test("renderClientConf full tunnel pushes DNS and 0.0.0.0/0", () => {
  const conf = renderClientConf({
    clientPrivateKey: "CLIENTPRIV=",
    clientIp: "10.13.13.2",
    serverPublicKey: "SERVERPUB=",
    endpoint: "wg.clydeford.net:51820",
    serverIp: "10.13.13.1",
    fullTunnel: true,
  });
  assert.match(conf, /AllowedIPs = 0\.0\.0\.0\/0, ::\/0/);
  assert.match(conf, /DNS = 1\.1\.1\.1/);
});
