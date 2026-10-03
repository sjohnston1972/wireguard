import { cx } from "../cx";
import "./Diff.css";

export interface DiffLine {
  kind: "same" | "add" | "remove";
  text: string;
}

/** Line diff by longest common subsequence. Small inputs (rule sets, settings), so O(n*m) is fine. */
export function diffLines(before: string[], after: string[]): DiffLine[] {
  const n = before.length;
  const m = after.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = before[i] === after[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      out.push({ kind: "same", text: before[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: "remove", text: before[i++] });
    } else {
      out.push({ kind: "add", text: after[j++] });
    }
  }
  while (i < n) out.push({ kind: "remove", text: before[i++] });
  while (j < m) out.push({ kind: "add", text: after[j++] });
  return out;
}

export interface DiffProps {
  before: string[];
  after: string[];
  className?: string;
}

/** Before/after lines. Added and removed lines carry a +/- marker and a screen-reader word, not colour alone. */
export function Diff({ before, after, className }: DiffProps) {
  const lines = diffLines(before, after);
  if (!lines.some((l) => l.kind !== "same")) return <p className="diff__none">No changes</p>;
  return (
    <ul className={cx("diff", className)} aria-label="Changes">
      {lines.map((l, i) => (
        <li key={i} className={cx("diff__line", `diff__line--${l.kind}`)}>
          <span className="diff__mark" aria-hidden>
            {l.kind === "add" ? "+" : l.kind === "remove" ? "-" : " "}
          </span>
          {l.kind !== "same" && <span className="visually-hidden">{l.kind === "add" ? "added" : "removed"}</span>}
          <span className="diff__text">{l.text}</span>
        </li>
      ))}
    </ul>
  );
}
