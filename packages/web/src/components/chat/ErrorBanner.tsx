import { useState } from "react";
import { IconCheck, IconClipboard } from "@tabler/icons-react";

/** The session error banner. Clicking it copies the error text to the
 * clipboard — provider error messages are long and hard to select by
 * hand, and the banner sits at the bottom of the chat. */
export function ErrorBanner({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable: the text stays selectable.
    }
  };

  return (
    <div
      className="msg error-banner"
      role="button"
      tabIndex={0}
      title="クリックでコピー"
      aria-label="エラーをクリップボードにコピー"
      onClick={() => void handleCopy()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          void handleCopy();
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
