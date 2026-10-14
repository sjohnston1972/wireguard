// auditKinds.ts
//
// Plain English: the change log's "Show" filter options. Kept apart from activity.ts, which
// reaches the Worker runtime, so the dashboard can import it.

/** The change log's "Show" filter: the first word of each change's action. */
export const AUDIT_KINDS: { value: string; label: string }[] = [
  { value: "", label: "All changes" },
  { value: "client", label: "Clients" },
  { value: "firewall", label: "Firewall and published ports" },
  { value: "settings", label: "Settings" },
  { value: "profile", label: "Profiles" },
  { value: "schedule", label: "Schedules" },
  { value: "push", label: "Phone alerts" },
  { value: "capture", label: "Packet captures" },
  { value: "lock", label: "Run lock" },
  { value: "config", label: "Backup and restore" },
];
