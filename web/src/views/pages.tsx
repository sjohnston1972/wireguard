import { lazy, Suspense } from "react";
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

// Labs (/labs, /labs/:id, /labs/history): its own chunk, loaded on first visit,
// so the entry never carries it (plan L0). views/labs/index.tsx's default
// export is the whole tab and reads the route itself.
const LabsView = lazy(() => import("./labs"));
export const LabsPage = () => (
  <Suspense fallback={<section className="placeholder" aria-busy="true" aria-label="Loading Labs" />}>
    <LabsView />
  </Suspense>
);
