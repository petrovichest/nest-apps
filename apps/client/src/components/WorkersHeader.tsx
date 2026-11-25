import { NavLink } from "react-router";
import { useI18n } from "../i18n";
import { WorkspaceHeader } from "./WorkspaceHeader";

export function WorkersHeader({
  processes = false,
  onOpenNavigation,
}: {
  processes?: boolean;
  onOpenNavigation(): void;
}) {
  const { t } = useI18n();
  return (
    <WorkspaceHeader
      title={processes ? t("Процессы") : t("Работники")}
      onOpenNavigation={onOpenNavigation}
      navigation={
        <nav className="workers-tabs" aria-label={t("Раздел работников")}>
          <NavLink to="/workers" end>
            {t("Работники")}
          </NavLink>
          <NavLink to="/workers/processes">{t("Процессы")}</NavLink>
        </nav>
      }
    />
  );
}
