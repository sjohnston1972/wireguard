import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { FirewallResponse } from "@shared/api";
import { Button, ErrorState, Panel, Tabs, useIsPhone } from "@/components";
import { useFirewall } from "@/api/queries";
import { RulesPanel } from "./RulesPanel";
import { FirewallHeader } from "./FirewallHeader";
import { ReviewModal } from "./ReviewModal";
import { KpiRow } from "./KpiRow";
import { DropsList, DropsPanel } from "./Drops";
import { ForwardModal, PortsList, PortsPanel } from "./Ports";
import { CaptureForm, CapturePanel, type CaptureFormHandle } from "./Capture";
import { ZonesPanel } from "./Zones";
import { SimulatorPanel, type SimulatorHandle } from "./Simulator";
import { RuleDrawer } from "./RuleDrawer";
import { FirewallPhone } from "./FirewallPhone";
import { NO_FILTER, complete, ruleViews, type RuleFilter } from "./model";
import { FirewallSkeleton } from "./FirewallSkeleton";
import { NARROW, useMedia } from "./useMedia";
import "./Firewall.css";

type RightTab = "drops" | "ports" | "capture";
type Forward = FirewallResponse["forwards"][number];

/**
 * /firewall and /firewall/rules/:id: one page (the rule route opens its
 * drawer over it). Reads ?action=add-rule (opens the rule drawer) and
 * ?action=capture (focuses the capture form) once, and removes them.
 */
export function FirewallPage() {
  const fw = useFirewall();
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const narrow = useMedia(NARROW);
  const phone = useIsPhone();

  const [filter, setFilter] = useState<RuleFilter>(NO_FILTER);
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

  const full = useMemo(() => (fw.data ? complete(fw.data) : undefined), [fw.data]);
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

  const focusRules = () => tableRef.current?.querySelector<HTMLElement>("tr[tabindex]")?.focus();
  const managePorts = () => {
    setRightTab("ports");
    setTimeout(() => portsAddRef.current?.focus(), 0);
  };
  const startCapture = () => {
    setRightTab("capture");
    setFocusCapture(true);
  };
  const addForward = () => setForward({ open: true, editing: null });
  const editForward = (f: Forward) => setForward({ open: true, editing: f });

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

  const right = narrow ? (
    <Panel className="fw-righttabs" bodyClassName="fw-righttabs__body">
      <Tabs
        variant="pill"
        aria-label="Drops, published ports and capture"
        value={rightTab}
        onValueChange={(v) => setRightTab(v as RightTab)}
        items={[
          { value: "drops", label: "Drops", count: data.drops.recent.length, content: <DropsList fw={data} /> },
          {
            value: "ports",
            label: "Published ports",
            content: (
              <div className="fw-righttabs__ports">
                <Button ref={portsAddRef} size="sm" variant="primary" onClick={addForward}>
                  Add published port
                </Button>
                <PortsList fw={data} onAdd={addForward} onEdit={editForward} />
              </div>
            ),
          },
          { value: "capture", label: "Capture", content: <CaptureForm ref={captureRef} fw={data} /> },
        ]}
      />
    </Panel>
  ) : (
    <>
      <DropsPanel fw={data} updatedAt={fw.dataUpdatedAt} />
      <PortsPanel ref={portsAddRef} fw={data} onAdd={addForward} onEdit={editForward} />
      <CapturePanel ref={captureRef} fw={data} />
    </>
  );

  return (
    <div className="fw">
      <FirewallHeader fw={data} waiting={waiting} updatedAt={fw.dataUpdatedAt} onReview={() => setReviewing(true)} />
      <KpiRow ref={defaultBtnRef} fw={data} rows={rows} onManageRules={focusRules} onManagePorts={managePorts} onStartCapture={startCapture} />
      <div className="fw__body">
        <div className="fw__left">
          <RulesPanel
            ref={tableRef}
            fw={data}
            rows={rows}
            filter={filter}
            onFilter={setFilter}
            onAddRule={() => setAddOpen(true)}
            onTestSimulation={() => simRef.current?.focus()}
            onEditDefault={() => defaultBtnRef.current?.focus()}
            className="fw__rules"
          />
          <div className="fw__bottom">
            <ZonesPanel fw={data} rows={rows} selected={filter.zone} onSelect={(z) => setFilter((f) => ({ ...f, zone: z }))} />
            <SimulatorPanel ref={simRef} fw={data} />
          </div>
        </div>
        <div className="fw__right">{right}</div>
      </div>
      {overlays}
    </div>
  );
}

export const FirewallRulePage = FirewallPage;
