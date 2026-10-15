// views/labs/topology/icons/sprite.ts
//
// Plain English: the icon sprites (lab topology spec ruling 20): Azure's
// (azure.svg, symbols az-<icon>) and, for AWS labs, AWS's (aws.svg, symbols
// aws-<icon>, AWS labs spec §10). Each is a hashed static asset, fetched once
// per visit and inlined into the page, hidden, because the icons' gradients
// only render reliably through same-document <use href="#..."> references.
// Hidden by size, not display:none (a display:none SVG's gradients do not
// paint elsewhere). The AWS sprite loads only when a caller asks for it.

import { useEffect } from "react";
import spriteUrl from "./azure.svg?url";
import awsSpriteUrl from "./aws.svg?url";

export type SpriteCloud = "azure" | "aws";

export const SPRITE_URL: string = spriteUrl;
export const AWS_SPRITE_URL: string = awsSpriteUrl;

const SPRITES: Record<SpriteCloud, { hostId: string; url: string }> = {
  azure: { hostId: "topo-sprite", url: spriteUrl },
  aws: { hostId: "topo-sprite-aws", url: awsSpriteUrl },
};

const loading: Partial<Record<SpriteCloud, Promise<void>>> = {};

function inline(text: string, hostId: string): void {
  if (typeof document === "undefined" || document.getElementById(hostId)) return;
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const svg = doc.documentElement;
  if (svg.nodeName.toLowerCase() !== "svg") return;
  // Our own asset, but keep it to shapes: no scripts, no event handlers.
  svg.querySelectorAll("script, foreignObject").forEach((el) => el.remove());
  svg.removeAttribute("style");
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.setAttribute("focusable", "false");
  const host = document.createElement("div");
  host.id = hostId;
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none";
  host.appendChild(document.importNode(svg, true));
  document.body.appendChild(host);
}

function ensureOne(cloud: SpriteCloud): Promise<void> {
  const { hostId, url } = SPRITES[cloud];
  if (typeof document !== "undefined" && document.getElementById(hostId)) return Promise.resolve();
  const hit = loading[cloud];
  if (hit) return hit;
  const p = fetch(url, { credentials: "same-origin" })
    .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
    .then((text) => inline(text, hostId))
    .catch(() => {
      // Icons stay blank; the names and type words still say what everything is.
      delete loading[cloud];
    });
  loading[cloud] = p;
  return p;
}

/** Fetches and inlines the sprites asked for (Azure's by default) once; later calls share the first. A failure is retried on the next call. */
export async function ensureSprite(clouds: readonly SpriteCloud[] = ["azure"]): Promise<void> {
  await Promise.all([...new Set(clouds)].map(ensureOne));
}

/** Inlines the sprites while a diagram is on screen. */
export function useSprite(clouds: readonly SpriteCloud[] = ["azure"]): void {
  const key = [...new Set(clouds)].sort().join(",");
  useEffect(() => {
    void ensureSprite(key.split(",") as SpriteCloud[]);
  }, [key]);
}

/** Tests only: forget the sprites so the next diagram fetches them again. */
export function resetSpriteForTests(): void {
  for (const c of Object.keys(SPRITES) as SpriteCloud[]) {
    delete loading[c];
    document.getElementById(SPRITES[c].hostId)?.remove();
  }
}
