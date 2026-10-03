import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cx } from "../cx";
import { Switch } from "../forms/Switch";
import { SearchInput } from "../forms/SearchInput";
import { CopyButton } from "./CopyButton";
import "./LogView.css";

export type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG";

export interface LogLine {
  id: string;
  /** "10:24:27" */
  time?: string;
  level: LogLevel;
  text: string;
}

export interface LogViewProps {
  lines: LogLine[];
  "aria-label": string;
  /** Hide the toolbar (search and auto-scroll), for compact embeds. */
  toolbar?: boolean;
  /** What to say when there are no lines at all (default "No log output"). */
  emptyText?: string;
  /** Wrap long lines instead of cutting them off with an ellipsis (default false). */
  wrap?: boolean;
  /** Show each line's time (default true). */
  timestamps?: boolean;
  /** Show each line's severity tag (default true). */
  levelTags?: boolean;
  className?: string;
}

/** How close to the bottom still counts as "following". */
const BOTTOM_SLACK = 24;

/**
 * Monospace log: severity tag per line, search, copy a line, and auto-scroll that
 * pauses the moment the reader scrolls up and counts the lines that arrive meanwhile.
 */
export function LogView({ lines, toolbar = true, emptyText = "No log output", wrap = false, timestamps = true, levelTags = true, className, ...rest }: LogViewProps) {
  const [query, setQuery] = useState("");
  const [following, setFollowing] = useState(true);
  const [pausedAt, setPausedAt] = useState(0);
  const box = useRef<HTMLDivElement | null>(null);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return lines;
    return lines.filter((l) => `${l.time ?? ""} ${l.level} ${l.text}`.toLowerCase().includes(q));
  }, [lines, query]);

  // Stick to the bottom while following.
  useLayoutEffect(() => {
    const el = box.current;
    if (following && el) el.scrollTop = el.scrollHeight;
  }, [shown.length, following]);

  // Keep the pause point valid if the list shrinks (filter changed).
  useEffect(() => {
    if (!following && pausedAt > shown.length) setPausedAt(shown.length);
  }, [shown.length, following, pausedAt]);

  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK;
    if (!atBottom && following) {
      setFollowing(false);
      setPausedAt(shown.length);
    } else if (atBottom && !following) {
      setFollowing(true);
    }
  };

  const toggle = (on: boolean) => {
    if (on) setFollowing(true);
    else {
      setFollowing(false);
      setPausedAt(shown.length);
    }
  };

  const newCount = following ? 0 : Math.max(0, shown.length - pausedAt);

  return (
    <div className={cx("log", wrap && "log--wrap", className)}>
      {toolbar && (
        <div className="log__bar">
          <SearchInput className="log__search" label="Search logs" value={query} onChange={setQuery} />
          <div className="log__follow">
            <span aria-hidden>Auto-scroll</span>
            <Switch label="Auto-scroll" checked={following} onCheckedChange={toggle} />
          </div>
        </div>
      )}
      <div className="log__scroller">
        <div ref={box} className="log__lines" role="log" aria-live="off" aria-label={rest["aria-label"]} tabIndex={0} onScroll={onScroll}>
          {shown.length === 0 ? (
            <p className="log__empty">{lines.length === 0 ? emptyText : "No lines match the search"}</p>
          ) : (
            shown.map((l) => (
              <div className="log__line" key={l.id}>
                {timestamps && l.time && <span className="log__time">{l.time}</span>}
                {levelTags && <span className={cx("log__level", `log__level--${l.level}`)}>{l.level}</span>}
                <span className="log__text">{l.text}</span>
                <CopyButton className="log__copy" label="Copy line" text={`${l.time ?? ""} ${l.level} ${l.text}`.trim()} />
              </div>
            ))
          )}
        </div>
        {newCount > 0 && (
          <button
            type="button"
            className="log__new"
            onClick={() => {
              setFollowing(true);
            }}
          >
            {newCount} new {newCount === 1 ? "line" : "lines"}
          </button>
        )}
      </div>
    </div>
  );
}
