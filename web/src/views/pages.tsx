import { useParams } from "react-router-dom";
import { Placeholder } from "./Placeholder";

// One placeholder per route. Plan 4 replaces each of these with the real view
// (keep the export names, or change the route table in App.tsx).

export const OverviewPage = () => <Placeholder title="Overview" />;
export const ClientsPage = () => <Placeholder title="Clients" />;
export const ClientDetailPage = () => <Placeholder title={`Client ${useParams().id}`} />;
export const FirewallPage = () => <Placeholder title="Firewall" />;
export const FirewallRulePage = () => <Placeholder title={`Firewall rule ${useParams().id}`} />;
export const ActivityPage = () => <Placeholder title="Activity" />;
export const RunDetailPage = () => <Placeholder title={`Run ${useParams().id}`} />;
export const CostPage = () => <Placeholder title="Cost" />;
export const SettingsPage = () => <Placeholder title="Settings" />;
export const NotFoundPage = () => <Placeholder title="Not found" />;
