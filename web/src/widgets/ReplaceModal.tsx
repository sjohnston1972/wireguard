// widgets/ReplaceModal.tsx
//
// Plain English: "Replace a widget" (insights spec 9.3). Turning a widget on
// whose home row or column is full asks which visible widget to turn off,
// with the row's suggestion picked already. Replace swaps them in one save,
// the new widget taking the old one's place, so the row keeps its geometry.
// Cancel (or Escape) changes nothing. Focus goes back to the switch.

import { useState } from "react";
import { widgetDef, widgetHome } from "@shared/widgets";
import { Button, Modal } from "@/components";
import { useWidget } from "./useWidget";

/** "Row 3"; "Other" for widgets no row holds. */
export const rowLabel = (row: string) => (/^r(\d+)$/.exec(row) ? `Row ${row.slice(1)}` : row ? `The ${row} row` : "Other");

/** What enable() answered for a full home: the widget being turned on, Replace's candidates and the suggestion. */
export interface ReplaceAsk {
  id: string;
  candidates: string[];
  suggestion: string | null;
}

export function ReplaceModal({ ask, onClose }: { ask: ReplaceAsk; onClose: () => void }) {
  const w = useWidget(ask.id);
  const [choice, setChoice] = useState(ask.suggestion ?? ask.candidates[0] ?? "");
  const home = widgetHome(ask.id);
  const where = home?.stack ? `The ${home.stack} column` : rowLabel(home?.row ?? "");
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Replace a widget"
      description={`${where} is full. Pick a widget to turn off, and ${w.def.title} takes its place.`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!choice || w.readOnly}
            onClick={() => {
              w.replace(choice);
              onClose();
            }}
          >
            Replace
          </Button>
        </>
      }
    >
      <fieldset className="wg-form">
        <legend className="visually-hidden">Widget to turn off</legend>
        {ask.candidates.map((c) => {
          const d = widgetDef(c);
          return (
            <label key={c} className="wg-lib__item wg-lib__choice">
              <input type="radio" name="wg-replace" value={c} checked={choice === c} onChange={() => setChoice(c)} />
              <span className="wg-lib__text">
                <span className="wg-lib__title">{d?.title ?? c}</span>
                <span className="wg-lib__desc">{d?.description}</span>
              </span>
            </label>
          );
        })}
      </fieldset>
    </Modal>
  );
}
