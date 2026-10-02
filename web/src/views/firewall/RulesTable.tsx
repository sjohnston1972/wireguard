import * as Menu from "@radix-ui/react-dropdown-menu";
import { AlertTriangle, GripVertical, Lock, MoreVertical, MoveRight } from "lucide-react";
import { type KeyboardEvent } from "react";
import type { FirewallResponse } from "@shared/api";
import { IconButton, Sparkline, StatusPill, Switch, cx } from "@/components";
import { EndCell } from "./EndCell";
import { endAddress, fmtCount, type Action, type RuleView } from "./model";
import "./RulesTable.css";

export interface DefaultRowInfo {
  action: Action;
  hits24h: number | null;
  trend24h: (number | null)[];
  changed: boolean;
}

export interface RulesTableProps {
  rows: RuleView[];
  showDefault: boolean;
  defaultRow: DefaultRowInfo;
  zones: FirewallResponse["zones"];
  /** Ids whose enabled switch has a request in flight. */
  busyIds?: ReadonlySet<number>;
  onToggle: (row: RuleView, enabled: boolean) => void;
  onOpen: (id: number) => void;
  onHistory: (id: number) => void;
  onMove: (row: RuleView, dir: "up" | "down") => void;
  onDelete: (row: RuleView) => void;
  onEditDefault: () => void;
  /** The first and last rule of the whole list, which cannot move further up or down. */
  firstId: number | null;
  lastId: number | null;
  /** Drag-and-drop and Alt+Arrow wiring for a rule's row (see useReorder). */
  rowProps?: (row: RuleView) => Record<string, unknown>;
  handleProps?: (row: RuleView) => Record<string, unknown>;
  dropMark?: (row: RuleView) => "above" | "below" | null;
  isDragging?: (row: RuleView) => boolean;
  /** Alt+ArrowUp/Down on a focused rule row. */
  onAltArrow?: (row: RuleView, dir: "up" | "down") => void;
}

const MARK_WORD = { added: "Added", changed: "Changed", moved: "Moved" } as const;

function HitsCell({ hits, trend, onClick, name }: { hits: number | null; trend: (number | null)[]; onClick?: () => void; name: string }) {
  const inner =
    hits === null ? (
      <span className="fw-rules__nodata">no data</span>
    ) : (
      <>
        <span className="fw-rules__hits-n">{fmtCount(hits)}</span>
        <Sparkline variant="bars" tone="blue" label={`Hits per hour for ${name}`} data={trend} width={52} height={20} />
      </>
    );
  return (
    <span className="fw-rules__hits" data-testid="hits">
      {onClick ? (
        <button type="button" className="fw-rules__hits-btn" onClick={onClick} aria-label={`Hit history for ${name}: ${hits === null ? "no data" : fmtCount(hits)}`}>
          {inner}
        </button>
      ) : (
        inner
      )}
    </span>
  );
}

