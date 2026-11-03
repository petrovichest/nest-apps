import type { ReactNode } from "react";

import { useI18n } from "../i18n";
import { InfoIcon, PanelLeftIcon } from "./Icons";

export function WorkspaceHeader({
  title,
  subtitle,
  leadingIcon,
  onOpenNavigation,
  onToggleInspector,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  leadingIcon?: ReactNode;
  onOpenNavigation(): void;
  onToggleInspector?(): void;
  actions?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <header className="workspace-header">
      <div className="workspace-title">
        <button
          className="icon-button mobile-nav-toggle"
          aria-label={t("Открыть список задач")}
          onClick={onOpenNavigation}
        >
          <span className="account-status-icon" aria-hidden="true">
            <PanelLeftIcon />
          </span>
        </button>
        {leadingIcon && (
          <span aria-hidden="true" className="workspace-title-icon">
            {leadingIcon}
          </span>
        )}
        <div>
          <h1>{title}</h1>
          {subtitle && <p>{subtitle}</p>}
        </div>
      </div>
      <div className="workspace-actions">
        {actions}
        {onToggleInspector && (
          <button
            className="icon-button"
            aria-label={t("Показать сведения")}
            onClick={onToggleInspector}
          >
            <InfoIcon />
          </button>
        )}
      </div>
    </header>
  );
}
