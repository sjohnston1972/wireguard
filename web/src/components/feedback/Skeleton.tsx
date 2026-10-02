import type { CSSProperties } from "react";
import { cx } from "../cx";
import "./Skeleton.css";

export interface SkeletonProps {
  /** line: a text line; block: a rectangle; circle; row: a table row; tile: a metric tile. */
  variant?: "line" | "block" | "circle" | "row" | "tile";
  width?: number | string;
  height?: number | string;
  className?: string;
}

/** Shape-matched loading placeholder. Hidden from assistive tech; the owning panel announces loading. */
export function Skeleton({ variant = "line", width, height, className }: SkeletonProps) {
  const style: CSSProperties = { width, height };
  return <span aria-hidden="true" className={cx("skeleton", `skeleton--${variant}`, className)} style={style} />;
}
