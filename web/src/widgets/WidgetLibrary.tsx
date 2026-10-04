// widgets/WidgetLibrary.tsx
//
// Plain English: the Layout menu's Add widgets… (insights spec 9.2). Every
// widget of the page, by row, with its icon, title, one-line description
// and an On/Off switch; pinned widgets read "Always on". On puts a widget
// in its home row at its declared place; when that row (or column) is full
// it asks which widget to replace instead (ReplaceModal), so a row never
// shows more than it does as shipped. Off is the same as Hide. A centred
// dialog on the desktop, a bottom sheet on the phone (Drawer "auto").

import { useId, useState } from "react";
import * as RadixSwitch from "@radix-ui/react-switch";
import { Activity, CloudAlert, Gauge, HeartPulse, History, LayoutGrid, ShieldAlert } from "lucide-react";
import { PAGE_TITLES, REGISTRY, pageWidgets, widgetDef, type LayoutItem, type PageId } from "@shared/widgets";
import { Drawer } from "@/components";
import { useWidget } from "./useWidget";
import { usePagePrefs } from "./usePrefs";
import { ReplaceModal, rowLabel, type ReplaceAsk } from "./ReplaceModal";

/** The library's icons by WidgetDef.icon name; a widget without one gets the Layout icon. */
const ICONS = { Activity, CloudAlert, Gauge, HeartPulse, History, ShieldAlert };

/** The page's widgets grouped by top-level row, each in declared order (stacks and nested rows included). */
function groups(page: PageId): { row: string; ids: string[] }[] {
  const rows = REGISTRY.layouts[page]?.rows ?? [];
  const expand = (items: LayoutItem[]): string[] =>
    items.flatMap((it) => ("widget" in it ? [it.widget] : it.widgets.flatMap((m) => expand(rows.find((r) => r.id === m)?.items ?? [{ widget: m, weight: 1 }]))));
  const out = rows.filter((r) => !r.in).map((r) => ({ row: r.id, ids: expand(r.items).filter((id) => widgetDef(id)) }));
  const placed = new Set(out.flatMap((g) => g.ids));
  const rest = pageWidgets(page).filter((w) => !placed.has(w.id)).map((w) => w.id);
  return rest.length ? [...out, { row: "", ids: rest }] : out;
}

function LibraryItem({ id, onFull }: { id: string; onFull: (ask: ReplaceAsk) => void }) {
  const w = useWidget(id);
  const desc = useId();
  const Icon = ICONS[w.def.icon as keyof typeof ICONS] ?? LayoutGrid;
  return (
    <li className="wg-lib__item">
      <span className="wg-lib__icon" aria-hidden>
        <Icon size={16} />
      </span>
      <span className="wg-lib__text">
        <span className="wg-lib__title">{w.def.title}</span>
        <span className="wg-lib__desc" id={desc}>
          {w.def.description}
        </span>
      </span>
      {w.def.pinned && <span className="wg-lib__always">Always on</span>}
      <RadixSwitch.Root
        className="switch"
        checked={!w.hidden}
        disabled={w.def.pinned || w.readOnly}
        aria-label={w.def.title}
        aria-describedby={desc}
        onCheckedChange={(on) => {
          if (!on) return w.disable();
          const r = w.enable();
          if (!r.ok && r.full) onFull({ id, candidates: r.candidates, suggestion: r.suggestion });
        }}
      >
        <RadixSwitch.Thumb className="switch__thumb" />
      </RadixSwitch.Root>
    </li>
  );
}

export function WidgetLibrary({ page, open, onOpenChange }: { page: PageId; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { status } = usePagePrefs(page);
  const [ask, setAsk] = useState<ReplaceAsk | null>(null);
  const base = useId();
  return (
    <>
      <Drawer open={open} onOpenChange={onOpenChange} title="Add widgets" subtitle={`${PAGE_TITLES[page]}: turn widgets on or off. A full row asks which one to replace.`} className="wg-lib">
        {status === "failed" && <p className="wg-settings__note">Widget settings couldn't be loaded, so changes can't be saved right now.</p>}
        {groups(page).map((g, i) => (
          <section key={g.row} className="wg-lib__group">
            <h3 className="wg-form__title" id={`${base}${i}`}>
              {rowLabel(g.row)}
            </h3>
            <ul className="wg-lib__list" aria-labelledby={`${base}${i}`}>
              {g.ids.map((id) => (
                <LibraryItem key={id} id={id} onFull={setAsk} />
              ))}
            </ul>
          </section>
        ))}
      </Drawer>
      {ask && <ReplaceModal ask={ask} onClose={() => setAsk(null)} />}
    </>
  );
}
