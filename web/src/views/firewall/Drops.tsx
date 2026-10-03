import { Globe, MonitorSmartphone } from "lucide-react";
import type { FirewallResponse } from "@shared/api";
import { Button, DataAge, EmptyState, Panel } from "@/components";
import { useDraftFromDrop } from "@/api/mutations";
import { useWidget } from "@/widgets";
import { zoneOfIp } from "./model";
import "./Drops.css";

type Drop = FirewallResponse["drops"]["recent"][number];

const ukTime = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/London" });
const utcTime = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
export const dropService = (d: Pick<Drop, "proto" | "dport">) => `${d.proto.toUpperCase()}${d.dport !== null ? ` ${d.dport}` : ""}`;

/**
 * The list of recent drops; "Allow" adds an allow rule for that flow to the
 * draft. The Recent drops widget's settings: how many, UK time or UTC, and
 * whether each line has its zone chip and Allow button.
 */
export function DropsList({ fw }: { fw: FirewallResponse }) {
  const fromDrop = useDraftFromDrop();
  const { settings } = useWidget("firewall.drops");
  const max = settings.max === "all" ? Infinity : Number(settings.max);
  const utc = settings.timeZone === "utc";
  const drops = fw.drops.recent.slice(0, max);
  const zoneLabel = (z: string) => fw.zones.find((x) => x.zone === z)?.label ?? z;
  if (drops.length === 0) {
    return <EmptyState title="No recent drops" description={fw.running ? "Nothing was blocked lately. Blocked flows show here as the VM reports them." : "The VM is not running, so nothing is being blocked or reported."} />;
  }
  return (
    <ul className="fw-drops">
      {drops.map((d, i) => {
        const svc = dropService(d);
        const pending = fromDrop.isPending && fromDrop.variables?.src === d.src && fromDrop.variables?.dst === d.dst && fromDrop.variables?.dport === d.dport;
        const from = zoneOfIp(d.src, fw.zones);
        const to = zoneOfIp(d.dst, fw.zones);
        const Icon = from === "clients" ? MonitorSmartphone : Globe;
        return (
          <li key={`${d.at}-${i}`} className="fw-drops__item">
            {utc ? (
              <time className="fw-drops__time" dateTime={d.at} title={`${utcTime.format(new Date(d.at))} UTC`}>
                {utcTime.format(new Date(d.at))}
              </time>
            ) : (
              <time className="fw-drops__time" dateTime={d.at}>
                {ukTime.format(new Date(d.at))}
              </time>
            )}
            <Icon className="fw-drops__icon" size={18} aria-hidden />
            <span className="fw-drops__main">
              <span className="fw-drops__svc">{svc}</span>
              <span className="fw-drops__flow">
                {d.src} → {d.dst}
              </span>
              {settings.zoneChip && (
                <span className="fw-drops__chip" title={`${d.fromName} → ${d.toName}`}>
                  {zoneLabel(from)} → {zoneLabel(to)}
                </span>
              )}
            </span>
            {settings.allowButton && (
              <Button
                size="sm"
                className="fw-drops__allow"
                aria-label={`Allow ${svc} from ${d.fromName} to ${d.toName}`}
                loading={pending}
                disabled={fromDrop.isPending}
                onClick={() => fromDrop.mutate({ src: d.src, dst: d.dst, proto: d.proto, dport: d.dport })}
              >
                Allow
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function DropsPanel({ fw, updatedAt }: { fw: FirewallResponse; updatedAt: number }) {
  return (
    <Panel title="Recent drops" actions={<DataAge at={updatedAt} />} scroll className="fw-drops-panel">
      <p className="fw-panel-sub">Traffic the firewall blocked. Allow adds a rule to the draft.</p>
      <DropsList fw={fw} />
    </Panel>
  );
}
