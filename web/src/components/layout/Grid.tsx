import type { CSSProperties, HTMLAttributes } from "react";
import { cx } from "../cx";
import "./Grid.css";

export function Grid({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("grid12", className)} {...rest} />;
}

export interface ColProps extends HTMLAttributes<HTMLDivElement> {
  /** Columns of 12 to span on desktop (1-12). Below 1100 px every column is full width. */
  span?: number;
}

export function Col({ span = 12, className, style, ...rest }: ColProps) {
  return <div className={cx("grid12__col", className)} style={{ ...style, ["--span" as string]: span } as CSSProperties} {...rest} />;
}
