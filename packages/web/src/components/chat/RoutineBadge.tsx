import { useT } from "../../i18n.ts";

/**
 * The label above a bubble whose prompt a ROUTINE asked.
 *
 * A routine's run is delivered as the user's prompt, so it sits on their side
 * of the conversation — but the user did not type it. The label says who did,
 * because a scheduled request drawn as the person's own words credits them
 * with something they never wrote (see #37).
 *
 * Shared by stella and code mode: both run routines, and both would otherwise
 * show the words as the user's.
 */
export function RoutineBadge({ name }: { name: string }) {
  const t = useT();
  return (
    <div className="msg-mode-badge msg-routine-badge">
      {t("chat.message.routine", { name })}
    </div>
  );
}
