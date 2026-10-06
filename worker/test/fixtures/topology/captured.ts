// captured.ts: the Resource Graph rows captured from real running labs (scripts/topology-capture.mjs →
// fixtures/topology/live/captured/<lab id>.json), shared by the tests that read them.

import { readFileSync } from "node:fs";
import type { ArgRow } from "../../../../shared/topology/live";

/** The captured labs and the name prefix their session had. */
export const CAPTURED: Record<string, string> = { "az104-14-peering-udr": "l14rt7xy", "az700-43-private-link": "l43qvmkk" };

/** The captured slot: both labs ran in slot 31's /18. */
export const CAPTURED_SLOT = "10.71.192.0/18";

export const capturedRows = (labId: string): ArgRow[] => (JSON.parse(readFileSync(new URL(`./live/captured/${labId}.json`, import.meta.url), "utf8")) as { rows: ArgRow[] }).rows;
