import { useEffect, type ReactNode } from "react";
import { Navigate, useBlocker, useNavigate, useParams } from "react-router-dom";
import type { OverviewResponse, SettingsResponse } from "@shared/api";
import { useOverview, useSettings } from "@/api/queries";
import { Button, ErrorState, Modal, PageHeader, Sheet, Tabs, useIsPhone, type TabItem } from "@/components";
import { SETTINGS_SECTIONS } from "@/shell/CommandPalette";
import { EnvironmentField } from "@/shell/StateChip";
import { ChevronRight, Clock, Cloud, Database, FlaskConical, Settings as Cog, ShieldCheck, Smartphone, Wrench, type LucideIcon } from "lucide-react";
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

const ICONS: Record<string, LucideIcon> = {
  overview: Cog,
  deployment: Cloud,
  automation: Clock,
  security: ShieldCheck,
  backup: Database,
  mobile: Smartphone,
  labs: FlaskConical,
  maintenance: Wrench,
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
};

const SLUGS = SETTINGS_SECTIONS.map((s) => s.slug);

/** Settings (spec 8.6): eight sections at /settings/:section, one at a time (Labs from the labs plan). */
export function SettingsPage() {
  const { section } = useParams();
  const phone = useIsPhone();
  const settings = useSettings();
  const overview = useOverview();

  // A section that does not exist falls back to the overview (on the phone, to the list).
  if (section !== undefined && !SLUGS.includes(section)) return <Navigate to={phone ? "/settings" : "/settings/overview"} replace />;

  const s = settings.data;
  return (
    <div className="settings">
      <PageHeader
        title="Settings"
        subtitle="Configure your WireGuard environment, automation and operational settings."
        env={<EnvironmentField />}
        right={s && !phone ? <HeaderStats s={s} /> : undefined}
      />
      {settings.isError && !s ? (
        <ErrorState message={settings.error.message} onRetry={() => void settings.refetch()} />
      ) : !s ? (
        <SettingsSkeleton />
      ) : (
        <EditsProvider values={s.values}>
          <Loaded s={s} ov={overview.data} updated={{ settings: settings.dataUpdatedAt, overview: overview.dataUpdatedAt }} section={section} phone={phone} />
        </EditsProvider>
      )}
    </div>
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

function Loaded({ s, ov, updated, section, phone }: { s: SettingsResponse; ov: OverviewResponse | undefined; updated: { settings: number; overview: number }; section: string | undefined; phone: boolean }) {
  const nav = useNavigate();
  const edits = useEdits();
  const current = section ?? "overview";
  // A dirty section asks before anything takes the page away (section tabs,
  // the top nav, the phone tab bar, the palette, Back, a link in the page), in
  // the page (never window.confirm). Changing only the query string is not leaving.
  const dirty = edits.isDirty(current);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);
  const leaving = blocker.state === "blocked";
  const anyDirty = SLUGS.some((k) => edits.isDirty(k));
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

  const items: TabItem[] = SETTINGS_SECTIONS.map(({ slug, label }) => {
    const Icon = ICONS[slug]!;
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
      description={`You have unsaved changes in ${SETTINGS_SECTIONS.find((x) => x.slug === current)?.label}. Leaving throws them away.`}
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
    const open = section ? SETTINGS_SECTIONS.find((x) => x.slug === section) : undefined;
    return (
      <>
        <ul className="set-phone-list" aria-label="Settings sections">
          {SETTINGS_SECTIONS.map(({ slug, label }) => {
            const Icon = ICONS[slug]!;
            return (
              <li key={slug}>
                <button type="button" className="set-phone-list__item" onClick={() => nav(`/settings/${slug}`)}>
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
