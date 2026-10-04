import { useParams } from "react-router-dom";
import { ActivityView } from "./ActivityView";

/**
 * /activity, and /activity/runs/:id (the same page with that run's dialog
 * open). One component for both routes, so opening or closing a run does not
 * remount the page: the table keeps its rows and focus goes back to the row
 * that opened the run.
 */
export const ActivityPage = () => <ActivityView runId={useParams().id} />;

export const RunDetailPage = ActivityPage;
