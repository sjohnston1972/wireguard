import * as Menu from "@radix-ui/react-dropdown-menu";
import { ArrowDown, ArrowUp, MoreHorizontal } from "lucide-react";
import { useMemo, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { cx } from "../cx";
import { EmptyState } from "../feedback/EmptyState";
import { ErrorState } from "../feedback/ErrorState";
import { Skeleton } from "../feedback/Skeleton";
import { IconButton } from "../forms/IconButton";
import "./DataTable.css";

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Makes the column sortable. null values sort last. */
  sortValue?: (row: T) => string | number | null;
  align?: "left" | "right" | "center";
  width?: string | number;
  /** For views to hide a column at narrow widths with CSS. */
  className?: string;
}

export interface RowAction {
  label: string;
  onSelect: () => void;
  danger?: boolean;
}

export interface SortState {
  key: string;
  dir: "asc" | "desc";
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  "aria-label": string;
  onRowClick?: (row: T) => void;
  selectedKey?: string | null;
  /** Row actions menu (the "..." button). */
  rowActions?: (row: T) => RowAction[];
  /** Names the row in the actions button; defaults to the first sortable column's value. */
  rowLabel?: (row: T) => string;
  defaultSort?: SortState;
  sort?: SortState | null;
  onSortChange?: (sort: SortState | null) => void;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  /** Row height: "comfortable" (the default, as today) or "compact" (class dt--compact; views may set their own heights for it). */
  density?: "comfortable" | "compact";
  /** Shown when there are no rows; defaults to a plain "Nothing to show". */
  empty?: ReactNode;
  className?: string;
}

const INTERACTIVE = 'button, a, input, select, textarea, label, [role="switch"], [role="menuitem"], [role="checkbox"]';

function compare(a: string | number | null, b: string | number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  selectedKey,
  rowActions,
  rowLabel,
  defaultSort,
  sort: controlledSort,
  onSortChange,
  loading,
  error,
  onRetry,
  empty,
  density = "comfortable",
  className,
  ...rest
}: DataTableProps<T>) {
  const [innerSort, setInnerSort] = useState<SortState | null>(defaultSort ?? null);
  const sort = controlledSort !== undefined ? controlledSort : innerSort;

  const setSort = (next: SortState | null) => {
    if (controlledSort === undefined) setInnerSort(next);
    onSortChange?.(next);
  };

  const sorted = useMemo(() => {
    const col = sort && columns.find((c) => c.key === sort.key);
    if (!sort || !col?.sortValue) return rows;
    const get = col.sortValue;
    const dir = sort.dir === "asc" ? 1 : -1;
    return rows
      .map((r, i) => ({ r, i }))
      .sort((x, y) => {
        const a = get(x.r);
        const b = get(y.r);
        // nulls stay last in both directions
        if (a === null || b === null) return compare(a, b);
        return compare(a, b) * dir || x.i - y.i;
      })
      .map((x) => x.r);
  }, [rows, columns, sort]);

  const clickable = !!onRowClick;
  const colCount = columns.length + (rowActions ? 1 : 0);
  const labelOf = (row: T) => {
    if (rowLabel) return rowLabel(row);
    const c = columns.find((x) => x.sortValue);
    const v = c?.sortValue?.(row);
    return v === null || v === undefined ? "row" : String(v);
  };

  const onRowKey = (e: KeyboardEvent<HTMLTableRowElement>, row: T) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onRowClick?.(row);
      return;
    }
    const tr = e.currentTarget;
    let to: Element | null = null;
    if (e.key === "ArrowDown") to = tr.nextElementSibling;
    else if (e.key === "ArrowUp") to = tr.previousElementSibling;
    else if (e.key === "Home") to = tr.parentElement?.firstElementChild ?? null;
    else if (e.key === "End") to = tr.parentElement?.lastElementChild ?? null;
    else return;
    e.preventDefault();
    if (to instanceof HTMLElement && to.tabIndex >= 0) to.focus();
  };

  const onRowMouse = (e: MouseEvent<HTMLTableRowElement>, row: T) => {
    const hit = (e.target as HTMLElement).closest(INTERACTIVE);
    if (hit && e.currentTarget.contains(hit)) return;
    onRowClick?.(row);
  };

  const cycle = (key: string) => {
    if (!sort || sort.key !== key) setSort({ key, dir: "asc" });
    else setSort({ key, dir: sort.dir === "asc" ? "desc" : "asc" });
  };

  return (
    <div className={cx("dt", density === "compact" && "dt--compact", className)}>
      <table className="dt__table" aria-label={rest["aria-label"]} aria-busy={loading ? true : undefined}>
        <thead>
          <tr>
            {columns.map((c) => {
              const active = sort?.key === c.key ? sort : null;
              return (
                <th
                  key={c.key}
                  scope="col"
                  className={cx("dt__th", c.align && `dt__a-${c.align}`, c.className)}
                  style={c.width !== undefined ? { width: c.width } : undefined}
                  aria-sort={c.sortValue ? (active ? (active.dir === "asc" ? "ascending" : "descending") : "none") : undefined}
                >
                  {c.sortValue ? (
                    <button type="button" className="dt__sort" onClick={() => cycle(c.key)}>
                      {c.header}
                      <span className="dt__arrow" aria-hidden>
                        {active ? active.dir === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} /> : null}
                      </span>
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
            {rowActions && (
              <th scope="col" className="dt__th dt__actions">
                <span className="visually-hidden">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {loading &&
            Array.from({ length: 5 }, (_, i) => (
              <tr key={`sk${i}`} className="dt__row dt__row--skeleton">
                <td colSpan={colCount}>
                  <Skeleton variant="row" />
                </td>
              </tr>
            ))}
          {!loading && error && (
            <tr>
              <td colSpan={colCount}>
                <ErrorState message={error} onRetry={onRetry} />
              </td>
            </tr>
          )}
          {!loading && !error && sorted.length === 0 && (
            <tr>
              <td colSpan={colCount}>{empty ?? <EmptyState title="Nothing to show" />}</td>
            </tr>
          )}
          {!loading &&
            !error &&
            sorted.map((row) => {
              const key = rowKey(row);
              const selected = selectedKey === key;
              return (
                <tr
                  key={key}
                  className={cx("dt__row", clickable && "dt__row--click", selected && "dt__row--selected")}
                  tabIndex={clickable ? 0 : undefined}
                  aria-selected={clickable ? selected : undefined}
                  onClick={clickable ? (e) => onRowMouse(e, row) : undefined}
                  onKeyDown={clickable ? (e) => onRowKey(e, row) : undefined}
                >
                  {columns.map((c) => (
                    <td key={c.key} className={cx("dt__td", c.align && `dt__a-${c.align}`, c.className)}>
                      {c.cell(row)}
                    </td>
                  ))}
                  {rowActions && (
                    <td className="dt__td dt__actions">
                      <Menu.Root>
                        <Menu.Trigger asChild>
                          <IconButton label={`Actions for ${labelOf(row)}`} size="sm" variant="plain">
                            <MoreHorizontal size={16} aria-hidden />
                          </IconButton>
                        </Menu.Trigger>
                        <Menu.Portal>
                          <Menu.Content className="menu" align="end" sideOffset={4}>
                            {rowActions(row).map((a) => (
                              <Menu.Item key={a.label} className={cx("menu__item", a.danger && "menu__item--danger")} onSelect={a.onSelect}>
                                {a.label}
                              </Menu.Item>
                            ))}
                          </Menu.Content>
                        </Menu.Portal>
                      </Menu.Root>
                    </td>
                  )}
                </tr>
              );
            })}
        </tbody>
      </table>
    </div>
  );
}
