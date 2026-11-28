import { useEffect, useRef, type ReactNode } from "react";

import { useI18n } from "../i18n";
import { InfoIcon, PanelLeftIcon } from "./Icons";

export function WorkspaceHeader({
  title,
  focusTitle,
  subtitle,
  titleAccessory,
  leadingIcon,
  navigation,
  onOpenNavigation,
  onToggleInspector,
  actions,
}: {
  title: string;
  focusTitle?: boolean;
  subtitle?: ReactNode;
  titleAccessory?: ReactNode;
  leadingIcon?: ReactNode;
  navigation?: ReactNode;
  onOpenNavigation(): void;
  onToggleInspector?(): void;
  actions?: ReactNode;
}) {
  const { t } = useI18n();
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusTitle) titleRef.current?.focus({ preventScroll: true });
  }, [focusTitle]);
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
          <h1
            ref={titleRef}
            tabIndex={focusTitle ? -1 : undefined}
            className={navigation ? "sr-only" : undefined}
          >
            {title}
          </h1>
          {subtitle && <p>{subtitle}</p>}
          {navigation}
        </div>
      </div>
      {titleAccessory}
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
