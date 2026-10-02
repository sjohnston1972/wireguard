// Escape belongs to the dialog the user is working in, even while a toast is
// showing. Radix gives Escape only to its newest layer, and a toast that
// appears after a dialog opened is newer, so on its own the toast would take
// Escape and the dialog would stay open. The toast hands such an Escape over
// (it keeps itself open); Modal and Drawer, marked with this attribute, close.

const handed = new WeakSet<Event>();

/** On a Modal or Drawer's content: it closes on an Escape a toast handed over. */
export const ESCAPE_HANDOFF = "data-escape-handoff";

/** Called by a toast: true (and the event is handed over) when focus is in a dialog that takes it. */
export function handEscapeToDialog(e: KeyboardEvent): boolean {
  const target = e.target;
  if (!(target instanceof Element) || !target.closest(`[${ESCAPE_HANDOFF}]`)) return false;
  handed.add(e);
  return true;
}

/** Called by a dialog's keydown handler: was this Escape handed over by a toast? */
export const escapeHandedToDialog = (e: Event): boolean => handed.has(e);
