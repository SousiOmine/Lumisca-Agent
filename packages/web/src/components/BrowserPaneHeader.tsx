import { IconArrowBarToRight, IconBrowser } from "@tabler/icons-react";

interface BrowserPaneHeaderProps {
  /** The page currently loaded in the lab (shown as a slim URL label). */
  url: string | null;
  /** Hide the pane. The lab itself keeps running (the agent's browser
   * tools keep working in the background). */
  onHide: () => void;
}

/** The header strip of the browser lab pane (the right-side panel hosting
 * the agent's browser WebView). It is rendered by the app's own webview
 * directly ABOVE the native lab WebView (which starts below this strip),
 * so it never overlaps it and stays fully clickable. */
export function BrowserPaneHeader({ url, onHide }: BrowserPaneHeaderProps) {
  return (
    <div className="browser-pane-header">
      <span className="browser-pane-icon" aria-hidden="true">
        <IconBrowser size={13} />
      </span>
      {url !== null && (
        <span className="browser-pane-url" title={url}>
          {url}
        </span>
      )}
      <button
        type="button"
        className="browser-pane-hide"
        onClick={onHide}
        title="ブラウザペインを隠す"
        aria-label="ブラウザペインを隠す"
      >
        <IconArrowBarToRight size={15} />
      </button>
    </div>
  );
}
