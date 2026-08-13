import { useState } from "react";
import { IconArrowBackUp, IconCheck, IconClipboard } from "@tabler/icons-react";
import { ContentImages } from "../ContentImages.tsx";
import type { UserMessageImage } from "./types.ts";

/** A user message with its action row: rewind (restore to the composer)
 * and copy. */
export function CopyableUserMessage({
  text,
  images,
  timestamp,
  onRewind,
}: {
  text: string;
  images: UserMessageImage[];
  timestamp: number;
  onRewind: (
    timestamp: number,
    text: string,
    images: UserMessageImage[],
  ) => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // fallback: select text
    }
  };

  return (
    <div className="msg-user-wrap">
      <div className="msg user">
        <div className="msg-body">
          {images.length > 0 && <ContentImages images={images} />}
          {text && <p>{text}</p>}
        </div>
      </div>
      <div className="msg-user-actions">
        <button
          type="button"
          className="msg-action-btn"
          onClick={() => onRewind(timestamp, text, images)}
        >
          <IconArrowBackUp size={16} stroke={1.5} />
        </button>
        {text && (
          <button
            type="button"
            className="msg-action-btn"
            onClick={handleCopy}
          >
            {copied
              ? <IconCheck size={16} stroke={2} />
              : <IconClipboard size={16} stroke={1.5} />}
          </button>
        )}
      </div>
    </div>
  );
}
