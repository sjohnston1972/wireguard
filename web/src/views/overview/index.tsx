import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Settings } from "lucide-react";
import type { OverviewResponse } from "@shared/api";
import { LAYOUTS, itemKey } from "@shared/widgets";
import { ErrorState, IconButton, PageHeader, Skeleton, cx, useIsPhone, useToast } from "@/components";
import { LayoutMenu, Widget, WidgetRow, WidgetStack, usePagePrefs, useRowItems, useWidget } from "@/widgets";
import { useOverview } from "@/api/queries";
import { EnvironmentField } from "@/shell/StateChip";
import { ACTION_WORD, ActionDialog, PALETTE_ACTIONS, actionAllowed, type ActionName } from "./actions";
import { StatusBanner } from "./Banner";
import { useServerNow } from "./hooks";
import { KeyMetrics } from "./KeyMetrics";
import { Topology } from "./Topology";
import { LastRun, RunPanels } from "./Run";
import { RecentEvents, SpeedTests, Traffic } from "./Side";
import { CostImpact, HealthSummary, WatchmanNotes } from "./Lower";
import { PhoneOverview } from "./Phone";
import { STATE_WORD, inGithubRun, regionCountry, regionFull } from "./model";
import "./Overview.css";

const SUBTITLE = "Deploy and monitor your WireGuard environment on Azure.";

/** A read-only header field: caption over a boxed value (Region, VM size). */
function ReadField({ caption, children }: { caption: string; children: React.ReactNode }) {
  return (
    <div className="ov-read" role="group" aria-label={caption}>
      <span className="ov-read__caption" aria-hidden>
        {caption}
      </span>
      <span className="ov-read__value">{children}</span>
    </div>
  );
}

function Header({ o }: { o: OverviewResponse | null }) {
  const navigate = useNavigate();
  const region = o ? o.snapshot.region ?? o.config.region : null;
  const size = o ? o.snapshot.vm_size ?? o.config.vmSize : null;
  const country = regionCountry(region);
  return (
    <PageHeader
      title="Overview"
      subtitle={SUBTITLE}
      env={<EnvironmentField />}
      right={
        <>
          <ReadField caption="Region">
            {country && (
              <span className="ov-flag" aria-hidden>
                {country}
              </span>
            )}
            {region ? regionFull(region) : "no data"}
          </ReadField>
          <ReadField caption="VM size">{size || "no data"}</ReadField>
          <IconButton label="Deployment settings" className="ov-gear" onClick={() => navigate("/settings/deployment")}>
            <Settings size={18} aria-hidden />
          </IconButton>
          <LayoutMenu page="overview" />
        </>
      }
    />
  );
}

/** Loading: the page's shape in grey, so nothing jumps when the data lands. */
function OverviewSkeleton() {
  return (
    <div className="ov-skeleton" aria-busy="true" aria-label="Loading the overview">
      <Skeleton variant="block" height={96} />
      <div className="ov-skeleton__row">
        <Skeleton variant="block" height={180} />
        <Skeleton variant="block" height={180} />
      </div>
      <div className="ov-skeleton__row ov-skeleton__row--3">
        <Skeleton variant="block" height={220} />
        <Skeleton variant="block" height={220} />
        <Skeleton variant="block" height={220} />
      </div>
    </div>
  );
}

