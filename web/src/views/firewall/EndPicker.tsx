import { useId } from "react";
import type { FirewallResponse, SimEnd } from "@shared/api";
import { Select } from "@/components";
import { useClients } from "@/api/queries";
import "./EndPicker.css";

/** "zone:clients", "client:3", "any:", "cidr:" as one Select value. */
const encode = (e: SimEnd) => (e.kind === "cidr" ? "cidr:" : e.kind === "any" ? "any:" : `${e.kind}:${e.value}`);

/** One end of a flow or rule: a zone, a client, anywhere, or an address typed in. */
export function EndPicker({ label, end, onChange, fw, error }: { label: string; end: SimEnd; onChange: (e: SimEnd) => void; fw: FirewallResponse; error?: string }) {
  const clients = useClients();
  const id = useId();
  const options = [
    ...fw.zones.map((z) => ({ value: `zone:${z.zone}`, label: z.label })),
    { value: "any:", label: "Anywhere" },
    ...(clients.data?.clients ?? []).map((c) => ({ value: `client:${c.id}`, label: `${c.name} (${c.ip})` })),
    { value: "cidr:", label: "An address or network…" },
  ];
  const pick = (v: string) => {
    const [kind, value] = [v.slice(0, v.indexOf(":")), v.slice(v.indexOf(":") + 1)] as [SimEnd["kind"], string];
    onChange({ kind, value: kind === "cidr" ? (end.kind === "cidr" ? end.value : "") : value });
  };
  return (
    <div className="fw-endpick">
      <Select label={label} showLabel value={encode(end)} options={options} onValueChange={pick} />
      {end.kind === "cidr" && (
        <>
          <label className="visually-hidden" htmlFor={id}>
            {label} address
          </label>
          <input
            id={id}
            className="input input--mono fw-endpick__addr"
            value={end.value}
            placeholder="198.51.100.7 or 198.51.100.0/24"
            aria-invalid={error ? true : undefined}
            onChange={(e) => onChange({ kind: "cidr", value: e.target.value })}
          />
        </>
      )}
      {error && (
        <p className="field__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
