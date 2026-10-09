// views/labs/LabGuideButton.tsx
//
// Plain English: "Download PDF", the lab's printable guide (GET
// /labs/:id/guide.pdf), to keep open beside the portal as a reference. The
// first download of a lab version is made on the spot by Browser Rendering
// (a few seconds), so the button says "Preparing PDF…" until the file
// arrives; later ones come from the Worker's cache. A failure says what to do
// next, under the button. Demo mode has no guides (the server answers 409),
// so the button is greyed out there with the reason as its tooltip.

import { useId, useState } from "react";
import { FileDown } from "lucide-react";
import { Button, cx } from "@/components";
import { ApiError, NetworkError, SessionExpiredError } from "@/api/client";
import { useDemoOn } from "@/api/demo";
import { downloadLabGuide } from "@/api/download";
import "./LabGuideButton.css";

export const GUIDE_DEMO_OFF = "Lab guide PDFs are not available in demo mode";

/** What went wrong, in words the reader can act on. */
export function guideErrorWords(e: unknown): string {
  if (e instanceof SessionExpiredError) return "Your sign-in has expired. Reload the page to sign in again, then download the PDF.";
  if (e instanceof NetworkError) return "Couldn't reach wg-admin. Check your connection and try again.";
  if (e instanceof ApiError) {
    if (e.status === 404) return "This lab is no longer in the catalogue. Reload the page.";
    return e.message;
  }
  return "The PDF could not be downloaded. Try again.";
}

export function LabGuideButton({ labId, className }: { labId: string; className?: string }) {
  const demo = useDemoOn();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errId = useId();
  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      await downloadLabGuide(labId);
    } catch (e) {
      setError(guideErrorWords(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={cx("lab-guide", className)}>
      <Button
        size="sm"
        variant="secondary"
        icon={<FileDown size={14} aria-hidden />}
        loading={busy}
        disabled={demo}
        title={demo ? GUIDE_DEMO_OFF : "A printable guide to keep open as a reference"}
        aria-describedby={error ? errId : undefined}
        onClick={() => void download()}
      >
        {busy ? "Preparing PDF…" : "Download PDF"}
      </Button>
      <span className="lab-guide__status" role="status">
        {busy ? "Preparing the PDF guide. The first download of a lab can take a few seconds." : ""}
      </span>
      {error && (
        <p className="lab-guide__error" id={errId} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
