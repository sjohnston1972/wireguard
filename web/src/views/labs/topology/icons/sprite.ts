// views/labs/topology/icons/sprite.ts
//
// Plain English: the Azure icon sprite (lab topology spec ruling 20) is a
// hashed static asset, fetched once per visit and inlined into the page,
// hidden, because the icons' gradients only render reliably through
// same-document <use href="#az-..."> references. It is hidden by size, not
// display:none (a display:none SVG's gradients do not paint elsewhere).

import { useEffect } from "react";
import spriteUrl from "./azure.svg?url";

export const SPRITE_URL: string = spriteUrl;
const HOST_ID = "topo-sprite";

let loading: Promise<void> | null = null;

function inline(text: string): void {
  if (typeof document === "undefined" || document.getElementById(HOST_ID)) return;
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
  host.id = HOST_ID;
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none";
  host.appendChild(document.importNode(svg, true));
  document.body.appendChild(host);
}

/** Fetches and inlines the sprite once; later calls share the first. A failure is retried on the next call. */
export function ensureSprite(): Promise<void> {
  if (typeof document !== "undefined" && document.getElementById(HOST_ID)) return Promise.resolve();
  if (loading) return loading;
  loading = fetch(SPRITE_URL, { credentials: "same-origin" })
    .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
    .then(inline)
    .catch(() => {
      // Icons stay blank; the names and type words still say what everything is.
      loading = null;
    });
  return loading;
}

/** Inlines the sprite while a diagram is on screen. */
export function useSprite(): void {
  useEffect(() => {
    void ensureSprite();
  }, []);
}

/** Tests only: forget the sprite so the next diagram fetches it again. */
export function resetSpriteForTests(): void {
  loading = null;
  document.getElementById(HOST_ID)?.remove();
}
