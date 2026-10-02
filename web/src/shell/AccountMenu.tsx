import { useState } from "react";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { ChevronDown, LogOut, Moon, Sun, User } from "lucide-react";
import { useSession } from "@/api/queries";
import { currentTheme, setTheme } from "./theme";
import "./account.css";

/** "AL" from "ada.lovelace@example.com", "DE" from "dev@localhost". */
export function initialsOf(email: string): string {
  const local = email.split("@")[0] ?? "";
  const parts = local.split(/[._\-+\s]+/).filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

export const LOGOUT_URL = "/cdn-cgi/access/logout";

export function AccountMenu() {
  const { data } = useSession();
  const [, force] = useState(0);
  const email = data?.user ?? null;
  const initials = email ? initialsOf(email) : "";
  const next = currentTheme() === "dark" ? "light" : "dark";
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>
        <button type="button" className="topbar__account" aria-label="Account menu">
          <span className="topbar__avatar" aria-hidden="true">
            {initials || <User size={16} />}
          </span>
          <span className="topbar__account-text">{email ?? "Account"}</span>
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className="menu" align="end" sideOffset={8}>
          {email ? <div className="menu__who">{email}</div> : null}
          <Dropdown.Item
            className="menu__item"
            onSelect={() => {
              setTheme(next);
              force((n) => n + 1);
            }}
          >
            {next === "light" ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
            Switch to {next} theme
          </Dropdown.Item>
          <Dropdown.Separator className="menu__sep" />
          <Dropdown.Item asChild className="menu__item">
            <a href={LOGOUT_URL}>
              <LogOut size={16} aria-hidden="true" />
              Sign out
            </a>
          </Dropdown.Item>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
