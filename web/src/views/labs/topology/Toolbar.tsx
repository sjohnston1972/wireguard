// views/labs/topology/Toolbar.tsx
//
// Plain English: the controls above a lab diagram (lab topology spec §9.1):
// Live / Planned (while a session runs), search (Enter fits the view to the
// matches), the dependency-edge toggle, Diagram / List, Reset layout, a link
// to the full screen and a Close button, each only where the placement gives
// it. The mini variant has none.

import type { KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import { Maximize2, RotateCcw, X } from "lucide-react";
import { SearchInput } from "@/components/forms/SearchInput";
import { SegmentedControl } from "@/components/forms/SegmentedControl";
import { Switch } from "@/components/forms/Switch";
import { Button } from "@/components/forms/Button";
import type { ToolbarProps } from "./contract";
import { requestFit } from "./fitBus";
import "./Toolbar.css";

export function Toolbar({ source, onSource, search, onSearch, showDependencies, onDependencies, view, onView, onReset, fullScreenHref, onClose, variant }: ToolbarProps) {
  if (variant === "mini") return null;
  const onSearchKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") {
      e.preventDefault();
      requestFit();
    }
  };
  return (
    <div className={`topo-toolbar topo-toolbar--${variant}`} role="toolbar" aria-label="Diagram controls">
      {source && onSource && (
        <SegmentedControl
          aria-label="Data source"
          items={[
            { value: "live", label: "Live", dot: "green" },
            { value: "planned", label: "Planned" },
          ]}
          value={source}
          onChange={(v) => onSource(v as "live" | "planned")}
        />
      )}
      <div className="topo-toolbar__search" onKeyDown={onSearchKey}>
        <SearchInput value={search} onChange={onSearch} label="Search the diagram" placeholder="Search" />
      </div>
      <label className="topo-toolbar__toggle">
        <Switch checked={showDependencies} onCheckedChange={onDependencies} label="Show dependencies" />
        <span aria-hidden="true">Dependencies</span>
      </label>
      <SegmentedControl
        aria-label="Show as"
        items={[
          { value: "diagram", label: "Diagram" },
          { value: "list", label: "List" },
        ]}
        value={view}
        onChange={(v) => onView(v as "diagram" | "list")}
      />
      <span className="topo-toolbar__end">
        {onReset && (
          <Button size="sm" variant="ghost" icon={<RotateCcw size={14} aria-hidden />} onClick={onReset}>
            Reset layout
          </Button>
        )}
        {fullScreenHref && (
          <Link className="btn btn--ghost btn--sm" to={fullScreenHref}>
            <Maximize2 size={14} aria-hidden /> Full screen
          </Link>
        )}
        {onClose && (
          <Button size="sm" variant="ghost" icon={<X size={14} aria-hidden />} onClick={onClose} aria-label="Close the diagram">
            Close
          </Button>
        )}
      </span>
    </div>
  );
}
