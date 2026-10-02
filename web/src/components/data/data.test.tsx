import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StatusPill } from "./StatusPill";
import { MetricTile } from "./MetricTile";
import { DataTable, type Column } from "./DataTable";
import { KeyValue } from "./KeyValue";
import { CopyButton } from "./CopyButton";
import { Diff, diffLines } from "./Diff";
import { DataAge, formatAge } from "./DataAge";
import { StepList } from "./StepList";
import { LogView, type LogLine } from "./LogView";

describe("StatusPill", () => {
  it("always carries a word, not just a colour", () => {
    render(
      <>
        <StatusPill status="online" />
        <StatusPill status="failure" />
        <StatusPill status="deny" />
        <StatusPill status="running" label="Deploying" />
      </>,
    );
    expect(screen.getByText("Online")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("Deny")).toBeInTheDocument();
    expect(screen.getByText("Deploying")).toBeInTheDocument();
  });
});

describe("MetricTile", () => {
  it("shows label, value, sub-text and delta with direction word", () => {
    render(
      <MetricTile
        label="Average latency"
        value="28 ms"
        sub="Across online clients"
        delta={{ text: "34%", direction: "down", good: true }}
      />,
    );
    expect(screen.getByText("Average latency")).toBeInTheDocument();
    expect(screen.getByText("28 ms")).toBeInTheDocument();
    expect(screen.getByText("Across online clients")).toBeInTheDocument();
    expect(screen.getByText("34%")).toBeInTheDocument();
    expect(screen.getByText("down")).toHaveClass("visually-hidden");
  });
  it("renders 'no data' instead of a number when the value is missing", () => {
    render(<MetricTile label="Latency" value={null} />);
    expect(screen.getByText("no data")).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });
  it("renders a progress bar with its percentage", () => {
    render(<MetricTile label="Connected clients" value="2 / 3" progress={{ value: 67 }} />);
    expect(screen.getByRole("progressbar", { name: "Connected clients" })).toHaveAttribute("aria-valuenow", "67");
  });
});

interface Row {
  id: string;
  name: string;
  hits: number;
}
const rows: Row[] = [
  { id: "a", name: "bravo", hits: 5 },
  { id: "b", name: "alpha", hits: 9 },
  { id: "c", name: "charlie", hits: 1 },
];
const columns: Column<Row>[] = [
  { key: "name", header: "Name", cell: (r) => r.name, sortValue: (r) => r.name },
  { key: "hits", header: "Hits", cell: (r) => String(r.hits), sortValue: (r) => r.hits, align: "right" },
  { key: "plain", header: "Plain", cell: () => "x" },
];
const names = () => screen.getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell")[0].textContent);

