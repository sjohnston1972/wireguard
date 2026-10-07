import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { LabDetail, LabOrphan } from "@shared/api";
import { Button, Select, Switch } from "@/components";
import { ApiError } from "@/api/client";
import { useDeployLab } from "@/api/mutations";
import { useLabs } from "@/api/queries";
import { fmtGbp, fmtRate } from "./model";
import { blockerFix } from "./status";
import { Warnings, overridesFor } from "./Warnings";
import "./DeployForm.css";

const LAB_HOURS_MAX = 12; // shared/labs.ts LAB_HOURS_MAX: deploy and extend take whole hours, 1 to 12

const hoursLabel = (h: number) => (h === 1 ? "1 hour" : `${h} hours`);

/** "3 h old", "20 min old", "2 d old". */
function ageWords(seconds: number): string {
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min old`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h old`;
  return `${Math.round(seconds / 86_400)} d old`;
}

/**
 * What the Deploy form holds; the body and the footer both read it. A deploy is sent once (labs
 * redesign spec §13, ruling 19): a synchronous latch stops a second click before React re-renders,
 * and after success Deploy stays off ("Starting the deploy…") until the lab's session appears and
 * the dialog shows its progress. A refusal stays in the form with the server's sentence and, once
 * the lab has refreshed, the place to fix it.
 */
export function useDeployForm(d: LabDetail) {
  const [hours, setHours] = useState(() => Math.min(d.defaults.hours, d.card.timing.maxH));
  const [peer, setPeer] = useState(d.connectivity.peering === "required" ? true : d.connectivity.peering === "off" ? false : d.defaults.peer);
  const [region, setRegion] = useState(d.defaults.region);
  const deploy = useDeployLab();
  const latch = useRef(false);
  const [started, setStarted] = useState(false);
  const orphans = useLabs().data?.orphans;
  // "unavailable", or a budget warning with no override (the month is already over budget, so
  // the budget guard would remove the lab at once): Deploy is off and the reason is shown.
  const unavailable = d.warnings.find((w) => w.kind === "unavailable" || (w.kind === "budget" && !w.overridable))?.message ?? d.card.unavailable;
  const overrides = overridesFor(d.warnings);
  const anyway = Object.keys(overrides).length > 0;
  const busy = deploy.isPending || started;
  const submit = () => {
    if (unavailable || busy || latch.current) return;
    latch.current = true;
    const r = region.trim();
    deploy.mutate(
      { id: d.card.id, hours, peer: d.connectivity.peering === "required" ? true : d.connectivity.peering === "off" ? false : peer, ...(r ? { region: r } : {}), ...overrides },
      {
        onSuccess: () => setStarted(true),
        onSettled: () => {
          latch.current = false;
        },
      },
    );
  };
  const failure = !busy && deploy.error ? deploy.error : null;
  return { d, hours, setHours, peer, setPeer, region, setRegion, deploy, unavailable, anyway, submit, busy, started, failure, refusal: refusalOf(d, failure, orphans) };
}

/** A refused deploy: the server's sentence and, from the refreshed card's blockers, where to fix it. */
function refusalOf(d: LabDetail, err: Error | null, orphans: LabOrphan[] | undefined): { message: string; fix: { label: string; href: string } | null } | null {
  if (!err) return null;
  const blockers = Array.isArray(d.card.blockers) ? d.card.blockers : [];
  const code = err instanceof ApiError ? err.code : null;
  const b = blockers.find((x) => x.message === err.message) ?? (code === "unavailable" ? blockers[0] : undefined);
  const fix = b ? blockerFix(b.kind, { labId: d.card.id, orphans }) : null;
  return { message: err.message, fix: fix && !fix.href.startsWith("#") ? fix : null };
}
export type DeployFormState = ReturnType<typeof useDeployForm>;

