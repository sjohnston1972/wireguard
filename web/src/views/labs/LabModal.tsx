import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import type { LabDetail } from "@shared/api";
import { Button, Drawer, cx } from "@/components";
import { useLab } from "@/api/queries";
import { CostTable, DeployFields, DeployFooter, useDeployForm } from "./DeployForm";
import { focusCard } from "./LabLaunchAction";
import { useLabsLayout } from "./layout";
import { LEVEL_WORD, TYPE_WORD, examsWord, stateWord } from "./model";
import { LabReadmeTabs, RunningFooter, RunningLab } from "./RunningLab";
import { Word } from "./RunningStrip";

/** "Lab 14 · AZ-104, AZ-700 · Associate · Explore · v3": every exam the lab belongs to, the primary first. */
export const subtitle = (d: LabDetail) => `Lab ${d.card.number} · ${examsWord(d.card)} · ${LEVEL_WORD[d.card.level]} · ${TYPE_WORD[d.card.type]} · v${d.card.version}`;

/** The Diagram tab is shown (?view=diagram): the dialog widens to give the canvas room (issue #93). */
function useDiagramShown(): boolean {
  const [params] = useSearchParams();
  return params.get("view") === "diagram";
}
const modalClass = (diagram: boolean) => cx("labs-modal", diagram && "labs-modal--diagram");

/** Not running: the readme on the left; cost, warnings and the Deploy form on the right. */
function IdleLab({ d, onClose, onCloseAutoFocus }: { d: LabDetail; onClose: () => void; onCloseAutoFocus: (e: Event) => void }) {
  const f = useDeployForm(d);
  const wide = useDiagramShown();
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} side="auto" size={wide ? "xl" : "lg"} title={d.card.title} subtitle={subtitle(d)} className={modalClass(wide)} footer={<DeployFooter f={f} />} onCloseAutoFocus={onCloseAutoFocus}>
      <div className="labs-modal__cols">
        <LabReadmeTabs d={d} />
        <div className="labs-modal__side">
          <section aria-labelledby="labs-cost-h" className="labs-section">
            <h3 className="labs-section__title" id="labs-cost-h">
              Cost
            </h3>
            <CostTable d={d} hours={f.hours} />
          </section>
          <section aria-labelledby="labs-deploy-h" className="labs-section">
            <h3 className="labs-section__title" id="labs-deploy-h">
              Deploy
            </h3>
            <DeployFields f={f} />
          </section>
        </div>
      </div>
    </Drawer>
  );
}

/** A lab that cannot be opened (an old link): a notice on the page, which stays usable behind it. */
export function CouldNotOpen({ id, error, onRetry, onDismiss }: { id: string; error: unknown; onRetry: () => void; onDismiss: () => void }) {
  return (
    <div className="labs-notice" role="alert">
      <span>
        Could not open {id}: {error instanceof Error ? error.message : "the lab could not be loaded."}
      </span>
      <Button size="sm" variant="secondary" onClick={onRetry}>
        Try again
      </Button>
      <Button size="sm" variant="ghost" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}

/**
 * The lab modal at /labs/:id (spec §10): a centred modal on the desktop, a
 * bottom sheet on the phone (Drawer side="auto"). Closing goes back to the
 * page it was opened from, filters kept.
 */
export function LabModal({ id, closeTo = "/labs" }: { id: string; closeTo?: string }) {
  const q = useLab(id);
  const navigate = useNavigate();
  const { search } = useLocation();
  const close = () => navigate({ pathname: closeTo, search });
  const layout = useLabsLayout();
  // Wide: focus goes back to what opened the dialog (the details' action). Tablet and phone: the
  // drawer or view that opened it has gone, so focus the lab's card (labs redesign spec §10).
  const focusBack = (e: Event) => {
    if (layout !== "wide" && focusCard(id)) e.preventDefault();
  };
  const wide = useDiagramShown();
  const d = q.data;
  // The modal opens once the lab has answered, so there is never an empty
  // dialog over the page; a lab that cannot be opened (an old link) is a
  // notice on the page, which stays usable behind it.
  if (!d) {
    if (!q.isError)
      return (
        <p className="labs-sr" role="status">
          Opening the lab…
        </p>
      );
    return <CouldNotOpen id={id} error={q.error} onRetry={() => void q.refetch()} onDismiss={close} />;
  }
  if (!d.session) return <IdleLab key={d.card.id} d={d} onClose={close} onCloseAutoFocus={focusBack} />;
  const st = stateWord(d.session);
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && close()}
      side="auto"
      size={wide ? "xl" : "lg"}
      title={d.card.title}
      subtitle={subtitle(d)}
      leading={<Word {...st} className="labs-modal__state" />}
      className={modalClass(wide)}
      footer={<RunningFooter d={d} />}
      onCloseAutoFocus={focusBack}
    >
      <RunningLab d={d} />
    </Drawer>
  );
}
