import { useLocation, useNavigate } from "react-router-dom";
import type { LabDetail } from "@shared/api";
import { Button, Drawer } from "@/components";
import { useLab } from "@/api/queries";
import { CostTable, DeployFields, DeployFooter, useDeployForm } from "./DeployForm";
import { LEVEL_WORD, TYPE_WORD, examsWord, stateWord } from "./model";
import { ReadmeView } from "./ReadmeView";
import { RunningFooter, RunningLab } from "./RunningLab";
import { Word } from "./RunningStrip";

/** "Lab 14 · AZ-104, AZ-700 · Associate · Explore · v3": every exam the lab belongs to, the primary first. */
const subtitle = (d: LabDetail) => `Lab ${d.card.number} · ${examsWord(d.card)} · ${LEVEL_WORD[d.card.level]} · ${TYPE_WORD[d.card.type]} · v${d.card.version}`;

/** Not running: the readme on the left; cost, warnings and the Deploy form on the right. */
function IdleLab({ d, onClose }: { d: LabDetail; onClose: () => void }) {
  const f = useDeployForm(d);
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} side="auto" size="lg" title={d.card.title} subtitle={subtitle(d)} className="labs-modal" footer={<DeployFooter f={f} />}>
      <div className="labs-modal__cols">
        <ReadmeView blocks={d.readme} />
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
    return (
      <div className="labs-notice" role="alert">
        <span>
          Could not open {id}: {q.error instanceof Error ? q.error.message : "the lab could not be loaded."}
        </span>
        <Button size="sm" variant="secondary" onClick={() => void q.refetch()}>
          Try again
        </Button>
        <Button size="sm" variant="ghost" onClick={close}>
          Dismiss
        </Button>
      </div>
    );
  }
  if (!d.session) return <IdleLab key={d.card.id} d={d} onClose={close} />;
  const st = stateWord(d.session);
  return (
    <Drawer open onOpenChange={(o) => !o && close()} side="auto" size="lg" title={d.card.title} subtitle={subtitle(d)} leading={<Word {...st} className="labs-modal__state" />} className="labs-modal" footer={<RunningFooter d={d} />}>
      <RunningLab d={d} />
    </Drawer>
  );
}