describe("DataTable", () => {
  it("renders headers and rows with an accessible name", () => {
    render(<DataTable aria-label="Clients" columns={columns} rows={rows} rowKey={(r) => r.id} />);
    expect(screen.getByRole("table", { name: "Clients" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Name" })).toBeInTheDocument();
    expect(names()).toEqual(["bravo", "alpha", "charlie"]);
  });
  it("sorts ascending then descending when a sortable header is activated by keyboard", async () => {
    render(<DataTable aria-label="Clients" columns={columns} rows={rows} rowKey={(r) => r.id} />);
    const btn = screen.getByRole("button", { name: /Name/ });
    btn.focus();
    await userEvent.keyboard("{Enter}");
    expect(names()).toEqual(["alpha", "bravo", "charlie"]);
    expect(screen.getByRole("columnheader", { name: /Name/ })).toHaveAttribute("aria-sort", "ascending");
    await userEvent.keyboard("{Enter}");
    expect(names()).toEqual(["charlie", "bravo", "alpha"]);
    expect(screen.getByRole("columnheader", { name: /Name/ })).toHaveAttribute("aria-sort", "descending");
  });
  it("non-sortable columns have no sort button", () => {
    render(<DataTable aria-label="Clients" columns={columns} rows={rows} rowKey={(r) => r.id} />);
    expect(screen.queryByRole("button", { name: /Plain/ })).not.toBeInTheDocument();
  });
  it("selects a row with Enter or Space and moves between rows with arrow keys", async () => {
    const onRowClick = vi.fn();
    render(<DataTable aria-label="Clients" columns={columns} rows={rows} rowKey={(r) => r.id} onRowClick={onRowClick} />);
    const [r1, r2] = screen.getAllByRole("row").slice(1);
    r1.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(r2).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(onRowClick).toHaveBeenLastCalledWith(rows[1]);
    await userEvent.keyboard(" ");
    expect(onRowClick).toHaveBeenCalledTimes(2);
    await userEvent.keyboard("{ArrowUp}");
    expect(r1).toHaveFocus();
    await userEvent.click(r1);
    expect(onRowClick).toHaveBeenLastCalledWith(rows[0]);
  });
  it("marks the selected row", () => {
    render(<DataTable aria-label="Clients" columns={columns} rows={rows} rowKey={(r) => r.id} onRowClick={() => {}} selectedKey="b" />);
    expect(screen.getAllByRole("row")[2]).toHaveAttribute("aria-selected", "true");
  });
  it("does not fire row click from an interactive element inside the row", async () => {
    const onRowClick = vi.fn();
    const inner = vi.fn();
    const cols: Column<Row>[] = [{ key: "x", header: "X", cell: () => <button onClick={inner}>inner</button> }];
    render(<DataTable aria-label="t" columns={cols} rows={[rows[0]]} rowKey={(r) => r.id} onRowClick={onRowClick} />);
    await userEvent.click(screen.getByRole("button", { name: "inner" }));
    expect(inner).toHaveBeenCalled();
    expect(onRowClick).not.toHaveBeenCalled();
  });
  it("opens a row actions menu by keyboard", async () => {
    const onEdit = vi.fn();
    render(
      <DataTable
        aria-label="Clients"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        rowActions={(r) => [{ label: `Edit ${r.name}`, onSelect: onEdit }]}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Actions for bravo" });
    trigger.focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.click(await screen.findByRole("menuitem", { name: "Edit bravo" }));
    expect(onEdit).toHaveBeenCalled();
  });
  it("shows the empty, loading and error slots", async () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <DataTable aria-label="t" columns={columns} rows={[]} rowKey={(r) => r.id} empty={<p>No clients yet</p>} />,
    );
    expect(screen.getByText("No clients yet")).toBeInTheDocument();
    rerender(<DataTable aria-label="t" columns={columns} rows={[]} rowKey={(r) => r.id} loading />);
    expect(screen.getByRole("table")).toHaveAttribute("aria-busy", "true");
    rerender(<DataTable aria-label="t" columns={columns} rows={[]} rowKey={(r) => r.id} error="Could not load" onRetry={onRetry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalled();
  });
});

describe("KeyValue and CopyButton", () => {
  it("lists labelled values and copies a value", async () => {
    const user = userEvent.setup();
    render(
      <KeyValue
        items={[
          { label: "Tunnel address", value: "10.13.13.3", copy: true, mono: true },
          { label: "Client type", value: "Standard client" },
        ]}
      />,
    );
    expect(screen.getByText("Tunnel address")).toBeInTheDocument();
    expect(screen.getByText("Standard client")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copy Tunnel address" }));
    expect(await navigator.clipboard.readText()).toBe("10.13.13.3");
  });
  it("CopyButton announces success", async () => {
    const user = userEvent.setup();
    render(<CopyButton text="abc" label="Copy key" />);
    await user.click(screen.getByRole("button", { name: "Copy key" }));
    expect(await screen.findByText("Copied")).toBeInTheDocument();
  });
});

describe("Diff", () => {
  it("computes added, removed and unchanged lines", () => {
    expect(diffLines(["a", "b", "c"], ["a", "c", "d"])).toEqual([
      { kind: "same", text: "a" },
      { kind: "remove", text: "b" },
      { kind: "same", text: "c" },
      { kind: "add", text: "d" },
    ]);
  });
  it("renders lines with screen-reader words, not colour alone", () => {
    render(<Diff before={["x", "y"]} after={["x", "z"]} />);
    expect(screen.getByText("removed")).toBeInTheDocument();
    expect(screen.getByText("added")).toBeInTheDocument();
    expect(screen.getByText("y")).toBeInTheDocument();
    expect(screen.getByText("z")).toBeInTheDocument();
  });
  it("says so when nothing changed", () => {
    render(<Diff before={["x"]} after={["x"]} />);
    expect(screen.getByText("No changes")).toBeInTheDocument();
  });
});

describe("DataAge", () => {
  it("formats ages", () => {
    expect(formatAge(8_000)).toBe("8 s ago");
    expect(formatAge(125_000)).toBe("2 m ago");
    expect(formatAge(3 * 3600_000)).toBe("3 h ago");
    expect(formatAge(2 * 86400_000)).toBe("2 d ago");
  });
  it("shows the age and flags stale data", () => {
    const now = 1_000_000_000;
    const { rerender } = render(<DataAge at={now - 8000} now={now} />);
    expect(screen.getByText("updated 8 s ago")).toBeInTheDocument();
    expect(screen.getByText("updated 8 s ago").closest("[data-stale]")).toHaveAttribute("data-stale", "false");
    rerender(<DataAge at={now - 200_000} now={now} />);
    expect(screen.getByText("updated 3 m ago").closest("[data-stale]")).toHaveAttribute("data-stale", "true");
    expect(screen.getByText("stale")).toBeInTheDocument();
  });
  it("says no data when there is no timestamp", () => {
    render(<DataAge at={null} />);
    expect(screen.getByText("no data")).toBeInTheDocument();
  });
});

describe("StepList", () => {
  it("states every step's state in words and shows duration and time", () => {
    render(
      <StepList
        aria-label="Deployment pipeline"
        steps={[
          { id: "1", label: "Check out code", state: "done", duration: "12s", time: "10:22:14" },
          { id: "2", label: "Apply Terraform", state: "running", time: "10:24:28" },
          { id: "3", label: "Configure firewall", state: "pending" },
          { id: "4", label: "Verify", state: "failed" },
          { id: "5", label: "Set DNS", state: "skipped" },
        ]}
      />,
    );
    const list = screen.getByRole("list", { name: "Deployment pipeline" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(5);
    expect(items[0]).toHaveTextContent("Done");
    expect(items[0]).toHaveTextContent("12s");
    expect(items[0]).toHaveTextContent("10:22:14");
    expect(items[1]).toHaveTextContent("Running");
    expect(items[1]).toHaveAttribute("aria-current", "step");
    expect(items[2]).toHaveTextContent("Pending");
    expect(items[3]).toHaveTextContent("Failed");
    expect(items[4]).toHaveTextContent("Skipped");
  });
});

function setScroll(el: HTMLElement, v: { scrollHeight: number; clientHeight: number }) {
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: v.scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: v.clientHeight });
}
const mk = (n: number): LogLine[] =>
  Array.from({ length: n }, (_, i) => ({ id: String(i), time: "10:24:27", level: i === 1 ? "WARN" : "INFO", text: `line ${i}` }));

describe("LogView", () => {
  it("renders a severity tag and text per line", () => {
    render(<LogView aria-label="Live logs" lines={mk(3)} />);
    expect(screen.getByText("line 0")).toBeInTheDocument();
    expect(screen.getAllByText("INFO")).toHaveLength(2);
    expect(screen.getByText("WARN")).toBeInTheDocument();
  });
  it("says there is no output when empty", () => {
    render(<LogView aria-label="Live logs" lines={[]} />);
    expect(screen.getByText("No log output")).toBeInTheDocument();
  });
  it("filters by search text", async () => {
    render(<LogView aria-label="Live logs" lines={mk(5)} />);
    await userEvent.type(screen.getByRole("searchbox", { name: "Search logs" }), "line 3");
    expect(screen.getByText("line 3")).toBeInTheDocument();
    expect(screen.queryByText("line 2")).not.toBeInTheDocument();
  });
  it("follows new lines, pauses when scrolled up, and shows a new-lines marker", async () => {
    const { rerender } = render(<LogView aria-label="Live logs" lines={mk(3)} />);
    const log = screen.getByRole("log", { name: "Live logs" });
    setScroll(log, { scrollHeight: 1000, clientHeight: 200 });
    rerender(<LogView aria-label="Live logs" lines={mk(4)} />);
    // following: stuck to the bottom
    expect(log.scrollTop).toBe(1000);
    expect(screen.getByRole("switch", { name: "Auto-scroll" })).toBeChecked();

    // user scrolls up -> auto-scroll pauses
    log.scrollTop = 100;
    fireEvent.scroll(log);
    expect(screen.getByRole("switch", { name: "Auto-scroll" })).not.toBeChecked();

    // more lines arrive: no jump, a marker counts them
    setScroll(log, { scrollHeight: 1200, clientHeight: 200 });
    rerender(<LogView aria-label="Live logs" lines={mk(6)} />);
    expect(log.scrollTop).toBe(100);
    const marker = screen.getByRole("button", { name: "2 new lines" });

    // clicking it resumes and jumps to the bottom
    await userEvent.click(marker);
    expect(log.scrollTop).toBe(1200);
    expect(screen.queryByRole("button", { name: /new line/ })).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Auto-scroll" })).toBeChecked();
  });
  it("turning auto-scroll off by the toggle stops following", async () => {
    const { rerender } = render(<LogView aria-label="Live logs" lines={mk(3)} />);
    const log = screen.getByRole("log", { name: "Live logs" });
    setScroll(log, { scrollHeight: 500, clientHeight: 200 });
    await userEvent.click(screen.getByRole("switch", { name: "Auto-scroll" }));
    log.scrollTop = 0;
    rerender(<LogView aria-label="Live logs" lines={mk(4)} />);
    expect(log.scrollTop).toBe(0);
    expect(screen.getByRole("button", { name: "1 new line" })).toBeInTheDocument();
  });
  it("copies a line", async () => {
    const user = userEvent.setup();
    render(<LogView aria-label="Live logs" lines={mk(2)} />);
    await user.click(screen.getAllByRole("button", { name: "Copy line" })[0]);
    expect(await navigator.clipboard.readText()).toContain("line 0");
  });
});
