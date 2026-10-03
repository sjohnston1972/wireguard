import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { FirewallResponse } from "@shared/api";
import { Button, ErrorState, Panel, Tabs, cx, useIsPhone } from "@/components";
import { Widget, usePagePrefs, useRowItems, useStarting, useWidget } from "@/widgets";
import { useFirewall } from "@/api/queries";
import { RulesPanel } from "./RulesPanel";
import { FirewallHeader } from "./FirewallHeader";
import { ReviewModal } from "./ReviewModal";
import { KpiRow } from "./KpiRow";
import { DropsList, DropsPanel } from "./Drops";
import { ForwardModal, PortsList, PortsPanel } from "./Ports";
import { CaptureForm, CapturePanel, type CaptureFormHandle } from "./Capture";
import { ZonesPanel, ZonesTab } from "./Zones";
import { SimulatorForm, SimulatorPanel, type SimulatorHandle } from "./Simulator";
import { RuleDrawer } from "./RuleDrawer";
import { FirewallPhone } from "./FirewallPhone";
import { NARROW, NO_FILTER, SHORT, TAB_WIDGET, ruleViews, tabsLabel, type RightTab, type RuleFilter, type RuleTab } from "./model";
import { FirewallSkeleton } from "./FirewallSkeleton";
import { useMedia } from "@/lib/useMedia";
import "./Firewall.css";

type Forward = FirewallResponse["forwards"][number];

/**
 * /firewall and /firewall/rules/:id: one page (the rule route opens its
 * drawer over it). Reads ?action=add-rule (opens the rule drawer) and
 * ?action=capture (focuses the capture form) once, and removes them.
 *
 * Every panel is a widget (spec 2026-10-03 §8): row r1 is the figures; row r2
 * is the left stack (the rules over the nested row `bottom`: zones and the
 * simulator, which can swap) and the right stack (drops, published ports,
 * capture), and the two stacks can swap. Hidden widgets are not drawn and the
 * rest of their row or stack takes the space. The header (policy status,
 * draft bar) is not a widget.
 */
