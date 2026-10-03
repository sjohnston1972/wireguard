// widgets/SettingsForm.tsx
//
// Plain English: the cog's form, generated from a widget's settings in
// shared/widgets.ts with the app's own form controls. Choices apply at
// once; a number applies when the field is left or Enter is pressed, and an
// invalid one shows why at the field and is not applied.

import { useEffect, useId, useState, type KeyboardEvent } from "react";
import type { SettingValue } from "@shared/api";
import { SECTIONS, SECTION_TITLES, settingProblem, type SettingSpec, type Threshold, type WidgetDef } from "@shared/widgets";
import { Chips, Field, SegmentedControl, Select, Switch } from "@/components";

export const THRESHOLD_HINT = "Colours this dashboard only. Alerts are unchanged.";

export interface SettingsFormProps {
  def: WidgetDef;
  settings: Record<string, SettingValue>;
  /** Apply one value (already checked); false if it was refused. */
  onSet: (key: string, value: SettingValue) => boolean;
  readOnly?: boolean;
}

/** One section per kind of setting (Data, Thresholds, Display), each only when it has settings. */
export function SettingsForm({ def, settings, onSet, readOnly }: SettingsFormProps) {
  return (
    <fieldset className="wg-form" disabled={readOnly}>
      {SECTIONS.map((section) => {
        const specs = def.settings.filter((s) => s.section === section);
        if (!specs.length) return null;
        return (
          <section key={section} className="wg-form__section" aria-label={SECTION_TITLES[section]}>
            <h3 className="wg-form__title">{SECTION_TITLES[section]}</h3>
            {section === "thresholds" && <p className="wg-form__hint">{THRESHOLD_HINT}</p>}
            {specs.map((s) => (
              <SettingControl key={s.key} spec={s} value={settings[s.key]!} onSet={(v) => onSet(s.key, v)} />
            ))}
          </section>
        );
      })}
    </fieldset>
  );
}

function SettingControl({ spec, value, onSet }: { spec: SettingSpec; value: SettingValue; onSet: (v: SettingValue) => boolean }) {
  const labelId = useId();
  switch (spec.kind) {
    case "enum":
      if (spec.options.length <= 4)
        return (
          <div className="wg-field">
            <span className="wg-field__label" id={labelId}>
              {spec.label}
            </span>
            <SegmentedControl aria-label={spec.label} items={spec.options} value={value as string} onChange={(v) => onSet(v)} />
          </div>
        );
      return (
        <div className="wg-field">
          <span className="wg-field__label" aria-hidden>
            {spec.label}
          </span>
          <Select label={spec.label} options={spec.options} value={value as string} onValueChange={(v) => onSet(v)} />
        </div>
      );
    case "boolean":
      return (
        <div className="wg-field wg-field--inline">
          <span className="wg-field__label" aria-hidden>
            {spec.label}
          </span>
          <Switch label={spec.label} checked={value as boolean} onCheckedChange={(on) => onSet(on)} />
        </div>
      );
    case "number":
      return <NumberField label={spec.label} unit={spec.unit} value={value as number} check={(n) => settingProblem(spec, n)} onCommit={(n) => onSet(n)} />;
    case "multi": {
      const on = value as string[];
      return (
        <div className="wg-field">
          <span className="wg-field__label" aria-hidden>
            {spec.label}
          </span>
          <Chips
            aria-label={spec.label}
            shape="rect"
            items={spec.options}
            value={on}
            onChange={(next) => {
              // At least minSelected stay on; the saved order is the options' order.
              if (next.length < spec.minSelected) return;
              onSet(spec.options.map((o) => o.value).filter((v) => next.includes(v)));
            }}
          />
        </div>
      );
    }
    case "threshold":
      return <ThresholdField spec={spec} value={value as Threshold} onSet={onSet} />;
  }
}

interface NumberFieldProps {
  label: React.ReactNode;
  unit?: string;
  value: number | null;
  disabled?: boolean;
  /** Why the number cannot be used, or null. */
  check: (n: number) => string | null;
  onCommit: (n: number) => boolean | void;
}

/** A number typed as text; applied on blur or Enter, never per keystroke. */
function NumberField({ label, unit, value, disabled, check, onCommit }: NumberFieldProps) {
  const [text, setText] = useState(value === null ? "" : String(value));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setText(value === null ? "" : String(value));
    setError(null);
  }, [value]);
  const commit = () => {
    if (disabled) return;
    const n = text.trim() === "" ? Number.NaN : Number(text);
    if (value !== null && n === value) {
      setError(null);
      return;
    }
    const problem = check(n);
    setError(problem);
    if (!problem) onCommit(n);
  };
  return (
    <Field label={label} error={error}>
      {(p) => (
        <span className="wg-number">
          <input
            {...p}
            className="wg-number__input"
            type="text"
            inputMode="decimal"
            value={text}
            disabled={disabled}
            onChange={(e) => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e: KeyboardEvent) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit();
              }
            }}
          />
          {unit && <span className="wg-unit">{unit}</span>}
        </span>
      )}
    </Field>
  );
}

/** Warn and Bad, each a number with an on/off switch. */
function ThresholdField({ spec, value, onSet }: { spec: Extract<SettingSpec, { kind: "threshold" }>; value: Threshold; onSet: (v: SettingValue) => boolean }) {
  const [error, setError] = useState<string | null>(null);
  const tryPair = (next: Threshold): void => {
    const problem = settingProblem(spec, next);
    setError(problem);
    if (!problem) onSet(next);
  };
  /** Where a threshold starts when switched on: its default, else the end of the range that colours nothing yet. */
  const start = (k: "warn" | "bad"): number => {
    const d = spec.default[k];
    if (d !== null) return d;
    const other = k === "warn" ? value.bad : value.warn;
    const { min, max, step } = spec;
    if (spec.direction === "above") return k === "bad" ? max : Math.max(min, (other ?? max) - step);
    return k === "bad" ? min : Math.min(max, (other ?? min) + step);
  };
  const part = (k: "warn" | "bad", word: string) => {
    const on = value[k] !== null;
    const name = `${spec.label}: ${word}`;
    return (
      <div className="wg-threshold__part">
        <NumberField
          label={
            <>
              <span className="visually-hidden">{name}</span>
              <span aria-hidden>{word}</span>
            </>
          }
          unit={spec.unit}
          value={value[k]}
          disabled={!on}
          check={(n) => settingProblem(spec, { ...value, [k]: n })}
          onCommit={(n) => tryPair({ ...value, [k]: n })}
        />
        <span className="wg-threshold__switch">
          <Switch label={`${name} on`} checked={on} onCheckedChange={(v) => tryPair({ ...value, [k]: v ? start(k) : null })} />
          <span aria-hidden>{on ? "On" : "Off"}</span>
        </span>
      </div>
    );
  };
  return (
    <fieldset className="wg-threshold">
      <legend className="wg-field__label">{spec.label}</legend>
      <div className="wg-threshold__parts">
        {part("warn", "Warn")}
        {part("bad", "Bad")}
      </div>
      {error && (
        <p className="field__error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
