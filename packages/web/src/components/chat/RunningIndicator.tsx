import { useT } from "../../i18n.ts";

/** The run's presence in a transcript that shows no work log (stella): a
 * pulsing dot and one word, where code mode's turn timer would be. It says
 * only that something is happening — the point of hiding the work is not to
 * replace it with a different account of it. Rendered only until the reply
 * starts streaming: the streaming text's own cursor then carries the
 * "still going" signal, and two indicators would fight for the eye. */
export function RunningIndicator() {
  const t = useT();
  return (
    <div className="chat-running" role="status">
      <span className="live-dot" />
      <span>{t("chat.stella.working")}</span>
    </div>
  );
}
