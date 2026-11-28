import { IconCheck, IconClipboard } from "@tabler/icons-preact";
import { useCopy } from "../../hooks/useSave.ts";
import { useT } from "../../i18n.ts";

/**
 * The copy control of a message's action row, with the status line a screen
 * reader hears when the copy succeeds.
 *
 * `rest` draws it without waiting for a hover. The agent's answer is what a
 * reader takes away (a command, a path, a paragraph), so its control has to
 * be findable while the page is still: a button held at `opacity: 0` is
 * drawn nowhere, and stella's answer — which owns no `.msg-user-wrap` — was
 * reported as having none at all. The reader's own message keeps the reveal:
 * its actions change what they just typed, which the eye is already on.
 */
export function MessageCopyButton({
  text,
  rest = false,
}: {
  /** What the clipboard receives. */
  text: string;
  /** Draw the control at rest instead of on hover (see chat.css). */
  rest?: boolean;
}) {
  const { copied, copy } = useCopy(text);
  const t = useT();
  return (
    <>
      <button
        type="button"
        className={rest ? "msg-action-btn rest" : "msg-action-btn"}
        title={t("chat.message.copy")}
        aria-label={t("chat.message.copy")}
        onClick={() => void copy()}
      >
        {copied ? (
          <IconCheck size={16} stroke={1.5} />
        ) : (
          <IconClipboard size={16} stroke={1.5} />
        )}
      </button>
      {/* Mounted empty and filled on success: a live region has to be in the
       * tree before its text changes to be announced, and the checkmark that
       * replaces the icon says nothing. */}
      <span className="visually-hidden" role="status">
        {copied ? t("chat.message.copied") : null}
      </span>
    </>
  );
}