/** The rules table: draggable rows in policy order, the fixed default row last. */
export function RulesTable(p: RulesTableProps) {
  const onRowKey = (e: KeyboardEvent<HTMLTableRowElement>, row: RuleView | "default") => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (row === "default") p.onEditDefault();
      else p.onOpen(row.id);
      return;
    }
    if (e.altKey) {
      // Alt+Arrow reorders; the default row never moves.
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      if (row !== "default") p.onAltArrow?.(row, e.key === "ArrowUp" ? "up" : "down");
      return;
    }
    const tr = e.currentTarget;
    let to: Element | null = null;
    if (e.key === "ArrowDown") to = tr.nextElementSibling;
    else if (e.key === "ArrowUp") to = tr.previousElementSibling;
    else return;
    e.preventDefault();
    if (to instanceof HTMLElement) to.focus();
  };

  return (
    <table className="fw-rules dt__table" aria-label="Firewall rules">
      <thead>
        <tr>
          <th scope="col" className="dt__th fw-rules__c-handle">
            <span className="visually-hidden">Reorder</span>
          </th>
          <th scope="col" className="dt__th fw-rules__c-place">#</th>
          <th scope="col" className="dt__th fw-rules__c-name">Name</th>
          <th scope="col" className="dt__th">From (source)</th>
          <th scope="col" className="dt__th fw-rules__c-arrow">
            <span className="visually-hidden">to</span>
          </th>
          <th scope="col" className="dt__th">To (destination)</th>
          <th scope="col" className="dt__th">Service / Port</th>
          <th scope="col" className="dt__th">Action</th>
          <th scope="col" className="dt__th">Hits (24h)</th>
          <th scope="col" className="dt__th">Status</th>
          <th scope="col" className="dt__th fw-rules__c-menu">
            <span className="visually-hidden">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {p.rows.map((r) => {
          const drop = p.dropMark?.(r) ?? null;
          return (
            <tr
              key={r.id}
              tabIndex={0}
              data-rule-id={r.id}
              data-rule-name={r.name}
              aria-label={`Rule ${r.place}: ${r.name}`}
              className={cx("fw-rules__row", !r.enabled && "fw-rules__row--off", r.mark && `fw-rules__row--${r.mark}`, drop && `fw-rules__row--drop-${drop}`, p.isDragging?.(r) && "fw-rules__row--dragging")}
              aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
              onClick={(e) => {
                if ((e.target as HTMLElement).closest("button, a, input, [role='switch'], [role='menuitem']")) return;
                p.onOpen(r.id);
              }}
              onKeyDown={(e) => onRowKey(e, r)}
              {...p.rowProps?.(r)}
            >
              <td className="dt__td fw-rules__c-handle">
                <span className="fw-rules__handle" title={`Drag to reorder ${r.name}`} {...p.handleProps?.(r)}>
                  <GripVertical size={15} aria-hidden />
                </span>
              </td>
              <td className="dt__td fw-rules__c-place">{r.place}</td>
              <td className="dt__td fw-rules__c-name">
                <span className="fw-rules__name">
                  <span className="fw-rules__name-line">
                    <span className="fw-rules__name-text">{r.name}</span>
                    {!r.starter && <StatusPill status="custom" dot={false} />}
                    {r.mark && <span className={cx("fw-rules__mark", `fw-rules__mark--${r.mark}`)}>{MARK_WORD[r.mark]}</span>}
                  </span>
                  {r.problem && (
                    <span className="fw-rules__problem">
                      <AlertTriangle size={12} aria-hidden /> {r.problem}
                    </span>
                  )}
                </span>
              </td>
              <td className="dt__td">
                <EndCell end={r.from} label={r.fromLabel} address={endAddress(r.from, p.zones)} />
              </td>
              <td className="dt__td fw-rules__c-arrow">
                <MoveRight size={16} aria-hidden />
              </td>
              <td className="dt__td">
                <EndCell end={r.to} label={r.toLabel} address={endAddress(r.to, p.zones)} />
              </td>
              <td className="dt__td">
                <span className="fw-rules__svc">{r.service}</span>
              </td>
              <td className="dt__td">
                <StatusPill status={r.action} />
              </td>
              <td className="dt__td">
                <HitsCell hits={r.hits24h} trend={r.trend24h} name={r.name} onClick={() => p.onHistory(r.id)} />
              </td>
              <td className="dt__td">
                <Switch
                  checked={r.enabled}
                  label={`Enabled: ${r.name}`}
                  disabled={p.busyIds?.has(r.id)}
                  onCheckedChange={(on) => p.onToggle(r, on)}
                />
              </td>
              <td className="dt__td fw-rules__c-menu">
                <Menu.Root>
                  <Menu.Trigger asChild>
                    <IconButton label={`Actions for ${r.name}`} size="sm" variant="plain">
                      <MoreVertical size={16} aria-hidden />
                    </IconButton>
                  </Menu.Trigger>
                  <Menu.Portal>
                    <Menu.Content className="menu" align="end" sideOffset={4}>
                      <Menu.Item className="menu__item" onSelect={() => p.onOpen(r.id)}>
                        Edit
                      </Menu.Item>
                      <Menu.Item className="menu__item" disabled={r.id === p.firstId} onSelect={() => p.onMove(r, "up")}>
                        Move up
                      </Menu.Item>
                      <Menu.Item className="menu__item" disabled={r.id === p.lastId} onSelect={() => p.onMove(r, "down")}>
                        Move down
                      </Menu.Item>
                      <Menu.Item className="menu__item menu__item--danger" onSelect={() => p.onDelete(r)}>
                        Delete
                      </Menu.Item>
                    </Menu.Content>
                  </Menu.Portal>
                </Menu.Root>
              </td>
            </tr>
          );
        })}
        {p.showDefault && (
          <tr
            tabIndex={0}
            data-rule-name="Default (catch all)"
            aria-label="Default action, always last"
            className={cx("fw-rules__row", "fw-rules__row--default", p.defaultRow.changed && "fw-rules__row--changed")}
            onKeyDown={(e) => onRowKey(e, "default")}
          >
            <td className="dt__td fw-rules__c-handle" />
            <td className="dt__td fw-rules__c-place">{p.rows.length > 0 ? Math.max(...p.rows.map((r) => r.place)) + 1 : 1}</td>
            <td className="dt__td fw-rules__c-name">
              <span className="fw-rules__name">
                <span className="fw-rules__name-line">
                  <span className="fw-rules__name-text">Default (catch all)</span>
                  {p.defaultRow.changed && <span className="fw-rules__mark fw-rules__mark--changed">Changed</span>}
                </span>
                <span className="fw-rules__sub">Unmatched traffic is {p.defaultRow.action === "deny" ? "blocked" : "allowed"}</span>
              </span>
            </td>
            <td className="dt__td">
              <EndCell end={{ kind: "any", value: "" }} label="Anywhere" address="0.0.0.0/0" />
            </td>
            <td className="dt__td fw-rules__c-arrow">
              <MoveRight size={16} aria-hidden />
            </td>
            <td className="dt__td">
              <EndCell end={{ kind: "any", value: "" }} label="Anywhere" address="0.0.0.0/0" />
            </td>
            <td className="dt__td">
              <span className="fw-rules__svc">Any</span>
            </td>
            <td className="dt__td">
              <StatusPill status={p.defaultRow.action} />
            </td>
            <td className="dt__td">
              <HitsCell hits={p.defaultRow.hits24h} trend={p.defaultRow.trend24h} name="the default action" />
            </td>
            <td className="dt__td">
              <span className="fw-rules__always">Always on</span>
            </td>
            <td className="dt__td fw-rules__c-menu">
              <span className="fw-rules__lock" title="The default action is always last">
                <Lock size={15} aria-hidden />
              </span>
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
