import type { LabDetail } from "@shared/api";

/** The lab modal while a session is live (plan L3.4). */
export function RunningLab({ d }: { d: LabDetail }) {
  return <p className="labs-muted">{d.card.title} is running.</p>;
}

export function RunningFooter({ d }: { d: LabDetail }) {
  void d;
  return null;
}
