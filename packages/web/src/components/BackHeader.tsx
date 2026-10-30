import type { ReactNode } from "preact/compat";
import { IconArrowLeft } from "@tabler/icons-preact";
import { useT } from "../i18n.ts";

/** The header of a settings screen reached from a list: "back" on the left,
 * the screen's title, then whatever the screen puts on the right. */
export function BackHeader({
  onBack,
  title,
  children,
}: {
  onBack: () => void;
  title: ReactNode;
  children?: ReactNode;
}) {
  const t = useT();
  return (
    <div className="modal-header">
      <button type="button" className="btn" onClick={onBack}>
        <IconArrowLeft size={14} /> {t("common.back")}
      </button>
      <h2>{title}</h2>
      {children}
    </div>
  );
}
