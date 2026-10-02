import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { Button } from "./Button";
import { IconButton } from "./IconButton";
import { Switch } from "./Switch";
import { Chips } from "./Chips";
import { SegmentedControl } from "./SegmentedControl";
import { SearchInput } from "./SearchInput";
import { Field } from "./Field";
import { ConfirmByTyping } from "./ConfirmByTyping";
import { Select } from "./Select";

// Radix Select needs a few DOM APIs jsdom lacks.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

describe("Button", () => {
  it("fires onClick by mouse and keyboard and exposes its name", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);
    const b = screen.getByRole("button", { name: "Save" });
    await userEvent.click(b);
    b.focus();
    await userEvent.keyboard("{Enter}");
    expect(onClick).toHaveBeenCalledTimes(2);
  });
  it("is inert while loading", async () => {
    const onClick = vi.fn();
    render(<Button loading onClick={onClick}>Save</Button>);
    await userEvent.click(screen.getByRole("button", { name: /Save/ }));
    expect(onClick).not.toHaveBeenCalled();
    expect(screen.getByRole("button")).toHaveAttribute("aria-busy", "true");
  });
  it("defaults to type=button", () => {
    render(<Button>Go</Button>);
    expect(screen.getByRole("button")).toHaveAttribute("type", "button");
  });
});

describe("IconButton", () => {
  it("is named by its label", async () => {
    const onClick = vi.fn();
    render(<IconButton label="Close" onClick={onClick}><span>x</span></IconButton>);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClick).toHaveBeenCalled();
  });
});

describe("Switch", () => {
  it("toggles with space and reports the state", async () => {
    const onChange = vi.fn();
    render(<Switch checked={false} onCheckedChange={onChange} label="Enable rule" />);
    const s = screen.getByRole("switch", { name: "Enable rule" });
    s.focus();
    await userEvent.keyboard(" ");
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe("Chips", () => {
  const items = [
    { value: "mon", label: "Mon" },
    { value: "tue", label: "Tue" },
  ];
  it("multi mode toggles values and shows pressed state", async () => {
    const onChange = vi.fn();
    render(<Chips aria-label="Days" items={items} value={["mon"]} onChange={onChange} />);
    expect(screen.getByRole("button", { name: "Mon" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "Tue" }));
    expect(onChange).toHaveBeenCalledWith(["mon", "tue"]);
    await userEvent.click(screen.getByRole("button", { name: "Mon" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });
  it("single mode replaces the value", async () => {
    const onChange = vi.fn();
    render(<Chips aria-label="Duration" mode="single" items={items} value={["mon"]} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "Tue" }));
    expect(onChange).toHaveBeenCalledWith(["tue"]);
  });
  it("is a labelled group", () => {
    render(<Chips aria-label="Days" items={items} value={[]} onChange={() => {}} />);
    expect(screen.getByRole("group", { name: "Days" })).toBeInTheDocument();
  });
});

describe("SegmentedControl", () => {
  function Wrap() {
    const [v, setV] = useState("1h");
    return (
      <SegmentedControl
        aria-label="Range"
        value={v}
        onChange={setV}
        items={[
          { value: "live", label: "Live" },
          { value: "1h", label: "1h" },
          { value: "24h", label: "24h" },
        ]}
      />
    );
  }
  it("marks one radio checked and moves with arrow keys", async () => {
    render(<Wrap />);
    const r = screen.getByRole("radio", { name: "1h" });
    expect(r).toBeChecked();
    r.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "24h" })).toBeChecked();
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(screen.getByRole("radio", { name: "Live" })).toBeChecked();
  });
  it("only the checked radio is in the tab order", () => {
    render(<Wrap />);
    expect(screen.getByRole("radio", { name: "1h" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("radio", { name: "24h" })).toHaveAttribute("tabindex", "-1");
  });
});

describe("SearchInput", () => {
  it("has an accessible name, shows the hint, and clears on Escape", async () => {
    const onChange = vi.fn();
    render(<SearchInput label="Search clients" value="ab" onChange={onChange} shortcut="⌘ F" />);
    const input = screen.getByRole("searchbox", { name: "Search clients" });
    expect(screen.getByText("⌘ F")).toBeInTheDocument();
    input.focus();
    await userEvent.keyboard("{Escape}");
    expect(onChange).toHaveBeenCalledWith("");
  });
});

describe("Field", () => {
  it("links the label, hint and error to the control", () => {
    render(
      <Field label="Idle limit" hint="0 = off" error="Must be a number">
        {(p) => <input {...p} />}
      </Field>,
    );
    const input = screen.getByLabelText("Idle limit");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription(/0 = off.*Must be a number/);
    expect(screen.getByRole("alert")).toHaveTextContent("Must be a number");
  });
});

describe("ConfirmByTyping", () => {
  it("enables the confirm button only once the phrase matches", async () => {
    const onConfirm = vi.fn();
    render(<ConfirmByTyping phrase="tear down" actionLabel="Tear down" onConfirm={onConfirm} />);
    const btn = screen.getByRole("button", { name: "Tear down" });
    expect(btn).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Type tear down to confirm/i), "tear down");
    expect(btn).toBeEnabled();
    await userEvent.click(btn);
    expect(onConfirm).toHaveBeenCalled();
  });
  it("stays disabled while pending", async () => {
    render(<ConfirmByTyping phrase="x" actionLabel="Go" pending onConfirm={() => {}} />);
    await userEvent.type(screen.getByLabelText(/Type x to confirm/i), "x");
    expect(screen.getByRole("button", { name: /Go/ })).toBeDisabled();
  });
});

describe("Select", () => {
  it("opens by keyboard, picks an option and reports it", async () => {
    const onChange = vi.fn();
    render(
      <Select
        label="Region"
        value="uks"
        onValueChange={onChange}
        options={[
          { value: "uks", label: "UK South" },
          { value: "ire", label: "Ireland" },
        ]}
      />,
    );
    const trigger = screen.getByRole("combobox", { name: "Region" });
    expect(trigger).toHaveTextContent("UK South");
    trigger.focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.click(await screen.findByRole("option", { name: "Ireland" }));
    expect(onChange).toHaveBeenCalledWith("ire");
  });
});
