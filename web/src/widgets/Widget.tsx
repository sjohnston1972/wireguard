// widgets/Widget.tsx
//
// Plain English: the frame that makes a panel a widget. It adds nothing but
// the settings cog (and, where the widget can move, the move handle), each
// marked data-widget-chrome, and renders nothing at all when the widget is
// hidden. The panel inside draws the chrome (see Panel's PanelChromeContext):
// in its header after its own actions, or as an overlay in its corner. A
// block that is not a Panel puts <WidgetCorner /> inside itself instead.

import { useContext, useMemo, type ReactNode } from "react";
import { PanelChromeContext, type PanelChrome } from "@/components";
import { useWidget } from "./useWidget";
import { WidgetCog } from "./WidgetCog";
import "./widgets.css";

export interface WidgetProps {
  /** The widget's id in shared/widgets.ts, for example "overview.keyMetrics". */
  id: string;
  /** Put the chrome in the corner overlay even if the panel has a header (status banner, tile rows, tables). */
  headerless?: boolean;
  children: ReactNode;
}

export function Widget({ id, headerless = false, children }: WidgetProps) {
  const w = useWidget(id);
  const chrome = useMemo<PanelChrome>(
    () => ({
      handle: null,
      cog: <WidgetCog id={id} />,
      corner: (
        <div className="wg-corner" data-widget-chrome="">
          <span className="wg-corner__end">
            <WidgetCog id={id} />
          </span>
        </div>
      ),
      headerless,
    }),
    [id, headerless],
  );
  if (w.hidden) return null;
  return <PanelChromeContext.Provider value={chrome}>{children}</PanelChromeContext.Provider>;
}

/**
 * The corner overlay (cog, and the move handle where the widget can move)
 * for a headerless widget that is not a Panel: put it inside the block's
 * root element; the block becomes its positioning box. Nothing outside a <Widget>.
 */
export function WidgetCorner() {
  const c = useContext(PanelChromeContext);
  return c ? <>{c.corner}</> : null;
}
