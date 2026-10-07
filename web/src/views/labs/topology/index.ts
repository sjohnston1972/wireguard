// views/labs/topology/index.ts
//
// Plain English: the diagram's lazy chunk (lab topology spec ruling 21): React
// Flow and the topology code load only through this module, by `lazy()` from
// the labs tab's Diagram tab, the full-screen route, the pop-out window
// (/labs/:id/diagram?popout=1, issue #93) and the Overview hover;
// never from the entry or the labs chunk itself (bundle-size fails an entry
// that mentions @xyflow).
//
//   const Diagram = lazy(() => import("@/views/labs/topology").then((m) => ({ default: m.default.DiagramTab })));

import { DiagramTab } from "./DiagramTab";
import { FullScreen } from "./FullScreen";
import { LabMini } from "./LabMini";
import { PopOut } from "./PopOut";

export type { CanvasProps, DetailsProps, DiagramVariant, ToolbarProps } from "./contract";

const diagram = { DiagramTab, FullScreen, LabMini, PopOut };
export default diagram;
