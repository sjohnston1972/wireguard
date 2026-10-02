import { useParams } from "react-router-dom";
import { ActivityView } from "./ActivityView";

/** /activity */
export const ActivityPage = () => <ActivityView />;

/** /activity/runs/:id: the Activity page with that run's drawer open. */
export const RunDetailPage = () => <ActivityView runId={useParams().id} />;
