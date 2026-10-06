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

// The lab diagram (lab topology spec ruling 21): its own lazy chunk (React
// Flow, the topology code, the planned graphs as hashed assets), never in the
// entry or the labs chunk. The labs tab's Diagram tab, the full-screen route
// and the Overview hover render it (topology/index.ts's DiagramTab, FullScreen
// and LabMini); declared here so every build carries the chunk.
export const LabDiagramTab = lazy(() => import("./labs/topology").then((m) => ({ default: m.default.DiagramTab })));
export const LabsPage = () => (
  <Suspense fallback={<section className="placeholder" aria-busy="true" aria-label="Loading Labs" />}>
    <LabsView />
  </Suspense>
);
