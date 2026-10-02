import type { ReactNode } from "react";
import "./PageHeader.css";

export interface PageHeaderProps {
  title: string;
  subtitle?: ReactNode;
  /** Right-hand context: environment/region selects, range picker, primary button. */
  right?: ReactNode;
}

/** Page title (28 px) with a subtitle, and the page's context controls on the right. */
export function PageHeader({ title, subtitle, right }: PageHeaderProps) {
  return (
    <header className="page-header">
      <div className="page-header__text">
        <h1 className="page-header__title">{title}</h1>
        {subtitle && <p className="page-header__subtitle">{subtitle}</p>}
      </div>
      {right && <div className="page-header__right">{right}</div>}
    </header>
  );
}
