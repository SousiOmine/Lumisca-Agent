import type { ReactNode } from "preact/compat";
import { useT } from "../../i18n.ts";

/** The run's presence in a transcript that shows no work log (stella): the
 * agent's face in the margin and its typing dots beside it, where a message
 * of its own would go. It says only that something is happening — the point
 * of hiding the work is not to replace it with a different account of it.
 *
 * Rendered only until the reply starts streaming: the streaming text's own
 * cursor then carries the "still going" signal, and two indicators would
 * fight for the eye.
 *
 * `avatar` is the face to draw in the margin (the same component the
 * conversation's messages use, at the same size), so the dots line up with
 * the text the reply will occupy instead of floating in the wrong column.
 */
export function RunningIndicator({ avatar }: { avatar?: ReactNode }) {
  const t = useT();
  return (
    <div className="stella-msg stella-running" role="status">
      <div className="stella-msg-avatar" aria-hidden="true">{avatar}</div>
      <div className="stella-msg-main">
        <div className="stella-typing">
          <span className="stella-typing-dot" />
          <span className="stella-typing-dot" />
          <span className="stella-typing-dot" />
        </div>
      </div>
      <span className="visually-hidden">{t("chat.stella.working")}</span>
    </div>
  );
}
