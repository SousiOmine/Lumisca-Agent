import { IconArrowBarToRight } from "@tabler/icons-preact";
import type { PaneContent } from "../shell.ts";
import { paneIcon } from "./paneIcons.tsx";

interface PaneHeaderProps {
  /** The content currently hosted in the pane (its kind drives the
   * icon, its label is the shown text — for the browser: the URL). */
  content: PaneContent;
  /** Hide the pane. The hosted surface keeps running (the agent's
   * tools keep working in the background). */
  onHide: () => void;
  /** Why the last show/hide failed, if it did. */
  error?: string;
}

/** The header strip of the docked pane (the right-side panel hosting
 * the native surface, today the agent's browser WebView). It is rendered
 * by the app's own webview directly ABOVE the native pane window (which
 * starts below this strip), so it never overlaps it and stays fully
 * clickable. */
export function PaneHeader({ content, onHide, error }: PaneHeaderProps) {
  return (
    <div className="pane-header">
      <span className="pane-icon" aria-hidden="true">
        {paneIcon(content.kind, 13)}
      </span>
      {content.label !== null && (
        <span className="pane-label" title={content.label}>
          {content.label}
        </span>
      )}
      {error !== undefined && (
        <span className="pane-error error-text" role="alert" title={error}>
          このパネルは現在操作できません
        </span>
      )}
      <button
        type="button"
        className="pane-hide"
        onClick={onHide}
        title="パネルを閉じる"
        aria-label="パネルを閉じる"
      >
        <IconArrowBarToRight size={15} />
      </button>
    </div>
  );
}
