// scripts/keys.mjs   (npm run keys [-- --rotate])
//
// Plain English: makes the server's WireGuard keypair and writes it into .env.
// It refuses to overwrite an existing key unless you pass --rotate, because
// every client trusts the public half: rotating it means reissuing every
// phone and laptop config. A rotation asks you to type "rotate" first (or
// pass --yes), and keeps the old keys in .env as commented-out lines. The
// private key is never printed. The full rotation steps are on the
// dashboard's Settings page, under Server key.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { genKeypair, publicKeyFrom, isWgKey } from "./lib/wg.mjs";
import { parseEnv, upsertEnvLine, backupEnvLine } from "./lib/env.mjs";

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

const replacing = rotate && isWgKey(env.WG_SERVER_PRIVATE_KEY);
if (replacing) {
  console.warn("WARNING: rotating the server key. Every existing client config stops working");
  console.warn("until that device gets a new one from the dashboard.");
  if (!process.argv.includes("--yes")) {
    if (!process.stdin.isTTY) {
      console.error("Not rotating: run it in a terminal to confirm, or add --yes.");
      process.exit(1);
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question('Type "rotate" to go ahead: ')).trim();
    rl.close();
    if (answer !== "rotate") {
      console.log("Not rotated. Nothing changed.");
      process.exit(1);
    }
  }
  // Keep the old pair as comments, so going back is a matter of editing .env.
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  text = backupEnvLine(text, "WG_SERVER_PRIVATE_KEY", `replaced ${stamp}`);
  text = backupEnvLine(text, "WG_SERVER_PUBLIC_KEY", `replaced ${stamp}`);
}

const { privateKey, publicKey } = genKeypair();
text = upsertEnvLine(text, "WG_SERVER_PRIVATE_KEY", privateKey);
text = upsertEnvLine(text, "WG_SERVER_PUBLIC_KEY", publicKey);
writeFileSync(path, text);
console.log(`New server keypair written to .env. Public key: ${publicKey}`);
if (replacing) {
  console.log("The old keys are kept in .env as commented-out lines.");
  console.log("Next:");
  console.log(`  1. Put the public key above in wrangler.toml: WG_SERVER_PUBLIC_KEY = "${publicKey}"`);
  console.log("  2. npm run secrets          (sends the new private key to GitHub for the VM build)");
  console.log("  3. npm run deploy-worker    (the dashboard then flags every client for a new config)");
  console.log("  4. Tear the VM down and deploy again if it is running or in Standby.");
  console.log("  5. Get config for each client on the Clients page. Settings > Server key has the checklist.");
} else {
  console.log(`Next: put the public key in wrangler.toml (WG_SERVER_PUBLIC_KEY), then npm run secrets`);
}
