import { useLocation, useNavigate } from "react-router-dom";
import type { LabDetail } from "@shared/api";
import { Drawer, ErrorState, Skeleton } from "@/components";
import { useLab } from "@/api/queries";
import { CostTable, DeployFields, DeployFooter, useDeployForm } from "./DeployForm";
import { LEVEL_WORD, TYPE_WORD, stateWord } from "./model";
import { ReadmeView } from "./ReadmeView";
import { RunningFooter, RunningLab } from "./RunningLab";
import { Word } from "./RunningStrip";

const subtitle = (d: LabDetail) => `Lab ${d.card.number} · ${d.card.exam} · ${LEVEL_WORD[d.card.level]} · ${TYPE_WORD[d.card.type]} · v${d.card.version}`;

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
  if (!d) {
    return (
      <Drawer open onOpenChange={(o) => !o && close()} side="auto" size="lg" title="Lab" subtitle={id}>
        {q.isError ? (
          <ErrorState title="Could not open this lab" message={q.error instanceof Error ? q.error.message : "The lab could not be loaded."} onRetry={() => void q.refetch()} />
        ) : (
          <div aria-busy="true" className="labs-modal__skel">
            <Skeleton variant="line" width="60%" />
            <Skeleton variant="block" height={160} />
          </div>
        )}
      </Drawer>
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
