import { useEffect, type ReactNode } from "react";
import { Navigate, useBlocker, useNavigate, useParams } from "react-router-dom";
import type { OverviewResponse, SettingsResponse } from "@shared/api";
import { useOverview, useSettings } from "@/api/queries";
import { Button, ErrorState, Modal, PageHeader, Sheet, Tabs, useIsPhone, type TabItem } from "@/components";
import { useSettingsSections } from "@/shell/CommandPalette";
import { EnvironmentField } from "@/shell/StateChip";
import { useDemo } from "@/api/demo";
import { ChevronRight, Clock, Cloud, Database, FlaskConical, Presentation, Settings as Cog, ShieldCheck, Smartphone, Sprout, Wrench, type LucideIcon } from "lucide-react";
import { AutomationSection } from "./AutomationSection";
import { BackupSection } from "./BackupSection";
import { DeploymentSection } from "./DeploymentSection";
import { EditsProvider, useEdits } from "./edits";
import { lazyPart } from "@/widgets";
import { MaintenanceSection } from "./MaintenanceSection";
import { MobileSection } from "./MobileSection";
import { OverviewSection } from "./OverviewSection";
import { SecuritySection } from "./SecuritySection";
import { SettingsSkeleton, Stat, gbp } from "./ui";
import "./settings.css";

/** Settings → Labs loads only when opened (it is the one section most people never visit). */
const LabsSection = lazyPart(() => import("./LabsSection").then((m) => m.LabsSection));
/** Settings → Demo mode loads when opened (the banner's Turn off needs none of it). */
const DemoSection = lazyPart(() => import("./DemoSection").then((m) => m.DemoSection));
/** Settings → Dev data exists only on the dev server: its code loads only when opened there. */
const DevDataSection = lazyPart(() => import("./DevDataSection").then((m) => m.DevDataSection));

const ICONS: Record<string, LucideIcon> = {
  overview: Cog,
  deployment: Cloud,
  automation: Clock,
  security: ShieldCheck,
  backup: Database,
  mobile: Smartphone,
  labs: FlaskConical,
  maintenance: Wrench,
  demo: Presentation,
  "dev-data": Sprout,
};

/** One line under each section's name on the phone's list. */
const BLURB: Record<string, string> = {
  overview: "State of the setup at a glance",
  deployment: "Region, size, profiles",
  automation: "Schedules, timers, budget",
  security: "Server key and SSH",
  backup: "Export, nightly copies, restore",
  mobile: "Install and phone alerts",
  labs: "Lab limits, permissions, release tests",
  maintenance: "Health check, lock, destroy",
  demo: "Show made-up data for demos",
  "dev-data": "Load a seed story (dev server only)",
};

/** Sections that need nothing from /settings: they open even while it fails (demo mode spec §8.3). */
const STANDALONE = new Set(["demo", "dev-data"]);

type Section = { slug: string; label: string };

/**
 * Settings (spec 8.6): nine sections at /settings/:section, one at a time (Labs from the labs plan,
 * Demo mode from the demo mode plan), plus Dev data on the dev server.
 */
export function SettingsPage() {
  const { section } = useParams();
  const phone = useIsPhone();
  const settings = useSettings();
  const overview = useOverview();
  const demo = useDemo();
  const sections = useSettingsSections();

  // Dev data is listed only once GET /demo says the dev seeder is here: wait for that answer before judging the address.
  const deciding = section === "dev-data" && !demo.data && !demo.isError;
  // A section that does not exist falls back to the overview (on the phone, to the list).
  if (section !== undefined && !deciding && !sections.some((x) => x.slug === section)) return <Navigate to={phone ? "/settings" : "/settings/overview"} replace />;

  const s = settings.data;
  const standalone = section !== undefined && STANDALONE.has(section);
  return (
    <div className="settings">
      <PageHeader
        title="Settings"
        subtitle="Configure your WireGuard environment, automation and operational settings."
        env={<EnvironmentField />}
        right={s && !phone ? <HeaderStats s={s} /> : undefined}
      />
      {/* Always outside the /settings tree, so it never remounts when /settings answers (or fails). */}
      {deciding ? (
        <SettingsSkeleton />
      ) : standalone ? (
        <Bare sections={sections} section={section} phone={phone} />
      ) : settings.isError && !s ? (
        <ErrorState message={settings.error.message} onRetry={() => void settings.refetch()} />
      ) : !s ? (
        <SettingsSkeleton />
      ) : (
        <EditsProvider values={s.values}>
          <Loaded s={s} ov={overview.data} updated={{ settings: settings.dataUpdatedAt, overview: overview.dataUpdatedAt }} section={section} phone={phone} sections={sections} />
        </EditsProvider>
      )}
    </div>
  );
}

/** The body of a section that needs nothing from /settings (null for any other). */
function standaloneBody(slug: string): ReactNode {
  if (slug === "demo") return <DemoSection />;
  if (slug === "dev-data") return <DevDataSection />;
  return null;
}

