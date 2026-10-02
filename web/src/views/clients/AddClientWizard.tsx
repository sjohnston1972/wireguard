import { useState, type KeyboardEvent, type ReactNode } from "react";
import { ApiError } from "@/api/client";
import { useAddClient } from "@/api/mutations";
import { fillConfig, genKeypair } from "@/lib/wgkeys";
import { Button, Field, Modal, Sheet, cx, useIsPhone } from "@/components";
import { allowedIpsFor, type ClientsConfig, type Routing } from "./model";
import { ConfigDelivery } from "./ConfigDelivery";
import "./AddClientWizard.css";

const STEPS = ["Name", "Routing", "Expiry", "Delivery"] as const;
const EXPIRY = [
  { days: 0, label: "Never", hint: "Works until you disable or delete it." },
  { days: 1, label: "1 day", hint: "A quick guest." },
  { days: 7, label: "7 days", hint: "A visitor for the week." },
  { days: 30, label: "30 days", hint: "A longer stay." },
];

/** The server's rule (validPeerName): starts with a letter or digit; letters, digits, spaces, - or _; up to 32. */
const NAME_OK = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,31}$/;

/** The finished config: in this component's state only, from Create until the dialog closes. */
interface Made {
  name: string;
  ip: string;
  conf: string;
}

/**
 * Add a client: Name → Routing → Expiry → Delivery (spec 8.2). The key pair
 * is made in this browser when Create is pressed; only the public half is
 * sent. The private half goes straight into the finished config in this
 * component's state and nowhere else, so closing the dialog (Done, Escape,
 * the X, leaving the page) drops it. A failed request keeps every input but
 * throws its key away: the next try makes a new one.
 */
