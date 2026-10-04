import { useState } from "react";
import { KeyRound } from "lucide-react";
import { useRekeyClient } from "@/api/mutations";
import { fillConfig, genKeypair } from "@/lib/wgkeys";
import { Button, Drawer, useIsPhone } from "@/components";
import type { Client } from "./model";
import { ConfigDelivery } from "./ConfigDelivery";
// Shares the wizard's dialog layout (footer, lead, error).
import "./AddClientWizard.css";

/**
 * "Get new config": new keys made in this browser (only the public half is
 * sent), then the wizard's Delivery step. The device's current config stops
 * working within 30 seconds. Like the wizard, the finished config lives only
 * in this dialog's state; a failure drops its key and a retry makes a new one.
 */
export function RekeyDialog({ client, onClose }: { client: Client; onClose: () => void }) {
  const phone = useIsPhone();
  const rekey = useRekeyClient();
  const [making, setMaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ name: string; ip: string; conf: string } | null>(null);

  const close = () => {
    setMade(null);
    onClose();
  };

  const go = async () => {
    setError(null);
    setMaking(true);
    try {
      const keys = await genKeypair();
      const res = await rekey.mutateAsync({ id: client.id, public_key: keys.publicKey });
      setMade({ name: res.peer.name, ip: res.peer.ip, conf: fillConfig(res.template, keys.privateKey) });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setMaking(false);
    }
  };

  const footer = (
    <div className="wiz__foot">
      {made ? (
        <>
          <span className="wiz__spacer" />
          <Button variant="primary" onClick={close} autoFocus>
            Done
          </Button>
        </>
      ) : (
        <>
          <Button variant="ghost" onClick={close} disabled={making}>
            Cancel
          </Button>
          <span className="wiz__spacer" />
          <Button variant="primary" icon={<KeyRound size={15} aria-hidden />} onClick={go} loading={making} disabled={making}>
            Make new keys
          </Button>
        </>
      )}
    </div>
  );

  const body = (
    <div className="wiz">
      {made ? (
        <ConfigDelivery name={made.name} ip={made.ip} conf={made.conf} large={phone} />
      ) : (
        <>
          <p className="wiz__lead">
            New keys for <strong>{client.name}</strong>, made in this browser. The config it has now stops working within 30 seconds; the new one includes its
            current routes and DNS settings.
          </p>
          {error && (
            <p className="wiz__error" role="alert">
              {error}
            </p>
          )}
        </>
      )}
    </div>
  );

  const title = `Get new config for ${client.name}`;
  const onOpenChange = (o: boolean) => !o && !making && close();
  // A centred modal on the desktop, a bottom sheet on the phone.
  return (
    <Drawer open onOpenChange={onOpenChange} title={title} footer={footer} size="md">
      {body}
    </Drawer>
  );
}
