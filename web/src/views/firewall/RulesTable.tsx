import * as Menu from "@radix-ui/react-dropdown-menu";
import { AlertTriangle, ArrowLeftRight, GripVertical, Lock, MoreVertical, MoveRight } from "lucide-react";
import { type KeyboardEvent } from "react";
import type { FirewallResponse } from "@shared/api";
import { IconButton, Sparkline, StatusPill, Switch, cx, formatAge } from "@/components";
import { EndCell } from "./EndCell";
import { endAddress, fmtCount, type Action, type RuleView } from "./model";
import "./RulesTable.css";

export interface DefaultRowInfo {
  action: Action;
  hits24h: number | null;
  trend24h: (number | null)[];
  changed: boolean;
  /** Packets since the counters were cleared, and when it last matched (the optional columns). */
  hitsTotal: number | null;
  lastHit: string | null;
}

/** The table's optional columns (the Firewall rules widget's Columns setting), in the order they can appear. */
export type RuleColumn = "service" | "hits" | "lastHit" | "lifetime";
/** Today's columns. */
export const DEFAULT_RULE_COLUMNS: RuleColumn[] = ["service", "hits"];

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
  /**
   * Present when the Default action tile (and its Change button) is not on the
   * page: the default row then carries its own Change button instead of the lock.
   */
  onChangeDefault?: () => void;
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
  /** Optional columns shown (default: Service / Port and Hits (24h)). */
  columns?: RuleColumn[];
  /** The hit sparkline in the Hits column (default on). */
  sparkline?: boolean;
  /** Compact rows (36 px). */
  density?: "comfortable" | "compact";
  /** The answer's own clock, for the Last hit column. */
  now?: string;
}

/** "4 m ago", "never", or "no data" when the VM has counted nothing for it. */
function lastHitText(lastHit: string | null, counted: boolean, now: string | undefined): string {
  if (lastHit && now) return formatAge(Date.parse(now) - Date.parse(lastHit));
  return counted ? "never" : "no data";
}

function LastHitCell({ lastHit, counted, now }: { lastHit: string | null; counted: boolean; now?: string }) {
  const text = lastHitText(lastHit, counted, now);
  return (
    <span className={cx("fw-rules__last", text === "no data" && "fw-rules__nodata")} data-testid="last-hit">
      {text}
    </span>
  );
}

function LifetimeCell({ hits }: { hits: number | null }) {
  return (
    <span className={cx("fw-rules__life", hits === null && "fw-rules__nodata")} data-testid="lifetime">
      {hits === null ? "no data" : fmtCount(hits)}
    </span>
  );
}

const MARK_WORD = { added: "Added", changed: "Changed", moved: "Moved" } as const;