export function AddClientWizard({ config, onClose }: { config: ClientsConfig; onClose: () => void }) {
  const phone = useIsPhone();
  const add = useAddClient();
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [routing, setRouting] = useState<Routing>({ full_tunnel: false, home_lan: false, azure_vnet: false, tunnel_dns: false });
  const [days, setDays] = useState(0);
  const [making, setMaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<Made | null>(null);

  const close = () => {
    setMade(null);
    onClose();
  };

  const next = () => {
    if (step === 0) {
      const n = name.trim();
      if (!NAME_OK.test(n)) {
        setNameError("Start with a letter or digit; then letters, digits, spaces, - or _; up to 32 characters.");
        return;
      }
      setNameError(null);
    }
    setStep((s) => s + 1);
  };

  const create = async () => {
    setError(null);
    setMaking(true);
    try {
      // The key pair lives only in this call: on failure it is simply dropped.
      const keys = await genKeypair();
      const full = routing.full_tunnel;
      const res = await add.mutateAsync({
        name: name.trim(),
        public_key: keys.publicKey,
        full_tunnel: full,
        azure_vnet: !full && routing.azure_vnet,
        tunnel_dns: full || routing.tunnel_dns,
        home_lan: !full && routing.home_lan,
        expires_days: days,
      });
      setMade({ name: res.peer.name, ip: res.peer.ip, conf: fillConfig(res.template, keys.privateKey) });
      setStep(3);
    } catch (e) {
      if (e instanceof ApiError && e.field === "name") {
        setNameError(e.message);
        setStep(0);
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setMaking(false);
    }
  };

  const ips = allowedIpsFor(config, routing);
  let body: ReactNode;
  if (step === 0) {
    body = (
      <Field label="Name" hint="Shown in the list, and the .conf file's name." error={nameError}>
        {(p) => (
          <input
            {...p}
            className="input"
            value={name}
            maxLength={32}
            autoComplete="off"
            spellCheck={false}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                next();
              }
            }}
          />
        )}
      </Field>
    );
  } else if (step === 1) {
    const set = (k: keyof Routing) => (e: { target: { checked: boolean } }) => setRouting((r) => ({ ...r, [k]: e.target.checked }));
    const full = routing.full_tunnel;
    body = (
      <div className="wiz__routing">
        <fieldset className="wiz__choices">
          <legend className="field__label">What goes through the tunnel</legend>
          <Choice name="mode" type="radio" checked={!full} onChange={() => setRouting((r) => ({ ...r, full_tunnel: false }))} title="Standard" hint="Only the tunnel and the VM; everything else goes the usual way." />
          {config.homeLanCidr && (
            <Choice type="checkbox" indent checked={!full && routing.home_lan} disabled={full} onChange={set("home_lan")} title="+ Home LAN" hint={<>Reach <span className="mono">{config.homeLanCidr}</span> through the home site, from away.</>} />
          )}
          <Choice type="checkbox" indent checked={!full && routing.azure_vnet} disabled={full} onChange={set("azure_vnet")} title="+ Azure VNet" hint={<>Reach <span className="mono">{config.vnetCidr}</span> in Azure.</>} />
          <Choice name="mode" type="radio" checked={full} onChange={() => setRouting((r) => ({ ...r, full_tunnel: true }))} title="Full tunnel" hint="All traffic, IPv4 and IPv6, through Azure (an exit node). Includes the tunnel DNS." />
          <Choice type="checkbox" checked={full || routing.tunnel_dns} disabled={full} onChange={set("tunnel_dns")} title="Tunnel DNS" hint="Ad-blocking and .wg names. Leave off if the device stays connected while the VM is down." />
        </fieldset>
        <div className="wiz__ips">
          <span className="field__label">AllowedIPs in the config</span>
          <output className="wiz__ips-value mono" aria-label="AllowedIPs">
            {ips.join(", ")}
          </output>
        </div>
      </div>
    );
  } else if (step === 2) {
    body = (
      <fieldset className="wiz__choices">
        <legend className="field__label">When it stops working</legend>
        {EXPIRY.map((x) => (
          <Choice key={x.days} name="expiry" type="radio" checked={days === x.days} onChange={() => setDays(x.days)} title={x.label} hint={x.hint} />
        ))}
        {error && (
          <p className="wiz__error" role="alert">
            {error}
          </p>
        )}
      </fieldset>
    );
  } else {
    body = made && <ConfigDelivery name={made.name} ip={made.ip} conf={made.conf} large={phone} />;
  }

  // Escape closes the wizard even while a toast is up (a toast is the top
  // Radix layer, so the dialog's own Escape would only dismiss the toast).
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !e.defaultPrevented && !making) {
      e.preventDefault();
      close();
    }
  };

  const footer = (
    <div className="wiz__foot" onKeyDown={onKeyDown}>
      {step > 0 && step < 3 && (
        <Button variant="ghost" onClick={() => setStep((s) => s - 1)} disabled={making}>
          Back
        </Button>
      )}
      <span className="wiz__spacer" />
      {step < 2 && (
        <Button variant="primary" onClick={next}>
          Next
        </Button>
      )}
      {step === 2 && (
        <Button variant="primary" onClick={create} loading={making} disabled={making}>
          Create client
        </Button>
      )}
      {step === 3 && (
        // Focus lands on Done, as the old dashboard did, so Enter or Escape finishes.
        <Button variant="primary" onClick={close} autoFocus>
          Done
        </Button>
      )}
    </div>
  );

  const content = (
    <div className="wiz" onKeyDown={onKeyDown}>
      <ol className="wiz__steps" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s} className={cx("wiz__step", i === step && "wiz__step--on", i < step && "wiz__step--done")} aria-current={i === step ? "step" : undefined}>
            <span className="wiz__num" aria-hidden>
              {i + 1}
            </span>
            {s}
          </li>
        ))}
      </ol>
      {body}
    </div>
  );

  // Closing by any route (X, Escape, the overlay) is the same as Done: the config is dropped.
  const onOpenChange = (o: boolean) => {
    if (!o && !making) close();
  };
  return phone ? (
    <Sheet open onOpenChange={onOpenChange} title="Add client" footer={footer}>
      {content}
    </Sheet>
  ) : (
    <Modal open onOpenChange={onOpenChange} title="Add client" footer={footer} width={step === 3 ? 620 : 560}>
      {content}
    </Modal>
  );
}

function Choice({
  type,
  name,
  checked,
  disabled,
  onChange,
  title,
  hint,
  indent,
}: {
  type: "radio" | "checkbox";
  name?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (e: { target: { checked: boolean } }) => void;
  title: string;
  hint: ReactNode;
  indent?: boolean;
}) {
  return (
    <label className={cx("wiz__choice", checked && "wiz__choice--on", disabled && "wiz__choice--off", indent && "wiz__choice--indent")}>
      <input type={type} name={name} checked={checked} disabled={disabled} onChange={onChange} />
      <span className="wiz__choice-text">
        <span className="wiz__choice-title">{title}</span>
        <span className="wiz__choice-hint">{hint}</span>
      </span>
    </label>
  );
}