/** ?action=<name> opens that reviewed form once (never runs anything) and is removed when the form closes. */
function usePaletteAction(o: OverviewResponse | null, open: (a: ActionName, profileId: number | null) => void) {
  const [params, setParams] = useSearchParams();
  const asked = params.get("action") as ActionName | null;
  const handled = useRef<string | null>(null);
  const { toast } = useToast();
  const ready = !!o;
  useEffect(() => {
    // Handled once per appearance of the parameter: a new ?action= (or the same one again later) opens again.
    if (!asked) {
      handled.current = null;
      return;
    }
    if (!o || handled.current === asked) return;
    handled.current = asked;
    // Settings' profile "Use" adds &profile=<id>: the deploy form starts on that profile.
    const profile = Number(params.get("profile"));
    if (PALETTE_ACTIONS.includes(asked) && actionAllowed(asked, o)) open(asked, Number.isInteger(profile) && profile > 0 ? profile : null);
    // Not possible in this state: say so; no form opens, so the address is left as it is.
    else if (PALETTE_ACTIONS.includes(asked)) toast({ tone: "info", title: `${ACTION_WORD[asked]} is not available while the VM is ${STATE_WORD[o.snapshot.state]}.` });
    // `o` is read only when the parameter first appears (or the data first arrives).
  }, [asked, ready, open, toast]);
  return useCallback(() => {
    if (!params.has("action") && !params.has("profile")) return;
    const next = new URLSearchParams(params);
    next.delete("action");
    next.delete("profile");
    setParams(next, { replace: true });
  }, [params, setParams]);
}

export function OverviewPage() {
  const q = useOverview();
  const o = q.data ?? null;
  const phone = useIsPhone();
  const [action, setAction] = useState<ActionName | null>(null);
  const [profileId, setProfileId] = useState<number | null>(null);
  const openFromPalette = useCallback((a: ActionName, p: number | null) => {
    setAction(a);
    setProfileId(p);
  }, []);
  const clearParam = usePaletteAction(o, openFromPalette);
  const close = useCallback(() => {
    setAction(null);
    setProfileId(null);
    clearParam();
  }, [clearParam]);

  let body: React.ReactNode;
  if (!o && q.isError) body = <ErrorState title="Could not load the overview" message={q.error.message} onRetry={() => void q.refetch()} />;
  else if (!o) body = <OverviewSkeleton />;
  else body = phone ? <Phone o={o} receivedAt={q.dataUpdatedAt} onAction={setAction} /> : <Desktop o={o} receivedAt={q.dataUpdatedAt} onAction={setAction} />;

  return (
    <div className="ov">
      <Header o={o} />
      {body}
      {o && <ActionDialog name={action} o={o} onClose={close} profileId={profileId} />}
    </div>
  );
}

function Phone({ o, receivedAt, onAction }: { o: OverviewResponse; receivedAt: number; onAction: (a: ActionName) => void }) {
  const now = useServerNow(o.now, receivedAt, 10_000);
  return <PhoneOverview o={o} now={now} onAction={onAction} />;
}

const R3 = LAYOUTS.overview.rows.find((r) => r.id === "r3")!;
const weightOf = (key: string) => R3.items.find((i) => itemKey(i) === key)!.weight;
const RUN = "overview.run";
const TRAFFIC = "overview.traffic";
const EVENTS = "overview.events";

/** The side stack: its visible widgets; one alone takes the whole column. */
function Side({ members, children }: { members: string[]; children: Record<string, React.ReactNode> }) {
  return <div className={cx("ov-side", members.length === 1 && "ov-side--one")}>{members.map((m) => <Fragment key={m}>{children[m]}</Fragment>)}</div>;
}

/**
 * The middle row. Without a run (or with the run widget hidden): Last run,
 * Network traffic and the side stack (Recent events, Speed test), in the
 * user's order. During a GitHub run, as today: the run widget widens over
 * traffic's slot and Network traffic takes Speed test's place in the side
 * stack; hidden widgets stay hidden and the user's order is kept.
 */
