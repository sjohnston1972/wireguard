// views/labs/details.harness.tsx
//
// Plain English: a stand-in for the catalogue page (area B's LabsPage) for the
// details tests (plan C1-C5). It reads ?lab the way the page does (labs
// redesign spec §9), shows a minimal card list (each card an <article
// data-lab-card> with its select button, as B's LabCard is) and the details
// container the layout asks for, so the details' links, focus paths and URL
// writes can be tested before B lands. Test-only: nothing in the app imports it.

import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import type { LabsResponse } from "@shared/api";
import { renderWithProviders } from "@/test/render";
import { useLabViews } from "./contract";
import { LabDetailsDrawer, LabDetailsPanel, LabDetailsView } from "./LabDetailsPanel";
import type { LabsLayout } from "./layout";
import { readSelection, withSelection } from "./model";

function Probe() {
  const l = useLocation();
  return <output aria-label="location">{l.pathname + l.search}</output>;
}

function Cards({ data, onPick }: { data: LabsResponse; onPick: (id: string) => void }) {
  return (
    <ul aria-label="Labs">
      {data.labs.map((c) => (
        <li key={c.id}>
          <article data-lab-card={c.id}>
            <h3>
              <button type="button" onClick={() => onPick(c.id)}>
                {c.title}
              </button>
            </h3>
          </article>
        </li>
      ))}
    </ul>
  );
}

/** The page stand-in: wide shows the panel (?lab or the first lab), tablet the drawer, phone the full-width view. */
export function DetailsHarness({ data, layout, loaded = true }: { data: LabsResponse; layout: LabsLayout; loaded?: boolean }) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { views, byId } = useLabViews({ data: loaded ? data : undefined });
  const urlLab = readSelection(params);
  const select = (id: string) => setParams(withSelection(params, id), { replace: layout === "wide" });
  const back = () => setParams(withSelection(params, null));
  if (layout === "wide") {
    const view = (urlLab ? byId.get(urlLab) : views[0]) ?? null;
    return <LabDetailsPanel view={view} data={loaded ? data : undefined} layout="wide" onSelect={select} />;
  }
  const view = urlLab ? (byId.get(urlLab) ?? null) : null;
  if (layout === "phone") {
    if (urlLab) return <LabDetailsView view={view} data={data} layout="phone" onSelect={select} onBack={() => navigate(-1)} />;
    return <Cards data={data} onPick={(id) => setParams(withSelection(params, id))} />;
  }
  return (
    <>
      <Cards data={data} onPick={(id) => setParams(withSelection(params, id))} />
      <LabDetailsDrawer view={view} data={data} layout="tablet" onSelect={select} open={!!urlLab} onOpenChange={(o) => !o && back()} />
    </>
  );
}

/** Renders the harness at `url` with fetch mocked by `routes` (GET /labs/:id answers, the deploy spy). */
export function renderDetails(data: LabsResponse, opts: { layout?: LabsLayout; url?: string; routes?: Record<string, unknown>; loaded?: boolean } = {}) {
  return renderWithProviders(
    <>
      <DetailsHarness data={data} layout={opts.layout ?? "wide"} loaded={opts.loaded} />
      <Probe />
    </>,
    { url: opts.url ?? "/labs", routes: { "GET /api/v1/labs": data, ...(opts.routes ?? {}) } },
  );
}
