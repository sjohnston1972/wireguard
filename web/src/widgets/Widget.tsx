// widgets/Widget.tsx
//
// Plain English: the frame that makes a panel a widget. It adds nothing but
// the settings cog and, where the widget can move, the move handle, each
// marked data-widget-chrome, and renders nothing at all when the widget is
// hidden. The panel inside draws the chrome (see Panel's PanelChromeContext):
// in its header (handle at the left as an overlay, cog after its own
// actions), or as an overlay in its corners. A block that is not a Panel
// puts <WidgetCorner /> inside itself instead.
//
// Moving: drag the handle onto another widget of the same row (native drag
// and drop, data type WIDGET_DRAG_TYPE, so other drags on the page, such as
// the firewall rules table's, are never taken for a widget), or Alt+Left /
// Alt+Right on the handle. Desktop only: the phone keeps its own order.

import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { GripVertical } from "lucide-react";
import { PanelChromeContext, useIsPhone, type PanelChrome } from "@/components";
import { widgetDef, type PageId } from "@shared/widgets";
import { useWidget } from "./useWidget";
import { usePrefsStatus, usePrefsStore } from "./usePrefs";
import { WidgetCog, announceMove } from "./WidgetCog";
import { dropKey, dropMove, type DragItem } from "./layout";
import { useArranged } from "./arrangement";
import "./widgets.css";

/** The drag data type a widget's handle sets; drops without it are ignored. */
export const WIDGET_DRAG_TYPE = "application/x-wg-widget";

/** The drag in progress (dragover cannot read the data itself, only its types). */
let dragging: (DragItem & { page: PageId }) | null = null;
/** The widget whose handle should have focus after its row re-renders. */
let focusAfterMove: string | null = null;

export interface WidgetProps {
  /** The widget's id in shared/widgets.ts, for example "overview.keyMetrics". */
  id: string;
  /** Put the chrome in the corner overlay even if the panel has a header (status banner, tile rows, tables). */
  headerless?: boolean;
  /**
   * This block draws its whole stack (a tabbed column showing one member at
   * a time): it carries the stack's move handle whichever member it shows.
   */
  stackHandle?: boolean;
  children: ReactNode;
}

export function Widget({ id, headerless = false, stackHandle = false, children }: WidgetProps) {
  const w = useWidget(id);
  const chrome = useMemo<PanelChrome>(
    () => ({
      handle: (
        <>
          <DropAnchor id={id} />
          <WidgetHandle id={id} stackHandle={stackHandle} />
        </>
      ),
      cog: <WidgetCog id={id} />,
      corner: (
        <div className="wg-corner" data-widget-chrome="">
          <DropAnchor id={id} />
          <WidgetHandle id={id} stackHandle={stackHandle} />
          <span className="wg-corner__end">
            <WidgetCog id={id} />
          </span>
        </div>
      ),
      headerless,
    }),
    [id, headerless, stackHandle],
  );
  if (w.hidden) return null;
  return <PanelChromeContext.Provider value={chrome}>{children}</PanelChromeContext.Provider>;
}

/** The class of the element a corner overlay sits in: its positioning box (widgets.css). */
export const CORNER_HOST = "wg-corner-host";

/**
 * The class for the root element of a block that holds <WidgetCorner />
 * (CORNER_HOST inside a <Widget>, where the corner is drawn; undefined
 * elsewhere), so only those blocks become the corner's positioning box.
 */
export function useCornerHost(): string | undefined {
  return useContext(PanelChromeContext) ? CORNER_HOST : undefined;
}

/**
 * The corner overlay (cog, and the move handle where the widget can move)
 * for a headerless widget that is not a Panel: put it inside the block's
 * root element, which becomes its positioning box (give that element the
 * class from useCornerHost()). Nothing outside a <Widget>.
 */
export function WidgetCorner() {
  const c = useContext(PanelChromeContext);
  return c ? <>{c.corner}</> : null;
}

