import { useState } from "react";
import { Check, Copy, Download } from "lucide-react";
import { downloadText } from "@/api/download";
import { confFileName } from "@/lib/wgkeys";
import { Button, QrCode } from "@/components";
import "./ConfigDelivery.css";

/**
 * A finished config, shown once: QR code, .conf download, copy. The config
 * holds the private key, so it lives only in the dialog that shows it: the
 * parent drops it when the dialog closes, and nothing here keeps a copy
 * (the download's object URL is let go of at once by downloadText).
 */
export function ConfigDelivery({ name, ip, conf, large }: { name: string; ip: string; conf: string; large?: boolean }) {
  const [copied, setCopied] = useState<"yes" | "failed" | null>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(conf);
      setCopied("yes");
    } catch {
      setCopied("failed");
    }
  };
  return (
    <div className="deliver">
      <div className="deliver__qr">
        <QrCode value={conf} label={`QR code for ${name}'s config`} size={large ? 300 : 208} />
      </div>
      <div className="deliver__side">
        <p className="deliver__lead">
          <strong>{name}</strong> is ready at <span className="mono">{ip}</span>. Scan the code with the WireGuard app, or save the file.
        </p>
        <div className="deliver__buttons">
          <Button variant="primary" icon={<Download size={15} aria-hidden />} onClick={() => downloadText(confFileName(name), conf)}>
            Download .conf
          </Button>
          <Button icon={copied === "yes" ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />} onClick={copy}>
            {copied === "yes" ? "Copied" : "Copy config"}
          </Button>
        </div>
        {copied === "failed" && <p className="deliver__warn">This browser would not copy; use the download instead.</p>}
        <p className="deliver__note">
          The private key exists only in this window: it was made here and never sent. Close the window and it is gone; to get a config again, use Get new
          config.
        </p>
        <details className="deliver__text">
          <summary>Show the config text</summary>
          <pre>{conf}</pre>
        </details>
      </div>
    </div>
  );
}
