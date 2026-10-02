import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import type { CostResponse } from "@shared/api";
import { Chips, DataTable, Drawer, EmptyState, KeyValue, Panel, SearchInput, Select, Skeleton, StatusPill, type Column } from "@/components";
import { useRun } from "@/api/queries";
import { regionLabel } from "@/shell/StateChip";
import { durationLabel, gbp, startedLabel } from "./model";

type SessionRow = CostResponse["sessions"][number];

const regionOf = (s: SessionRow) => regionLabel(s.region) ?? s.region;

const COLUMNS: Column<SessionRow>[] = [
  { key: "started", header: "Started", cell: (s) => startedLabel(s.started), sortValue: (s) => s.started },
  { key: "status", header: "Status", cell: (s) => <StatusPill status={s.stillRunning ? "running" : "stopped"} /> },
  { key: "region", header: "Region", cell: regionOf, sortValue: regionOf },
  { key: "size", header: "VM size", cell: (s) => s.vmSize, sortValue: (s) => s.vmSize, className: "cost-hide-narrow" },
  { key: "duration", header: "Duration", cell: (s) => durationLabel(s.durationSeconds), sortValue: (s) => s.durationSeconds, align: "right" },
  { key: "cost", header: "Estimated cost", cell: (s) => gbp(s.estimatedGbp), sortValue: (s) => s.estimatedGbp, align: "right" },
  { key: "hour", header: "Cost / hour", cell: (s) => gbp(s.perHourGbp), sortValue: (s) => s.perHourGbp, align: "right", className: "cost-hide-narrow" },
  { key: "open", header: <span className="visually-hidden">Details</span>, cell: () => <ChevronRight size={16} aria-hidden />, width: 32 },
];

/** Row 4: every past session, filterable, each opening a drawer with its run. */
export function SessionsPanel({ cost, bare }: { cost: CostResponse; bare?: boolean }) {
  const navigate = useNavigate();
  const [status, setStatus] = useState("all");
  const [text, setText] = useState("");
  const [region, setRegion] = useState("all");
  const [openId, setOpenId] = useState<string | null>(null);

  const regions = useMemo(() => [...new Set(cost.sessions.map((s) => s.region))], [cost.sessions]);
  const rows = useMemo(() => {
    const needle = text.trim().toLowerCase();
    return cost.sessions.filter((s) => {
      if (status === "running" && !s.stillRunning) return false;
      if (status === "ended" && s.stillRunning) return false;
      if (region !== "all" && s.region !== region) return false;
      if (!needle) return true;
      return [startedLabel(s.started), s.started, regionOf(s), s.vmSize, s.stillRunning ? "running" : "stopped"].some((v) => v.toLowerCase().includes(needle));
    });
  }, [cost.sessions, status, text, region]);
  const open = cost.sessions.find((s) => s.runId === openId) ?? null;

  const controls = (
    <div className="cost-sessions__controls">
      <SearchInput label="Search sessions" value={text} onChange={setText} />
      <Chips
        aria-label="Session status"
        mode="single"
        value={[status]}
        onChange={(v) => setStatus(v[0] ?? "all")}
        items={[
          { value: "all", label: "All" },
          { value: "running", label: "Running" },
          { value: "ended", label: "Ended" },
        ]}
      />
      <Select
        label="Session region"
        value={region}
        onValueChange={setRegion}
        options={[{ value: "all", label: "All regions" }, ...regions.map((r) => ({ value: r, label: regionLabel(r) ?? r }))]}
      />
    </div>
  );

  const table = (
    <DataTable
      aria-label="Sessions"
      columns={COLUMNS}
      rows={rows}
      rowKey={(s) => s.runId}
      rowLabel={(s) => startedLabel(s.started)}
      defaultSort={{ key: "started", dir: "desc" }}
      onRowClick={(s) => setOpenId(s.runId)}
      empty={
        cost.sessions.length === 0 ? (
          <EmptyState title="No sessions yet" description="A session is one deploy and what came after it. Each one appears here with its cost." action={{ label: "Deploy from Overview", onClick: () => navigate("/?action=deploy") }} />
        ) : (
          <EmptyState title="No session matches" description="Clear the search or choose All to see them again." />
        )
      }
    />
  );

  const drawer = <SessionDrawer session={open} onClose={() => setOpenId(null)} />;

  if (bare) {
    return (
      <>
        {controls}
        {table}
        {drawer}
      </>
    );
  }
  return (
    <Panel title="Sessions" className="cost-panel cost-sessions" actions={controls} flush scroll>
      {table}
      {drawer}
    </Panel>
  );
}

function SessionDrawer({ session, onClose }: { session: SessionRow | null; onClose: () => void }) {
  const run = useRun(session?.runId ?? "", { enabled: !!session });
  const r = run.data?.run;
  return (
    <Drawer open={!!session} onOpenChange={(o) => !o && onClose()} title={session ? `Session ${startedLabel(session.started)}` : "Session"} subtitle={session ? `${regionOf(session)} · ${session.vmSize}` : undefined}>
      {session && (
        <div className="cost-drawer">
          <KeyValue
            items={[
              { label: "Status", value: session.stillRunning ? "Running" : "Stopped" },
              { label: "Duration", value: durationLabel(session.durationSeconds) },
              { label: "Estimated cost", value: gbp(session.estimatedGbp) },
              { label: "Cost per hour", value: gbp(session.perHourGbp) },
              { label: "Ended", value: session.ended ? startedLabel(session.ended) : null },
            ]}
          />
          <h3 className="cost-drawer__h">The deploy run</h3>
          {run.isPending && <Skeleton variant="block" height={96} />}
          {run.isError && <p className="cost-note">The run could not be loaded: {run.error instanceof Error ? run.error.message : "unknown error"}</p>}
          {r && (
            <KeyValue
              items={[
                { label: "Requested by", value: r.requested_by },
                { label: "Source", value: r.source },
                { label: "Public IP", value: r.public_ip, mono: true },
                { label: "Took", value: r.durationSeconds === null ? null : durationLabel(r.durationSeconds) },
              ]}
            />
          )}
          <p className="cost-note">Clients used and traffic are not recorded per session.</p>
          <Link className="cost-drawer__link" to={`/activity/runs/${encodeURIComponent(session.runId)}`}>
            Open the run in Activity
          </Link>
        </div>
      )}
    </Drawer>
  );
}