/**
 * The grip: drag it, or Alt+Arrow on it. Only where the widget can move, and
 * never on the phone. In a stack it moves the whole stack ("Move ‹title›
 * column"), and only the stack's top widget carries it.
 */
function WidgetHandle({ id, stackHandle }: { id: string; stackHandle: boolean }) {
  const w = useWidget(id);
  const phone = useIsPhone();
  const ref = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (focusAfterMove === id && ref.current) {
      focusAfterMove = null;
      ref.current.focus();
    }
  });
  const { movable, row, item } = w.canMove;
  const ofStack = item !== id;
  if (phone || !movable || !row || !item || !(w.canMove.handle || (ofStack && stackHandle))) return null;
  const name = ofStack ? `${w.def.title} column` : w.def.title;
  const move = (dir: "left" | "right") => {
    const { index, count } = w.canMove;
    if (!w.move(dir)) return;
    focusAfterMove = id;
    announceMove(name, index, count, dir);
  };
  return (
    <button
      ref={ref}
      type="button"
      className="wg-handle"
      data-widget-chrome=""
      aria-label={`Move ${name}`}
      title={`Move ${name} (drag, or Alt+Left and Alt+Right)`}
      draggable={!w.readOnly}
      onKeyDown={(e) => {
        if (!e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
        e.preventDefault();
        move(e.key === "ArrowLeft" ? "left" : "right");
      }}
      onDragStart={(e) => {
        dragging = { page: w.def.page, row, key: item };
        const dt = e.dataTransfer;
        if (dt) {
          dt.effectAllowed = "move";
          dt.setData(WIDGET_DRAG_TYPE, JSON.stringify(dragging));
          const host = ref.current?.closest(".panel") ?? ref.current?.closest(".wg-corner")?.parentElement;
          if (host) dt.setDragImage?.(host, 24, 16);
        }
      }}
      onDragEnd={() => {
        dragging = null;
      }}
    >
      <GripVertical size={14} aria-hidden />
    </button>
  );
}

/**
 * Makes the widget's own box a drop target for widget drags from the same
 * row. Renders a hidden marker (chrome) to find that box: the panel, or the
 * block holding the corner overlay.
 */
function DropAnchor({ id }: { id: string }) {
  const [el, setEl] = useState<HTMLSpanElement | null>(null);
  const def = widgetDef(id)!;
  const page = def.page;
  const status = usePrefsStatus();
  const store = usePrefsStore();
  const reg = useArranged();
  const phone = useIsPhone();
  const active = status === "ready" && !phone;
  useEffect(() => {
    const host = el ? ((el.closest(".wg-corner")?.parentElement ?? el.closest(".panel")) as HTMLElement | null) : null;
    const target = dropKey(page, id, reg);
    if (!host || !target || !active) return;
    const accepted = (e: DragEvent): (DragItem & { page: PageId }) | null => {
      const dt = e.dataTransfer;
      if (dt && !Array.from(dt.types ?? []).includes(WIDGET_DRAG_TYPE)) return null;
      let d = dragging;
      if (!d && dt) {
        try {
          d = JSON.parse(dt.getData(WIDGET_DRAG_TYPE)) as DragItem & { page: PageId };
        } catch {
          d = null;
        }
      }
      if (!d || d.page !== page || d.row !== target.row || d.key === target.key) return null;
      return d;
    };
    const over = (e: DragEvent) => {
      if (!accepted(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    };
    const drop = (e: DragEvent) => {
      const d = accepted(e);
      if (!d) return;
      e.preventDefault();
      dragging = null;
      store.change(page, (p) => dropMove(page, p, d, id, reg) ?? p);
    };
    host.addEventListener("dragover", over);
    host.addEventListener("drop", drop);
    return () => {
      host.removeEventListener("dragover", over);
      host.removeEventListener("drop", drop);
    };
  }, [el, page, id, store, active, reg]);
  return <span hidden data-widget-chrome="" ref={setEl} />;
}
