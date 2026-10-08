import { useState } from "react";
import { Command } from "cmdk";
import { useNavigate } from "react-router-dom";
import { Activity, Cog, FlaskConical, Play, Plus, Search, Shield, Users, Zap, type LucideIcon } from "lucide-react";
import { TABS } from "@/routes";
import { useActivity, useClients, useFirewall, useLabs } from "@/api/queries";
import { useDemo } from "@/api/demo";
import "./palette.css";

/**
 * Ctrl/Cmd+K. Navigation only: every entry goes to a view. Actions go to the
 * view with `?action=...`; that view opens its normal reviewed form. Nothing
 * here ever calls a write endpoint.
 */

export const SETTINGS_SECTIONS: { slug: string; label: string }[] = [
  { slug: "overview", label: "Overview" },
  { slug: "deployment", label: "Deployment" },
  { slug: "automation", label: "Automation" },
  { slug: "security", label: "Security" },
  { slug: "backup", label: "Backup & Recovery" },
  { slug: "mobile", label: "Mobile" },
  { slug: "labs", label: "Labs" },
  { slug: "maintenance", label: "Maintenance" },
  { slug: "demo", label: "Demo mode" },
];

/** The dev server's seed stories (demo mode spec §8.4): a section only while GET /demo offers them. */
export const DEV_DATA_SECTION = { slug: "dev-data", label: "Dev data" };

/** Settings' sections as shown: the fixed nine, plus Dev data on the dev server. */
export function useSettingsSections(): { slug: string; label: string }[] {
  const devSeed = useDemo().data?.devSeed;
  return devSeed ? [...SETTINGS_SECTIONS, DEV_DATA_SECTION] : SETTINGS_SECTIONS;
}

export const ACTIONS: { label: string; to: string; icon: LucideIcon; keywords?: string }[] = [
  { label: "Deploy", to: "/?action=deploy", icon: Play, keywords: "start vm up" },
  { label: "Tear down", to: "/?action=destroy", icon: Zap, keywords: "destroy delete stop" },
  { label: "Hibernate", to: "/?action=hibernate", icon: Zap, keywords: "standby deallocate" },
  { label: "Resume", to: "/?action=resume", icon: Play, keywords: "wake standby" },
  { label: "Extend", to: "/?action=extend", icon: Zap, keywords: "timer auto-destroy" },
  { label: "Add client", to: "/clients?action=add", icon: Plus, keywords: "new peer device" },
  { label: "Add firewall rule", to: "/firewall?action=add-rule", icon: Plus, keywords: "new policy" },
  { label: "Start capture", to: "/firewall?action=capture", icon: Shield, keywords: "packet tcpdump" },
  { label: "Speed test", to: "/?action=speedtest", icon: Zap, keywords: "bandwidth" },
];

