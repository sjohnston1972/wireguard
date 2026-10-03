import { Box, Cloud, Globe, Home, MonitorSmartphone, Network, Users, UsersRound, type LucideIcon } from "lucide-react";
import type { SimEnd } from "@shared/api";
import { cx } from "@/components";
import type { Zone } from "./model";
import "./EndCell.css";

export const ZONE_ICON: Record<Zone, LucideIcon> = { clients: Users, home: Home, azure: Cloud, workloads: Box, internet: Globe };

export function endIcon(end: SimEnd): { Icon: LucideIcon; tone: string } {
  if (end.kind === "zone") return { Icon: ZONE_ICON[end.value as Zone] ?? Network, tone: end.value };
  if (end.kind === "client") return { Icon: MonitorSmartphone, tone: "clients" };
  if (end.kind === "cidr") return { Icon: Network, tone: "cidr" };
  return { Icon: UsersRound, tone: "any" };
}

/** A rule end in the table: zone icon, label, and its address underneath. */
export function EndCell({ end, label, address, className }: { end: SimEnd; label: string; address: string; className?: string }) {
  const { Icon, tone } = endIcon(end);
  return (
    <span className={cx("fw-end", className)}>
      <Icon className={cx("fw-end__icon", `fw-end__icon--${tone}`)} size={20} aria-hidden />
      <span className="fw-end__text">
        <span className="fw-end__label">{label}</span>
        {address && <span className="fw-end__addr">{address}</span>}
      </span>
    </span>
  );
}
