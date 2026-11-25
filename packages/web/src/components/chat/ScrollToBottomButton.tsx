import { IconArrowDown } from "@tabler/icons-preact";
import { useT } from "../../i18n.ts";

/** Floating jump-to-latest control drawn at the bottom edge of a transcript
 * only while the reader has scrolled up into earlier history. */
export function ScrollToBottomButton({ onClick }: { onClick: () => void }) {
  const t = useT();
  const label = t("chat.transcript.scrollToBottom");
  return (
    <button
      type="button"
      className="scroll-bottom-btn"
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      <IconArrowDown size={16} stroke={1.75} />
    </button>
  );
}