export function FirewallPage() {
  const fw = useFirewall();
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const narrow = useMedia(NARROW);
  // A short window gives the rules table the whole left column: zones and the simulator join the right-hand tabs.
  const short = useMedia(SHORT);
  const phone = useIsPhone();

  const rulesWidget = useWidget("firewall.rules");
  const dropsMax = useWidget("firewall.drops").settings.max as string;
  const hidden = {
    drops: useWidget("firewall.drops").hidden,
    ports: useWidget("firewall.ports").hidden,
    capture: useWidget("firewall.capture").hidden,
    zones: useWidget("firewall.zones").hidden,
    sim: useWidget("firewall.simulator").hidden,
  };
  const { prefs } = usePagePrefs("firewall");
  const bottomRow = useRowItems("firewall", "bottom");

  // The rule filter; its tab starts at the rules widget's Starting tab.
  const [tabPick, setTabPick] = useStarting(rulesWidget.settings.tab as RuleTab);
  const [rest, setRest] = useState<RuleFilter>(NO_FILTER);
  const filter: RuleFilter = { ...rest, tab: tabPick };
  const setFilter = (next: RuleFilter | ((f: RuleFilter) => RuleFilter)) => {
    const f = typeof next === "function" ? next(filter) : next;
    setRest(f);
    if (f.tab !== filter.tab) setTabPick(f.tab);
  };

  const [reviewing, setReviewing] = useState(false);
  // When Apply last worked: until a fresher answer arrives the page says "waiting for VM".
  const [appliedAt, setAppliedAt] = useState<number | null>(null);
  const [rightTab, setRightTab] = useState<RightTab>("drops");
  const [forward, setForward] = useState<{ open: boolean; editing: Forward | null }>({ open: false, editing: null });
  const [addOpen, setAddOpen] = useState(false);
  const [focusCapture, setFocusCapture] = useState(false);
  const [phoneSheet, setPhoneSheet] = useState<string | null>(null);

  const tableRef = useRef<HTMLDivElement>(null);
  const simRef = useRef<SimulatorHandle>(null);
  const captureRef = useRef<CaptureFormHandle>(null);
  const portsAddRef = useRef<HTMLButtonElement>(null);
  const defaultBtnRef = useRef<HTMLButtonElement>(null);

  const full = fw.data;
  const rows = useMemo(() => (full ? ruleViews(full) : []), [full]);
  const action = params.get("action");
  const loaded = !!fw.data;

  // ?action=capture: show the capture form, focus it, then drop the parameter.
  useEffect(() => {
    if (action !== "capture" || !loaded) return;
    setRightTab("capture");
    setPhoneSheet("capture");
    setFocusCapture(true);
  }, [action, loaded]);
  useEffect(() => {
    if (!focusCapture || !captureRef.current) return;
    const t = setTimeout(() => {
      captureRef.current?.focus();
      setFocusCapture(false);
      if (params.get("action") === "capture") {
        const next = new URLSearchParams(params);
        next.delete("action");
        setParams(next, { replace: true });
      }
    }, 0);
    return () => clearTimeout(t);
  });

  if (fw.isPending) return <FirewallSkeleton />;
  if (fw.isError || !full) return <ErrorState title="Could not load the firewall" message={fw.error?.message ?? "No answer."} onRetry={() => void fw.refetch()} />;
  const data = full;
  const waiting = appliedAt !== null && fw.dataUpdatedAt <= appliedAt;

  const adding = addOpen || action === "add-rule";
  const drawerOpen = !!id || adding;
  const rule = id ? (rows.find((r) => String(r.id) === id) ?? null) : null;
  const closeDrawer = () => {
    setAddOpen(false);
    if (id) navigate("/firewall");
    else if (action === "add-rule") navigate("/firewall", { replace: true });
  };
  const tab = params.get("tab") === "history" ? "history" : "rule";
  const setTab = (t: "rule" | "history") => {
    const next = new URLSearchParams(params);
    if (t === "history") next.set("tab", "history");
    else next.delete("tab");
    setParams(next, { replace: true });
  };

  const addForward = () => setForward({ open: true, editing: null });
  const editForward = (f: Forward) => setForward({ open: true, editing: f });
  const focusRules = () => tableRef.current?.querySelector<HTMLElement>("tr[tabindex]")?.focus();
  const managePorts = () => {
    // With the ports widget hidden there is no list to go to: open the add form instead.
    if (hidden.ports) return addForward();
    setRightTab("ports");
    setTimeout(() => portsAddRef.current?.focus(), 0);
  };
  const startCapture = () => {
    setRightTab("capture");
    setFocusCapture(true);
  };

  const overlays = (
    <>
      <ReviewModal
        draft={data.draft}
        open={reviewing && !!data.draft}
        onOpenChange={setReviewing}
        onApplied={() => {
          setAppliedAt(Date.now());
          setReviewing(false);
        }}
      />
      <RuleDrawer fw={data} rule={rule} adding={adding && !id} id={id ?? null} open={drawerOpen} tab={tab} onTab={setTab} onClose={closeDrawer} />
      <ForwardModal fw={data} open={forward.open} editing={forward.editing} onOpenChange={(o) => setForward((s) => ({ ...s, open: o }))} />
    </>
  );

  if (phone) {
    return (
      <>
        <FirewallPhone
          fw={data}
          rows={rows}
          waiting={waiting}
          updatedAt={fw.dataUpdatedAt}
          sheet={phoneSheet}
          onSheet={setPhoneSheet}
          onReview={() => setReviewing(true)}
          onAddRule={() => setAddOpen(true)}
          onAddForward={addForward}
          onEditForward={editForward}
          captureRef={captureRef}
        />
        {overlays}
      </>
    );
  }

  const testSimulation = () => {
    if (!short) return simRef.current?.focus();
    setRightTab("sim");
    setTimeout(() => simRef.current?.focus(), 0);
  };
  const zones = <ZonesTab fw={data} rows={rows} selected={filter.zone} onSelect={(z) => setFilter((f) => ({ ...f, zone: z }))} />;

  // The right column's tabs (below 1400 px wide, or short): its stack's widgets in their
  // fixed order, then (short) zones and the simulator in the user's order; hidden ones left out.
  const tabbed = narrow || short;
  const stackTabs = (["drops", "ports", "capture"] as const).filter((t) => !hidden[t]);
  const bottomTabs: RightTab[] = short ? bottomRow.items.map((i) => (i.key === "firewall.zones" ? "zones" : "sim")) : [];
  const tabs: RightTab[] = tabbed ? [...stackTabs, ...bottomTabs] : [...stackTabs];
  const current: RightTab | undefined = tabs.includes(rightTab) ? rightTab : tabs[0];
  const TAB_ITEMS: Record<RightTab, { value: RightTab; label: string; count?: number; content: ReactNode }> = {
    drops: { value: "drops", label: "Drops", count: dropsMax === "all" ? data.drops.recent.length : Math.min(data.drops.recent.length, Number(dropsMax)), content: <DropsList fw={data} /> },
    ports: {
      value: "ports",
      label: short ? "Ports" : "Published ports",
      content: (
        <div className="fw-righttabs__ports">
          <Button ref={portsAddRef} size="sm" variant="primary" onClick={addForward}>
            Add published port
          </Button>
          <PortsList fw={data} onAdd={addForward} onEdit={editForward} />
        </div>
      ),
    },
    capture: { value: "capture", label: "Capture", content: <CaptureForm ref={captureRef} fw={data} /> },
    zones: { value: "zones", label: "Zones", content: zones },
    sim: { value: "sim", label: "Test", content: <SimulatorForm ref={simRef} fw={data} /> },
  };

  const right =
    tabs.length === 0 ? null : tabbed && current ? (
      // One panel for several widgets: its corner cog belongs to the tab shown, and it carries its column's move handle.
      <Widget id={TAB_WIDGET[current]} headerless stackHandle>
        <Panel className="fw-righttabs" bodyClassName="fw-righttabs__body">
          <Tabs variant="pill" aria-label={tabsLabel(tabs)} value={current} onValueChange={(v) => setRightTab(v as RightTab)} items={tabs.map((t) => TAB_ITEMS[t])} />
        </Panel>
      </Widget>
    ) : (
      <>
        <Widget id="firewall.drops">
          <DropsPanel fw={data} updatedAt={fw.dataUpdatedAt} />
        </Widget>
        <Widget id="firewall.ports">
          <PortsPanel ref={portsAddRef} fw={data} onAdd={addForward} onEdit={editForward} />
        </Widget>
        <Widget id="firewall.capture">
          <CapturePanel ref={captureRef} fw={data} />
        </Widget>
      </>
    );

  const bottomItems: Record<string, ReactNode> = {
    "firewall.zones": (
      <Widget key="zones" id="firewall.zones">
        <ZonesPanel fw={data} rows={rows} selected={filter.zone} onSelect={(z) => setFilter((f) => ({ ...f, zone: z }))} />
      </Widget>
    ),
    "firewall.simulator": (
      <Widget key="sim" id="firewall.simulator">
        <SimulatorPanel ref={simRef} fw={data} />
      </Widget>
    ),
  };
  const bottomKeys = bottomRow.items.map((i) => i.key);
  const bottom =
    !short && bottomKeys.length > 0 ? (
      <div className={cx("fw__bottom", bottomKeys.length === 1 && "fw__bottom--single", bottomKeys[0] === "firewall.simulator" && bottomKeys.length > 1 && "fw__bottom--swapped")}>
        {bottomKeys.map((k) => bottomItems[k])}
      </div>
    ) : null;

  const left = (
    <div key="left" className="fw__left">
      <Widget id="firewall.rules">
        <RulesPanel
          ref={tableRef}
          fw={data}
          rows={rows}
          filter={filter}
          onFilter={setFilter}
          onAddRule={() => setAddOpen(true)}
          onTestSimulation={hidden.sim ? undefined : testSimulation}
          onEditDefault={() => defaultBtnRef.current?.focus()}
          className="fw__rules"
        />
      </Widget>
      {bottom}
    </div>
  );
  const rightCol = right && (
    <div key="right" className={cx("fw__right", !tabbed && hidden.drops && "fw__right--no-drops")}>
      {right}
    </div>
  );
  const rightFirst = prefs.layout?.order?.r2?.[0] === "right";

  return (
    <div className="fw">
      <FirewallHeader fw={data} waiting={waiting} updatedAt={fw.dataUpdatedAt} onReview={() => setReviewing(true)} />
      <Widget id="firewall.kpis" headerless>
        <KpiRow ref={defaultBtnRef} fw={data} rows={rows} onManageRules={focusRules} onManagePorts={managePorts} onStartCapture={hidden.capture ? undefined : startCapture} />
      </Widget>
      <div className={cx("fw__body", !rightCol && "fw__body--single", rightCol && rightFirst && "fw__body--reversed")}>{rightFirst ? [rightCol, left] : [left, rightCol]}</div>
      {overlays}
    </div>
  );
}

export const FirewallRulePage = FirewallPage;
