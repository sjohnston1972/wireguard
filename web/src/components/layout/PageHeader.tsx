import type { ReactNode } from "react";
import "./PageHeader.css";

export interface PageHeaderProps {
  title: string;
  subtitle?: ReactNode;
  /**
   * The read-only environment control, first on the right as in the
   * Overview, Clients and Settings mockups. Views pass the shell's
   * <EnvironmentField /> here.
   */
  env?: ReactNode;
  /** Right-hand context: region select, range picker, primary button. */
  right?: ReactNode;
}

/** Page title (28 px) with a subtitle, and the page's context controls on the right. */
export function PageHeader({ title, subtitle, env, right }: PageHeaderProps) {
  return (
    <div className="page-header">
      <div className="page-header__text">
        <h1 className="page-header__title">{title}</h1>
        {subtitle && <p className="page-header__subtitle">{subtitle}</p>}
      </div>
      {(env || right) && (
        <div className="page-header__right">
          {env}
          {right}
        </div>
      )}
    </div>
  );
}
