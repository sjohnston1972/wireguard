// views/labs/ReadmeDiagram.tsx
//
// Plain English: a diagram in a lab's readme, in place of the hand-drawn
// sketch it replaced (shared/guides, npm run labs-diagrams): a generated
// architecture diagram or a Mermaid concept diagram. It is an <img> of a
// static SVG asset (fetched when it scrolls into view, never part of the
// entry bundle), on a white card in either theme (the drawings are made for
// paper), with its caption under it. Clicking it opens it in a viewer over
// the page: fitted to the window first, then at its actual size (scrolling) with
// one more click or the "Actual size" button. Escape or Close shuts it.

import * as Dialog from "@radix-ui/react-dialog";
import { Maximize2, Minimize2, X, ZoomIn } from "lucide-react";
import { useState } from "react";
import type { ReadmeBlock } from "@shared/labs";
import { ESCAPE_HANDOFF, escapeHandedToDialog } from "@/components/escapeHandoff";
import { guideUrl } from "./guides";
import "./ReadmeDiagram.css";

export type DiagramBlock = Extract<ReadmeBlock, { t: "diagram" }>;

export function ReadmeDiagram({ b, urls }: { b: DiagramBlock; urls?: Readonly<Record<string, string>> }) {
  const url = guideUrl(b.file, urls);
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  if (!url) return <p className="labs-muted">The diagram “{b.title}” is not in this build.</p>;
  const show = (o: boolean) => {
    setOpen(o);
    if (!o) setFull(false);
  };
  return (
    <figure className={`labs-diagram labs-diagram--${b.kind}`}>
      <button type="button" className="labs-diagram__open" onClick={() => show(true)} aria-label={`Enlarge: ${b.title}`} aria-haspopup="dialog">
        <img src={url} alt={b.alt} width={b.width} height={b.height} loading="lazy" decoding="async" className="labs-diagram__img" />
        <span className="labs-diagram__hint" aria-hidden="true">
          <ZoomIn size={14} />
          Enlarge
        </span>
      </button>
      <figcaption className="labs-diagram__caption">{b.title}</figcaption>
      <Dialog.Root open={open} onOpenChange={show}>
        <Dialog.Portal>
          <Dialog.Overlay className="labs-lightbox__overlay" />
          <Dialog.Content
            className="labs-lightbox"
            aria-modal="true"
            aria-describedby={undefined}
            {...{ [ESCAPE_HANDOFF]: "" }}
            onKeyDown={(e) => {
              if (e.key === "Escape" && escapeHandedToDialog(e.nativeEvent)) {
                e.stopPropagation(); // the lab's dialog under it stays open
                show(false);
              }
            }}
          >
            <header className="labs-lightbox__head">
              <Dialog.Title className="labs-lightbox__title">{b.title}</Dialog.Title>
              <button type="button" className="labs-lightbox__button" aria-pressed={full} onClick={() => setFull((f) => !f)}>
                {full ? <Minimize2 size={16} aria-hidden /> : <Maximize2 size={16} aria-hidden />}
                {full ? "Fit to window" : "Actual size"}
              </button>
              <Dialog.Close className="labs-lightbox__close" aria-label="Close">
                <X size={18} aria-hidden />
              </Dialog.Close>
            </header>
            <div className={`labs-lightbox__body${full ? " labs-lightbox__body--full" : ""}`} data-testid="labs-lightbox-body">
              <img src={url} alt={b.alt} width={b.width} height={b.height} className="labs-lightbox__img" onClick={() => setFull((f) => !f)} />
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </figure>
  );
}