/** Each priced item (£/h each, where the price came from) and the totals per hour and for the chosen session. */
export function CostTable({ d, hours }: { d: LabDetail; hours: number }) {
  return (
    <div className="labs-cost">
      <table className="labs-cost__table" aria-label="Cost">
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col" className="labs-num">
              Each
            </th>
            <th scope="col">Price</th>
          </tr>
        </thead>
        <tbody>
          {d.cost.items.map((it, i) => (
            <tr key={`${it.name}-${i}`}>
              <td>
                {it.name}
                {(it.qty ?? 1) > 1 && <span className="labs-muted"> × {it.qty}</span>}
              </td>
              <td className="labs-num">{fmtRate(it.gbpH)}</td>
              <td className="labs-muted">{it.source === "azure" && it.priceAge !== null ? `Azure price, ${ageWords(it.priceAge)}` : "Estimate"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="labs-cost__total">
        <strong>{fmtGbp(d.cost.gbpH)} an hour</strong>
        <span aria-hidden> · </span>
        <strong>
          {fmtGbp(d.cost.gbpH * hours)} for {hours} h
        </strong>
      </p>
      <p className="labs-muted">GBP list prices before discounts and VAT. An estimate is used where Azure has no price under 7 days old.</p>
    </div>
  );
}

/** Session length, Peer to gateway, Region (spec §10), with the warnings above them. */
export function DeployFields({ f }: { f: DeployFormState }) {
  const { d } = f;
  const max = Math.min(d.card.timing.maxH, LAB_HOURS_MAX);
  const options = Array.from({ length: max }, (_, i) => ({ value: String(i + 1), label: hoursLabel(i + 1) }));
  const mode = d.connectivity.peering;
  return (
    <form
      className="labs-deploy"
      id="labs-deploy-form"
      onSubmit={(e) => {
        e.preventDefault();
        f.submit();
      }}
    >
      {f.refusal && (
        <div className="labs-deploy__refused" role="alert">
          <p>{f.refusal.message}</p>
          {f.refusal.fix && (
            <Link className="labs-deploy__fix" to={f.refusal.fix.href}>
              {f.refusal.fix.label}
            </Link>
          )}
        </div>
      )}
      <Warnings warnings={d.warnings} />
      {f.unavailable && !d.warnings.some((w) => w.kind === "unavailable") && f.refusal?.message !== f.unavailable && <p className="labs-deploy__blocked">{f.unavailable}</p>}
      <div className="labs-deploy__row">
        <span className="labs-deploy__label">Session length</span>
        <Select label="Session length" options={options} value={String(f.hours)} onValueChange={(v) => f.setHours(Number(v))} />
        <span className="labs-muted">Up to {hoursLabel(d.card.timing.maxH)}; then it is torn down whatever happens.</span>
      </div>
      {mode !== "off" && (
        <div className="labs-deploy__row">
          <span className="labs-deploy__label">Peer to gateway</span>
          <Switch label="Peer to gateway" checked={mode === "required" ? true : f.peer} disabled={mode === "required"} onCheckedChange={f.setPeer} />
          {mode === "required" && <span className="labs-muted">This lab needs peering.</span>}
          {!d.gatewayUp && <span className="labs-muted">The gateway is not running: it will peer when the gateway is next running.</span>}
        </div>
      )}
      <div className="labs-deploy__row">
        <label className="labs-deploy__label" htmlFor="labs-region">
          Region
        </label>
        <input id="labs-region" className="labs-input" value={f.region} onChange={(e) => f.setRegion(e.target.value)} spellCheck={false} autoComplete="off" />
        <span className="labs-muted">From Settings unless you change it here.</span>
      </div>
    </form>
  );
}

/** The footer: Deploy (or Deploy anyway when a budget or capacity warning stands), with the session's cost beside it. */
export function DeployFooter({ f }: { f: DeployFormState }) {
  return (
    <div className="labs-foot">
      {f.started ? (
        <span className="labs-muted" role="status">
          Starting the deploy…
        </span>
      ) : (
        <span className="labs-muted">
          About {fmtGbp(f.d.cost.gbpH * f.hours)} for {hoursLabel(f.hours)}
        </span>
      )}
      <Button variant="primary" onClick={f.submit} loading={f.busy} disabled={!!f.unavailable || f.busy}>
        {f.anyway ? "Deploy anyway" : "Deploy"}
      </Button>
    </div>
  );
}