function MiddleRow({ o, now, onAction }: { o: OverviewResponse; now: number; onAction: (a: ActionName) => void }) {
  const { prefs } = usePagePrefs("overview");
  const v = useRowItems("overview", "r3");
  const run = useWidget(RUN);
  const traffic = useWidget(TRAFFIC);
  const events = useWidget(EVENTS);
  const sideMembers = v.items.find((i) => i.key === "side")?.members ?? [];

  if (!inGithubRun(o.snapshot.state) || run.hidden)
    return (
      <WidgetRow page="overview" row="r3" className="ov-row ov-row--3">
        {{
          [RUN]: (
            <Widget id={RUN}>
              <LastRun o={o} onAction={onAction} />
            </Widget>
          ),
          [TRAFFIC]: (
            <Widget id={TRAFFIC}>
              <Traffic o={o} now={now} />
            </Widget>
          ),
          side: (
            <WidgetStack page="overview" stack="side" className={cx("ov-side", sideMembers.length === 1 && "ov-side--one")}>
              {{
                [EVENTS]: (
                  <Widget id={EVENTS}>
                    <RecentEvents />
                  </Widget>
                ),
                "overview.speedTest": (
                  <Widget id="overview.speedTest">
                    <SpeedTests o={o} now={now} onAction={onAction} />
                  </Widget>
                ),
              }}
            </WidgetStack>
          ),
        }}
      </WidgetRow>
    );

  // The run arrangement: the run and the side stack, in the user's order of r3.
  const declared = R3.items.map(itemKey);
  const saved = prefs.layout?.order?.r3;
  const order = saved && saved.length === declared.length && declared.every((k) => saved.includes(k)) ? saved : declared;
  const side = [EVENTS, TRAFFIC].filter((id) => !(id === EVENTS ? events : traffic).hidden);
  const items = order.filter((k) => k === RUN || (k === "side" && side.length)).map((k) => ({ key: k, weight: k === RUN ? weightOf(RUN) + weightOf(TRAFFIC) : weightOf("side") }));
  const isDefault = items.map((i) => i.key).join() === [RUN, "side"].join() && side.length === 2;
  const sideBlock = (
    <Side key="side" members={side}>
      {{
        [EVENTS]: (
          <Widget id={EVENTS}>
            <RecentEvents />
          </Widget>
        ),
        [TRAFFIC]: (
          <Widget id={TRAFFIC}>
            <Traffic o={o} now={now} />
          </Widget>
        ),
      }}
    </Side>
  );
  return (
    <div className={cx("ov-row ov-row--3", !isDefault && "ov-row--custom")} style={isDefault ? undefined : { gridTemplateColumns: items.map((i) => `minmax(0, ${i.weight}fr)`).join(" ") }}>
      {items.map((i) =>
        i.key === RUN ? (
          <Widget key={RUN} id={RUN}>
            <RunPanels o={o} />
          </Widget>
        ) : (
          sideBlock
        ),
      )}
    </div>
  );
}

function Desktop({ o, receivedAt, onAction }: { o: OverviewResponse; receivedAt: number; onAction: (a: ActionName) => void }) {
  const now = useServerNow(o.now, receivedAt, 10_000);
  const r2 = useRowItems("overview", "r2");
  const r3 = useRowItems("overview", "r3");
  const r4 = useRowItems("overview", "r4");
  // A row with nothing visible is not drawn, and its height track goes with it; the others keep theirs.
  const shown = [r2.visible && "r2", r3.visible && "r3", r4.visible && "r4"].filter(Boolean);
  return (
    <>
      <Widget id="overview.status" headerless>
        <StatusBanner o={o} now={now} receivedAt={receivedAt} onAction={onAction} />
      </Widget>
      <div className={cx("ov-rows", shown.length < 3 && `ov-rows--${shown.join("-") || "none"}`)}>
        <WidgetRow page="overview" row="r2" className="ov-row ov-row--2">
          {{
            "overview.topology": (
              <Widget id="overview.topology">
                <Topology o={o} now={now} />
              </Widget>
            ),
            "overview.keyMetrics": (
              <Widget id="overview.keyMetrics">
                <KeyMetrics o={o} now={now} />
              </Widget>
            ),
          }}
        </WidgetRow>
        {r3.visible && <MiddleRow o={o} now={now} onAction={onAction} />}
        <WidgetRow page="overview" row="r4" className="ov-row ov-row--4">
          {{
            "overview.health": (
              <Widget id="overview.health">
                <HealthSummary o={o} now={now} />
              </Widget>
            ),
            "overview.costImpact": (
              <Widget id="overview.costImpact">
                <CostImpact o={o} />
              </Widget>
            ),
            "overview.notes": (
              <Widget id="overview.notes">
                <WatchmanNotes />
              </Widget>
            ),
          }}
        </WidgetRow>
      </div>
    </>
  );
}
