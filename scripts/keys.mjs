// scripts/keys.mjs   (npm run keys [-- --rotate])
//
// Plain English: makes the server's WireGuard keypair and writes it into .env.
// It refuses to overwrite an existing key unless you pass --rotate, because
// every client trusts the public half: rotating it means reissuing every
// phone and laptop config.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { genKeypair, publicKeyFrom, isWgKey } from "./lib/wg.mjs";
import { parseEnv, upsertEnvLine } from "./lib/env.mjs";

const rotate = process.argv.includes("--rotate");
const path = ".env";

if (!existsSync(path)) {
  console.error(".env not found. Copy .env.example to .env first.");
  process.exit(1);
}

let text = readFileSync(path, "utf8");
const env = parseEnv(text);

if (isWgKey(env.WG_SERVER_PRIVATE_KEY) && !rotate) {
  const pub = publicKeyFrom(env.WG_SERVER_PRIVATE_KEY);
  if (env.WG_SERVER_PUBLIC_KEY !== pub) {
    text = upsertEnvLine(text, "WG_SERVER_PUBLIC_KEY", pub);
    writeFileSync(path, text);
    console.log("WG_SERVER_PRIVATE_KEY already set; corrected WG_SERVER_PUBLIC_KEY to match.");
  } else {
    console.log("WG_SERVER_PRIVATE_KEY already set. Nothing to do.");
  }
  console.log(`Server public key: ${pub}`);
  console.log("To deliberately replace it (and reissue EVERY client): npm run keys -- --rotate");
  process.exit(0);
}

if (rotate && isWgKey(env.WG_SERVER_PRIVATE_KEY)) {
  console.warn("WARNING: rotating the server key. Every existing client config stops working.");
}

const { privateKey, publicKey } = genKeypair();
text = upsertEnvLine(text, "WG_SERVER_PRIVATE_KEY", privateKey);
text = upsertEnvLine(text, "WG_SERVER_PUBLIC_KEY", publicKey);
writeFileSync(path, text);
console.log(`New server keypair written to .env. Public key: ${publicKey}`);
console.log("Next: npm run secrets   (pushes the private key to GitHub and the Worker)");
