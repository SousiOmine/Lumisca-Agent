import type { MessageKey, MessageParams } from "@lumisca/core/shared";
import { formatClockTime } from "../../format.ts";
import { useLocale, useT } from "../../i18n.ts";
import type { StellaHandover } from "../../types.ts";

/**
 * The bar the run waits on: why the agent stopped, what it needs, when the
 * wait ends, the note that goes back, and the two clipboard words.
 *
 * Split out of StellaPane.tsx as the markup of that bar. What is being
 * written and whether a send is in flight stay with the pane: the bar comes
 * and goes with each hand-over while the pane stays mounted, so a note left
 * unsent belongs to the pane's lifetime rather than to this form's.
 */
export function StellaHandoverForm({
  handover,
  note,
  onNoteChange,
  finishing,
  finishError,
  onSubmit,
  clipboard,
}: {
  handover: StellaHandover;
  /** The note the user is writing, sent with the hand-over when they finish. */
  note: string;
  onNoteChange: (note: string) => void;
  /** A send is in flight; the submit button is disabled meanwhile. */
  finishing: boolean;
  /** Why the last send failed, or null. */
  finishError: string | null;
  onSubmit: () => void;
  /** The clipboard exchange, drawn only while it is available (the server
   * refuses a write outside a hand-over, so the words would be dead
   * elsewhere). */
  clipboard:
    | {
        busy: boolean;
        note: {
          tone: "ok" | "error";
          key: MessageKey;
          params?: MessageParams;
        } | null;
        onCopy: () => void;
        onPaste: () => void;
      }
    | undefined;
}) {
  const t = useT();
  const locale = useLocale();
  return (
    <form
      className="stella-handover"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <p className="stella-handover-label">
        {t("chat.stella.handover.reason")}
      </p>
      <p className="stella-handover-reason">{handover.reason}</p>
      {handover.instructions !== null && (
        <p className="stella-handover-instructions">{handover.instructions}</p>
      )}
      <p className="stella-handover-deadline">
        {t("chat.stella.handover.deadline", {
          time: formatClockTime(handover.expiresAt, locale),
        })}
      </p>
      <div className="stella-handover-actions">
        <input
          type="text"
          className="stella-handover-note"
          placeholder={t("chat.stella.handover.notePlaceholder")}
          aria-label={t("chat.stella.handover.notePlaceholder")}
          value={note}
          onChange={(event) => onNoteChange(event.currentTarget.value)}
        />
        <button type="submit" className="btn primary" disabled={finishing}>
          {finishing
            ? t("chat.stella.handover.finishing")
            : t("chat.stella.handover.done")}
        </button>
      </div>
      {clipboard !== undefined && (
        <div className="stella-handover-clipboard">
          <button
            type="button"
            className="btn small"
            disabled={clipboard.busy}
            onClick={clipboard.onCopy}
            title={t("chat.stella.handover.clipboard.copyHint")}
            aria-label={t("chat.stella.handover.clipboard.copyHint")}
          >
            {t("chat.stella.handover.clipboard.copy")}
          </button>
          <button
            type="button"
            className="btn small"
            disabled={clipboard.busy}
            onClick={clipboard.onPaste}
            title={t("chat.stella.handover.clipboard.pasteHint")}
            aria-label={t("chat.stella.handover.clipboard.pasteHint")}
          >
            {t("chat.stella.handover.clipboard.paste")}
          </button>
          {clipboard.note !== null && (
            <span
              className="stella-clipboard-note"
              data-tone={clipboard.note.tone}
              role={clipboard.note.tone === "error" ? "alert" : "status"}
            >
              {t(clipboard.note.key, clipboard.note.params)}
            </span>
          )}
        </div>
      )}
      {finishError !== null && (
        <p className="error-text" role="alert">
          {finishError}
        </p>
      )}
    </form>
  );
}