/** The section list on the phone: name, icon and one line each. */
function PhoneList({ sections, onOpen }: { sections: Section[]; onOpen: (slug: string) => void }) {
  return (
    <ul className="set-phone-list" aria-label="Settings sections">
      {sections.map(({ slug, label }) => {
        const Icon = ICONS[slug] ?? Cog;
        return (
          <li key={slug}>
            <button type="button" className="set-phone-list__item" onClick={() => onOpen(slug)}>
              <Icon size={20} aria-hidden />
              <span className="set-phone-list__text">
                <span className="set-phone-list__name">{label}</span>
                <span className="set-phone-list__blurb">{BLURB[slug]}</span>
              </span>
              <ChevronRight size={18} aria-hidden />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A standalone section (Demo mode, Dev data): the section tabs (or the phone's list and a sheet)
 * around a body that needs nothing from /settings. Nothing here can be unsaved, so it needs no
 * leave guard (a dirty section asks before its own page is left).
 */
function Bare({ sections, section, phone }: { sections: Section[]; section: string; phone: boolean }) {
  const nav = useNavigate();
  const open = sections.find((x) => x.slug === section);
  if (phone)
    return (
      <>
        <PhoneList sections={sections} onOpen={(slug) => nav(`/settings/${slug}`)} />
        {open && (
          <Sheet open onOpenChange={(o) => !o && nav("/settings")} title={open.label}>
            {standaloneBody(open.slug)}
          </Sheet>
        )}
      </>
    );
  const items: TabItem[] = sections.map(({ slug, label }) => {
    const Icon = ICONS[slug] ?? Cog;
    return { value: slug, label, icon: <Icon size={16} aria-hidden /> };
  });
  return (
    <>
      <Tabs variant="pill" aria-label="Settings sections" className="set-tabs" items={items} value={section} onValueChange={(v) => v !== section && nav(`/settings/${v}`)} />
      <div className="settings__body">{standaloneBody(section)}</div>
    </>
  );
}

function HeaderStats({ s }: { s: SettingsResponse }) {
  return (
    <>
      <Stat className="set-hstat" label="Region" value={s.regions[s.values.region] ?? s.values.region} />
      <Stat className="set-hstat" label="VM size" value={s.values.vmSize} />
      <div className="set-hstat set-hstat--cost" role="group" aria-label="Estimated cost per day">
        <span className="set-stat__label">Estimated cost</span>
        <span className="set-stat__value">
          <strong>{gbp(s.values.hourlyRateGbp * 24)}</strong> <span className="set-muted">/ day</span>
        </span>
      </div>
    </>
  );
}

function Loaded({
  s,
  ov,
  updated,
  section,
  phone,
  sections,
}: {
  s: SettingsResponse;
  ov: OverviewResponse | undefined;
  updated: { settings: number; overview: number };
  section: string | undefined;
  phone: boolean;
  sections: Section[];
}) {
  const nav = useNavigate();
  const edits = useEdits();
  const current = section ?? "overview";
  // A dirty section asks before anything takes the page away (section tabs,
  // the top nav, the phone tab bar, the palette, Back, a link in the page), in
  // the page (never window.confirm). Changing only the query string is not leaving.
  const dirty = edits.isDirty(current);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);
  const leaving = blocker.state === "blocked";
  const anyDirty = sections.some((k) => edits.isDirty(k.slug));
  useEffect(() => {
    if (!anyDirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [anyDirty]);

  const body = (slug: string): ReactNode => {
    switch (slug) {
      case "deployment":
        return <DeploymentSection s={s} />;
      case "automation":
        return <AutomationSection s={s} ov={ov} />;
      case "security":
        return <SecuritySection s={s} />;
      case "backup":
        return <BackupSection s={s} />;
      case "mobile":
        return <MobileSection s={s} />;
      case "labs":
        return <LabsSection />;
      case "maintenance":
        return <MaintenanceSection s={s} ov={ov} />;
      default:
        return <OverviewSection s={s} ov={ov} updated={updated} />;
    }
  };

  const items: TabItem[] = sections.map(({ slug, label }) => {
    const Icon = ICONS[slug] ?? Cog;
    const dirty = edits.isDirty(slug);
    return {
      value: slug,
      label,
      dot: dirty ? "amber" : undefined,
      icon: (
        <>
          <Icon size={16} aria-hidden />
          {dirty && <span className="visually-hidden">Unsaved changes in</span>}{dirty && " "}
        </>
      ),
    };
  });

  const guard = (
    <Modal
      open={leaving}
      onOpenChange={(o) => !o && blocker.reset?.()}
      title="Leave without saving?"
      description={`You have unsaved changes in ${sections.find((x) => x.slug === current)?.label}. Leaving throws them away.`}
      footer={
        <>
          <Button variant="ghost" onClick={() => blocker.reset?.()}>
            Keep editing
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              edits.discard(current);
              blocker.proceed?.();
            }}
          >
            Discard and leave
          </Button>
        </>
      }
    />
  );

  if (phone) {
    const open = section ? sections.find((x) => x.slug === section) : undefined;
    return (
      <>
        <PhoneList sections={sections} onOpen={(slug) => nav(`/settings/${slug}`)} />
        {open && (
          <Sheet open onOpenChange={(o) => !o && nav("/settings")} title={open.label}>
            {body(open.slug)}
          </Sheet>
        )}
        {guard}
      </>
    );
  }

  return (
    <>
      <Tabs variant="pill" aria-label="Settings sections" className="set-tabs" items={items} value={current} onValueChange={(v) => v !== current && nav(`/settings/${v}`)} />
      <div className="settings__body">{body(current)}</div>
      {guard}
    </>
  );
}
