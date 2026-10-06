// views/overview/LabMiniHover.tsx
//
// Plain English: a running lab's box on the Overview topology shows a small
// diagram of the lab when the mouse rests on it (or the keyboard focuses it)
// for 400 ms (lab topology spec §9.1): a 320 x 200 picture with no pan, zoom
// or drag, the person's saved arrangement, live data (the planned graph when
// the live view fails), and a caption. Escape closes it; the box stays a
// link to the lab. Pointer hover only on devices that can hover.
//
// The Overview is in the entry, so it reaches this file only through lazy(),
// and this file reaches the diagram's chunk only through lazy(), loaded the
// first time a mini opens.

import { cloneElement, lazy, Suspense, useEffect, useId, useRef, useState, type ReactElement } from "react";
import type { LabSession } from "@shared/api";

const LabMini = lazy(() => import("@/views/labs/topology").then((m) => ({ default: m.default.LabMini })));

/** How long the pointer (or focus) rests on the box before the mini opens. */
export const MINI_DELAY_MS = 400;

const canHover = () => typeof window.matchMedia === "function" && window.matchMedia("(hover: hover)").matches;

/** The popover's place: below the box, its right edge on the box's, kept inside the window (above the box when there is no room below). */
function placeFor(el: HTMLElement | null): { top: number; left: number } {
  const r = el?.getBoundingClientRect();
  if (!r) return { top: 0, left: 0 };
  const w = MINI_W;
  const h = MINI_H;
  const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
  const below = r.bottom + 6;
  const top = below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 6) : below;
  return { top, left };
}
/** The popover's outer size (a 320 x 200 diagram, its caption and padding). */
const MINI_W = 338;
const MINI_H = 250;

export default function LabMiniHover({ session, children }: { session: LabSession; children: ReactElement<{ "aria-describedby"?: string }> }) {
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const open = at !== null;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ref = useRef<HTMLSpanElement | null>(null);
  const id = useId();
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const later = () => {
    clear();
    timer.current = setTimeout(() => setAt(placeFor(ref.current)), MINI_DELAY_MS);
  };
  const close = () => {
    clear();
    setAt(null);
  };
  useEffect(() => clear, []);

  return (
    <span
      ref={ref}
      className="ov-lab__hover"
      onPointerEnter={(e) => {
        if (e.pointerType !== "touch" && canHover()) later();
      }}
      onPointerLeave={close}
      onFocus={later}
      onBlur={close}
      onKeyDown={(e) => {
        if (e.key === "Escape" && (open || timer.current)) {
          e.stopPropagation();
          close();
        }
      }}
    >
      {cloneElement(children, { "aria-describedby": open ? id : undefined })}
      {open && (
        <div role="tooltip" id={id} className="ov-mini" style={{ top: at.top, left: at.left }}>
          <Suspense
            fallback={
              <p className="ov-mini__loading" role="status">
                Loading the diagram…
              </p>
            }
          >
            <LabMini labId={session.labId} session={session} />
          </Suspense>
        </div>
      )}
    </span>
  );
}
