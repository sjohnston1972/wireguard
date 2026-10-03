import { Placeholder } from "./Placeholder";

// The route table's pages (App.tsx imports these names). Each view lives in
// its own folder, views/<view>/index.tsx, and is re-exported here, so a view
// area replaces only its own folder and never this file or the routes.

export { OverviewPage } from "./overview";
export { ClientsPage, ClientDetailPage } from "./clients";
export { FirewallPage, FirewallRulePage } from "./firewall";
export { ActivityPage, RunDetailPage } from "./activity";
export { CostPage } from "./cost";
export { SettingsPage } from "./settings";
export const NotFoundPage = () => <Placeholder title="Not found" />;
