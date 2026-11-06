import { Children, type ReactNode, useState } from "react";
import { useI18n } from "../i18n";

const PREVIEW_LIMIT = 5;

/** Project and archive lists reveal at most five more rows per click. */
export function SidebarList({ children, resetKey }: { children: ReactNode; resetKey: number }) {
  const { t } = useI18n();
  const [preview, setPreview] = useState({ resetKey, limit: PREVIEW_LIMIT });
  if (preview.resetKey !== resetKey) setPreview({ resetKey, limit: PREVIEW_LIMIT });
  const limit = preview.resetKey === resetKey ? preview.limit : PREVIEW_LIMIT;
  const items = Children.toArray(children);
  const showsAll = limit >= items.length;

  return (
    <>
      {items.slice(0, limit)}
      {items.length > PREVIEW_LIMIT && (
        <button
          className="show-more"
          type="button"
          onClick={() =>
            setPreview({
              resetKey,
              limit: showsAll ? PREVIEW_LIMIT : Math.min(items.length, limit + PREVIEW_LIMIT),
            })
          }
        >
          {showsAll
            ? t("Показать меньше")
            : t("Показать ещё {{count}}", {
                count: Math.min(PREVIEW_LIMIT, items.length - limit),
              })}
        </button>
      )}
    </>
  );
}