/** "Deploy lab..." and "Tear down lab..." each ask which lab, as a second list in the palette. */
type LabPage = "deploy" | "teardown" | null;

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const [page, setPage] = useState<LabPage>(null);
  // Held until the palette is first opened, then kept fresh while it is open.
  const clients = useClients({ enabled: open });
  const firewall = useFirewall({ enabled: open });
  const activity = useActivity({ range: "7d" }, { enabled: open });
  // The catalogue is asked for only while the palette is open.
  const labs = useLabs({ enabled: open }).data;
  const catalogue = labs?.labs ?? [];
  const liveLabs = catalogue.filter((l) => l.running);

  const go = (to: string) => {
    onOpenChange(false);
    navigate(to);
  };
  const close = (v: boolean) => {
    if (!v) setPage(null);
    onOpenChange(v);
  };
  const labItems = (list: typeof catalogue) =>
    list.map((l) => (
      <Item key={l.id} value={`Lab ${l.number} ${l.title} ${l.exam} lab`} icon={FlaskConical} hint={l.running ? "running" : l.exam} onSelect={() => go(`/labs/${l.id}`)}>
        {`Lab ${l.number}: ${l.title}`}
      </Item>
    ));
  const latestRun = activity.data?.runs[0];
  const sections = useSettingsSections();

  return (
    <Command.Dialog open={open} onOpenChange={close} label="Command palette" className="palette" overlayClassName="palette__overlay" contentClassName="palette__content">
      <div className="palette__input-row">
        <Search size={16} aria-hidden="true" />
        <Command.Input className="palette__input" placeholder="Search clients, rules, settings, actions..." />
      </div>
      <Command.List className="palette__list">
        <Command.Empty className="palette__empty">Nothing matches.</Command.Empty>

        {page ? (
          <Command.Group heading={page === "deploy" ? "Deploy which lab?" : "Tear down which lab?"} className="palette__group">
            {labItems(page === "deploy" ? catalogue : liveLabs)}
            <Item value="Back to the palette" icon={Search} onSelect={() => setPage(null)}>
              Back
            </Item>
          </Command.Group>
        ) : null}

        {page ? null : (
          <>
        <Command.Group heading="Go to" className="palette__group">
          {TABS.map((t) => (
            <Item key={t.to} value={`Go to ${t.label}`} icon={t.icon} onSelect={() => go(t.to)}>
              Go to {t.label}
            </Item>
          ))}
          {sections.map((s) => (
            <Item key={s.slug} value={`Settings: ${s.label}`} icon={Cog} onSelect={() => go(`/settings/${s.slug}`)}>
              Settings: {s.label}
            </Item>
          ))}
          {latestRun ? (
            <Item value={`Latest run ${latestRun.id} ${latestRun.action}`} icon={Activity} hint={`${latestRun.action} · ${latestRun.status}`} onSelect={() => go(`/activity/runs/${encodeURIComponent(latestRun.id)}`)}>
              Latest run
            </Item>
          ) : null}
        </Command.Group>

        {clients.data?.clients.length ? (
          <Command.Group heading="Clients" className="palette__group">
            {clients.data.clients.map((c) => (
              <Item key={c.id} value={`${c.name} ${c.ip} client`} icon={Users} hint={c.ip} mono onSelect={() => go(`/clients/${c.id}`)}>
                {c.name}
              </Item>
            ))}
          </Command.Group>
        ) : null}

        {firewall.data?.rules.length ? (
          <Command.Group heading="Firewall rules" className="palette__group">
            {firewall.data.rules.map((r) => (
              <Item key={r.id} value={`${r.name} firewall rule`} icon={Shield} onSelect={() => go(`/firewall/rules/${r.id}`)}>
                {r.name}
              </Item>
            ))}
          </Command.Group>
        ) : null}

        {catalogue.length ? (
          <Command.Group heading="Labs" className="palette__group">
            {labItems(catalogue)}
          </Command.Group>
        ) : null}

        <Command.Group heading="Actions (opens the form, nothing runs)" className="palette__group">
          {ACTIONS.map((a) => (
            <Item key={a.label} value={`${a.label} ${a.keywords ?? ""}`} icon={a.icon} onSelect={() => go(a.to)}>
              {a.label}
            </Item>
          ))}
          {catalogue.length ? (
            <Item value="Deploy lab… start a lab environment" icon={FlaskConical} onSelect={() => setPage("deploy")}>
              Deploy lab…
            </Item>
          ) : null}
          {liveLabs.length ? (
            <Item value="Tear down lab… stop a lab destroy" icon={FlaskConical} onSelect={() => setPage("teardown")}>
              Tear down lab…
            </Item>
          ) : null}
        </Command.Group>
          </>
        )}
      </Command.List>
    </Command.Dialog>
  );
}

function Item({ value, icon: Icon, hint, mono, onSelect, children }: { value: string; icon: LucideIcon; hint?: string; mono?: boolean; onSelect: () => void; children: string | string[] }) {
  return (
    <Command.Item value={value} onSelect={onSelect} className="palette__item">
      <Icon size={16} aria-hidden="true" />
      <span className="palette__label">{children}</span>
      {hint ? <span className={mono ? "palette__hint palette__hint--mono" : "palette__hint"}>{hint}</span> : null}
    </Command.Item>
  );
}
