import { IconCheck, IconClipboard } from "@tabler/icons-preact";
import { useT } from "../../i18n.ts";
import { useCopy } from "../../hooks/useSave.ts";

/** The session error banner. Clicking it copies the error text to the
 * clipboard — provider error messages are long and hard to select by
 * hand, and the banner sits at the bottom of the chat. */
export function ErrorBanner({ text }: { text: string }) {
  const t = useT();
  const { copied, copy } = useCopy(text);

  return (
    <div
      className="msg error-banner"
      role="button"
      tabIndex={0}
      title={t("chat.error.copyTitle")}
      aria-label={t("chat.error.copyAriaLabel")}
      onClick={() => void copy()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          void copy();
        }
      }}
    >
      <div className="msg-body error-text">
        <p>{text}</p>
      </div>
      <span className="error-copy-btn" aria-hidden>
        {copied
          ? <IconCheck size={16} stroke={2} />
          : <IconClipboard size={16} stroke={1.5} />}
      </span>
    </div>
  );
}
