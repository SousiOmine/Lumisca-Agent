import type { MessageKey } from "@lumisca/core/shared";
import type { ReactNode } from "preact/compat";
import { useT } from "../../i18n.ts";
import type { StellaActivity } from "../../types.ts";

const ACTIVITY_LABEL: Record<StellaActivity, MessageKey> = {
  thinking: "chat.stella.activity.thinking",
  working: "chat.stella.working",
  browsing: "chat.stella.activity.browsing",
  searching: "chat.stella.activity.searching",
  files: "chat.stella.activity.files",
};

/** The run's presence in a transcript that shows no work log (stella): the
 * agent's face in the margin, its typing dots beside it, and a quiet
 * high-level phase label so long-running turns still feel alive.
 *
 * `avatar` is the face to draw in the margin (the same component the
 * conversation's messages use, at the same size), so the dots line up with
 * the text the reply will occupy instead of floating in the wrong column.
 */
export function RunningIndicator({
  avatar,
  activity,
}: {
  avatar?: ReactNode;
  activity?: StellaActivity | null;
}) {
  const t = useT();
  const label = t(activity ? ACTIVITY_LABEL[activity] : "chat.stella.working");
  return (
    <div className="stella-msg stella-running" role="status">
      <div className="stella-msg-avatar" aria-hidden="true">
        {avatar}
      </div>
      <div className="stella-msg-main">
        <div className="stella-typing">
          <span className="stella-typing-dot" aria-hidden="true" />
          <span className="stella-typing-dot" aria-hidden="true" />
          <span className="stella-typing-dot" aria-hidden="true" />
          <span key={label} className="stella-activity-label">
            {label}
          </span>
        </div>
      </div>
    </div>
  );
}
