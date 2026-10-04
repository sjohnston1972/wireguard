// widgets/LayoutMenu.tsx
//
// Plain English: the page header's Layout menu. Add widgets… opens the
// page's widget library (WidgetLibrary: every widget with an On/Off switch).
// Reset this page asks first (a dialog, never confirm()) and then puts the
// page's order, hidden widgets and every widget's settings back as they
// ship, which turns every added widget off. On the phone it also has Widget
// settings: every widget on the page, each opening its settings, including
// widgets the phone's own layout does not show (a default-off widget only
// while it is turned on).

import { useState } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { ChevronLeft, LayoutGrid } from "lucide-react";
import { PAGE_TITLES, isVisible, pageWidgets, type PageId } from "@shared/widgets";
import { Button, Modal, Sheet, useIsPhone } from "@/components";
import { usePagePrefs, usePrefsStore } from "./usePrefs";
import { WidgetSettings } from "./WidgetCog";
import { WidgetLibrary } from "./WidgetLibrary";

export function LayoutMenu({ page }: { page: PageId }) {
  const phone = useIsPhone();
  const { prefs, status } = usePagePrefs(page);
  const store = usePrefsStore();
  const readOnly = status !== "ready";
  const [confirming, setConfirming] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [current, setCurrent] = useState<string | null>(null);
  const widgets = pageWidgets(page);
  const pageName = PAGE_TITLES[page];
  const currentDef = widgets.find((w) => w.id === current);

  return (
    <span className="wg-layout" data-widget-chrome="">
      <Menu.Root>
        <Menu.Trigger asChild>
          <Button size="sm" icon={<LayoutGrid size={15} aria-hidden />} data-wg-layout={page}>
            Layout
          </Button>
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content className="menu wg-layout-menu" align="end" sideOffset={4}>
            <Menu.Item className="menu__item" onSelect={() => setLibraryOpen(true)}>
              Add widgets…
            </Menu.Item>
            {phone && (
              <Menu.Item
                className="menu__item"
                onSelect={() => {
                  setCurrent(null);
                  setListOpen(true);
                }}
              >
                Widget settings
              </Menu.Item>
            )}
            <Menu.Item className="menu__item" disabled={readOnly} onSelect={() => setConfirming(true)}>
              Reset this page…
            </Menu.Item>
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>

      <Modal
        open={confirming}
        onOpenChange={setConfirming}
        title={`Reset ${pageName} to its default layout and settings?`}
        description="Every widget on this page comes back, in its usual place, with its usual settings. Widgets you added are turned off."
        footer={
          <>
            <Button onClick={() => setConfirming(false)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => {
                store.change(page, () => ({}));
                setConfirming(false);
              }}
            >
              Reset
            </Button>
          </>
        }
      />

      <WidgetLibrary page={page} open={libraryOpen} onOpenChange={setLibraryOpen} />

      {phone && (
        <Sheet open={listOpen} onOpenChange={setListOpen} title={currentDef ? `${currentDef.title} settings` : `${pageName} widget settings`} className="wg-sheet">
          {currentDef ? (
            <>
              <Button size="sm" variant="ghost" icon={<ChevronLeft size={15} aria-hidden />} onClick={() => setCurrent(null)}>
                All widgets
              </Button>
              <WidgetSettings id={currentDef.id} onClose={() => setCurrent(null)} />
            </>
          ) : (
            <ul className="wg-list">
              {widgets.filter((w) => !w.defaultOff || isVisible(prefs, w)).map((w) => (
                <li key={w.id}>
                  <button type="button" className="wg-list__item" aria-label={`${w.title} settings`} onClick={() => setCurrent(w.id)}>
                    {w.title}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Sheet>
      )}
    </span>
  );
}
