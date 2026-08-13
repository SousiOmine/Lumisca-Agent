import { useEffect, useRef, useState } from "react";
import { IconDownload, IconX } from "@tabler/icons-react";
import type { UpdateControls } from "../hooks/useUpdateStatus.ts";

/** The "update ready" strip under the title bar (desktop only; renders
 * nothing while the shell is unreachable). Owns its dismissed state:
 * a new update finishing its download (ready false → true) re-shows it,
 * but a poll that keeps the ready flag set does not. */
export function UpdateBanner({ update }: { update: UpdateControls }) {
  const [dismissed, setDismissed] = useState(false);
  // Re-show the banner when a new update finishes downloading (the ready
  // flag toggles false -> true), but not on every poll while it stays
  // ready.
  const updateReadyRef = useRef(false);
  useEffect(() => {
    const ready = update.status?.ready ?? false;
    if (ready && !updateReadyRef.current) {
      setDismissed(false);
    }
    updateReadyRef.current = ready;
  }, [update.status?.ready]);

  if (!update.status?.ready || dismissed) return null;

  return (
    <div className="update-banner">
      <IconDownload size={16} />
      <span className="update-banner-text">
        Lumisca v{update.status.latestVersion}{" "}
        のアップデートが準備できました。インストールするとアプリが再起動します。
      </span>
      <button
        type="button"
        className="btn push"
        onClick={update.install}
      >
        インストール
      </button>
      <button
        type="button"
        className="btn"
        onClick={() => setDismissed(true)}
        title="閉じる"
        aria-label="閉じる"
      >
        <IconX size={14} />
      </button>
    </div>
  );
}
