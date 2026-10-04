// Plain English: the VM's boot log (its serial console), in the desktop
// modal or the phone's sheet. The Worker fetches it from Azure, redacts it
// and keeps at most the last 64 KB; this only shows what the Worker stored,
// or asks it to fetch again (one a minute). A URL is never shown: anything
// that looks like one is replaced before it reaches the screen.

import { useMemo, useState } from "react";
import { Button, Drawer, LogView, formatAge } from "@/components";
import { useBootLog } from "@/api/queries";
import { useFetchBootLog } from "@/api/mutations";
import { ApiError } from "@/api/client";
import { parseLog } from "@/lib/parseLog";
import "./BootLog.css";

/** Any URL in the text, whatever the Worker did: it never reaches the browser's screen. */
export const noUrls = (text: string) => text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "‹link removed›");

const size = (b: number) => (b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} bytes`);

export function BootLogModal({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const q = useBootLog({ enabled: open });
  const fetchNow = useFetchBootLog();
  const [slow, setSlow] = useState(false);
  const d = q.data;
  const lines = useMemo(() => parseLog(d?.text ? noUrls(d.text) : null).lines, [d?.text]);
  const facts = d?.fetchedAt
    ? [`Fetched ${formatAge(Date.now() - Date.parse(d.fetchedAt))}`, size(d.bytes), d.truncated && "the last 64 KB only", d.redactions > 0 && `${d.redactions} secret${d.redactions === 1 ? "" : "s"} hidden`].filter(Boolean).join(" · ")
    : undefined;
  const fetch = () => {
    setSlow(false);
    fetchNow.mutate(undefined, { onError: (e) => setSlow(e instanceof ApiError && e.status === 429) });
  };
  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      side="auto"
      size="lg"
      title="Boot log"
      subtitle={facts}
      className="ov-bootlog"
      footer={
        <Button variant="secondary" onClick={fetch} loading={fetchNow.isPending} disabled={fetchNow.isPending}>
          Fetch now
        </Button>
      }
    >
      {slow && (
        <p className="ov-bootlog__note" role="status">
          Azure allows one fetch a minute. Try again in a minute.
        </p>
      )}
      {lines.length ? (
        <LogView lines={lines} aria-label="Boot log" className="ov-bootlog__log" />
      ) : (
        <p className="ov-bootlog__note">{q.isLoading ? "Loading the boot log…" : noUrls(d?.reason ?? "No boot log yet.")}</p>
      )}
    </Drawer>
  );
}