function HitsCell({ hits, trend, onClick, name, sparkline = true }: { hits: number | null; trend: (number | null)[]; onClick?: () => void; name: string; sparkline?: boolean }) {
  const inner =
    hits === null ? (
      <span className="fw-rules__nodata">no data</span>
    ) : (
      <>
        <span className="fw-rules__hits-n">{fmtCount(hits)}</span>
        {sparkline && <Sparkline variant="bars" tone="blue" label={`Hits per hour for ${name}`} data={trend} width={52} height={20} />}
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

  const cols = p.columns ?? DEFAULT_RULE_COLUMNS;
  const has = (c: RuleColumn) => cols.includes(c);
  const sparkline = p.sparkline ?? true;

  return (
    <table className={cx("fw-rules dt__table", p.density === "compact" && "fw-rules--compact")} aria-label="Firewall rules">
      <thead>
        <tr>
          <th scope="col" className="dt__th fw-rules__c-handle">
            <span className="visually-hidden">Reorder</span>
          </th>
          <th scope="col" className="dt__th fw-rules__c-place">#</th>
          <th scope="col" className="dt__th fw-rules__c-name">Name</th>
          <th scope="col" className="dt__th fw-rules__c-from">
            From (source)<span className="fw-rules__route-head"> → to</span>
          </th>
          <th scope="col" className="dt__th fw-rules__c-arrow">
            <span className="visually-hidden">to</span>
          </th>
          <th scope="col" className="dt__th fw-rules__c-to">To (destination)</th>
          {has("service") && <th scope="col" className="dt__th fw-rules__c-svc">Service / Port</th>}
          <th scope="col" className="dt__th fw-rules__c-action">Action</th>
          {has("hits") && <th scope="col" className="dt__th fw-rules__c-hits">Hits (24h)</th>}
          {has("lastHit") && <th scope="col" className="dt__th fw-rules__c-last">Last hit</th>}
          {has("lifetime") && <th scope="col" className="dt__th fw-rules__c-life">Lifetime hits</th>}
          <th scope="col" className="dt__th fw-rules__c-status">Status</th>
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
                if ((e.target as HTMLElement).closest("button, a, input, [role='switch'], [role='menuitem'], [draggable='true']")) return;
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
              <td className="dt__td fw-rules__c-from">
                <EndCell end={r.from} label={r.fromLabel} address={endAddress(r.from, p.zones)} />
                {/* Below 1400 px the To column folds into this one. */}
                <span className="fw-rules__route-to">→ {r.toLabel}</span>
              </td>
              <td className="dt__td fw-rules__c-arrow">
                <MoveRight size={16} aria-hidden />
              </td>
              <td className="dt__td fw-rules__c-to">
                <EndCell end={r.to} label={r.toLabel} address={endAddress(r.to, p.zones)} />
              </td>
              {has("service") && (
                <td className="dt__td fw-rules__c-svc">
                  <span className="fw-rules__svc" title={r.service}>
                    {r.service}
                  </span>
                </td>
              )}
              <td className="dt__td">
                <StatusPill status={r.action} />
              </td>
              {has("hits") && (
                <td className="dt__td">
                  <HitsCell hits={r.hits24h} trend={r.trend24h} name={r.name} sparkline={sparkline} onClick={() => p.onHistory(r.id)} />
                </td>
              )}
              {has("lastHit") && (
                <td className="dt__td">
                  <LastHitCell lastHit={r.lastHit} counted={r.hitsTotal !== null} now={p.now} />
                </td>
              )}
              {has("lifetime") && (
                <td className="dt__td">
                  <LifetimeCell hits={r.hitsTotal} />
                </td>
              )}
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
            <td className="dt__td fw-rules__c-from">
              <EndCell end={{ kind: "any", value: "" }} label="Anywhere" address="0.0.0.0/0" />
              <span className="fw-rules__route-to">→ Anywhere</span>
            </td>
            <td className="dt__td fw-rules__c-arrow">
              <MoveRight size={16} aria-hidden />
            </td>
            <td className="dt__td fw-rules__c-to">
              <EndCell end={{ kind: "any", value: "" }} label="Anywhere" address="0.0.0.0/0" />
            </td>
            {has("service") && (
              <td className="dt__td fw-rules__c-svc">
                <span className="fw-rules__svc">Any</span>
              </td>
            )}
            <td className="dt__td">
              <StatusPill status={p.defaultRow.action} />
            </td>
            {has("hits") && (
              <td className="dt__td">
                <HitsCell hits={p.defaultRow.hits24h} trend={p.defaultRow.trend24h} name="the default action" sparkline={sparkline} />
              </td>
            )}
            {has("lastHit") && (
              <td className="dt__td">
                <LastHitCell lastHit={p.defaultRow.lastHit} counted={p.defaultRow.hitsTotal !== null} now={p.now} />
              </td>
            )}
            {has("lifetime") && (
              <td className="dt__td">
                <LifetimeCell hits={p.defaultRow.hitsTotal} />
              </td>
            )}
            <td className="dt__td fw-rules__c-status">
              <span className="fw-rules__always">Always on</span>
            </td>
            <td className="dt__td fw-rules__c-menu">
              {p.onChangeDefault ? (
                <IconButton label={`Change default action to ${p.defaultRow.action === "deny" ? "Allow" : "Deny"}`} size="sm" variant="plain" onClick={p.onChangeDefault}>
                  <ArrowLeftRight size={16} aria-hidden />
                </IconButton>
              ) : (
                <span className="fw-rules__lock" title="The default action is always last">
                  <Lock size={15} aria-hidden />
                </span>
              )}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
