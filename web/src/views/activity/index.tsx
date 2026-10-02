import { useParams } from "react-router-dom";
import { Placeholder } from "../Placeholder";

// Plan 4 area E replaces this file with the Activity view (the run route opens its drawer).
export const ActivityPage = () => <Placeholder title="Activity" />;
export const RunDetailPage = () => <Placeholder title={`Run ${useParams().id}`} />;
