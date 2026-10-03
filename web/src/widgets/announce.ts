// widgets/announce.ts
//
// Plain English: says a layout change out loud to screen readers ("Last run
// moved to position 2 of 3") through one polite live region, made on first use.

export function announce(text: string): void {
  if (typeof document === "undefined") return;
  let el = document.querySelector<HTMLElement>("[data-wg-announcer]");
  if (!el) {
    el = document.createElement("div");
    el.setAttribute("data-wg-announcer", "");
    el.setAttribute("aria-live", "polite");
    el.setAttribute("aria-atomic", "true");
    el.className = "visually-hidden";
    document.body.appendChild(el);
  }
  el.textContent = text;
}
