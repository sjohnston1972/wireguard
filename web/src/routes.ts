import { Activity, DollarSign, LayoutDashboard, Settings, Shield, Users, type LucideIcon } from "lucide-react";

/** The six top-level tabs, in display order. `to` is where the tab links. */
export interface TabDef {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Only the exact path marks this tab current (Overview lives at "/"). */
  end?: boolean;
}

export const TABS: TabDef[] = [
  { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/clients", label: "Clients", icon: Users },
  { to: "/firewall", label: "Firewall", icon: Shield },
  { to: "/activity", label: "Activity", icon: Activity },
  { to: "/cost", label: "Cost", icon: DollarSign },
  { to: "/settings", label: "Settings", icon: Settings },
];
