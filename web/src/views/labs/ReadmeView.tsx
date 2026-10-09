import { ExternalLink } from "lucide-react";
import type { ReadmeBlock, ReadmeInline } from "@shared/labs";
import { ReadmeDiagram } from "./ReadmeDiagram";

// A lab's readme, from the blocks labs-build parsed (plan ruling 2). Every
// piece is a React element with text children: no HTML string is ever
// injected, so "<img ...>" in a readme is shown as those characters. A
// hand-drawn ```text sketch arrives as its diagrams (block "diagram":
// ReadmeDiagram, an <img> of a committed SVG from shared/guides).

const safeHref = (href: string): string | null => {
  try {
    return new URL(href).protocol === "https:" ? href : null;
  } catch {
    return null;
  }
};

function Inline({ x }: { x: ReadmeInline }) {
  switch (x.t) {
    case "b":
      return <strong>{x.text}</strong>;
    case "code":
      return <code>{x.text}</code>;
    case "a": {
      const href = safeHref(x.href);
      if (!href) return <>{x.text}</>;
      return (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {x.text}
          <ExternalLink size={12} aria-hidden className="labs-readme__ext" />
        </a>
      );
    }
    default:
      return <>{x.text}</>;
  }
}

const Inlines = ({ list }: { list: ReadmeInline[] }) => (
  <>
    {list.map((x, i) => (
      <Inline key={i} x={x} />
    ))}
  </>
);

function Block({ b }: { b: ReadmeBlock }) {
  switch (b.t) {
    case "h": {
      // The modal's title (h2) is the lab's; readme headings sit under it, beside the Cost and Deploy headings (h3).
      const H = b.level === 3 ? "h4" : "h3";
      return <H className={`labs-readme__h labs-readme__h${b.level}`}>{b.text}</H>;
    }
    case "p":
      return (
        <p>
          <Inlines list={b.inlines} />
        </p>
      );
    case "ul":
      return (
        <ul>
          {b.items.map((item, i) => (
            <li key={i}>
              <Inlines list={item} />
            </li>
          ))}
        </ul>
      );
    case "code":
      return (
        <pre className="labs-readme__pre">
          <code>{b.text}</code>
        </pre>
      );
    case "diagram":
      return <ReadmeDiagram b={b} />;
    case "details":
      // Collapsed until the reader opens it (break-fix "What was broken"); never opened by a refresh.
      return (
        <details className="labs-readme__details">
          <summary>{b.summary}</summary>
          <Blocks blocks={b.blocks} />
        </details>
      );
  }
}

const Blocks = ({ blocks }: { blocks: ReadmeBlock[] }) => (
  <>
    {blocks.map((b, i) => (
      <Block key={i} b={b} />
    ))}
  </>
);

export function ReadmeView({ blocks }: { blocks: ReadmeBlock[] }) {
  return (
    <article className="labs-readme" aria-label="Readme">
      {blocks.length === 0 ? <p className="labs-muted">This lab has no readme.</p> : <Blocks blocks={blocks} />}
    </article>
  );
}
