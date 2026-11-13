import { errorMessage } from "@lumisca/core/shared";
import { useState } from "preact/compat";
import { formatClockTime } from "../../format.ts";
import { useLocale, useT } from "../../i18n.ts";
import { inDesktopShell } from "../../shell.ts";
import type { StellaShareRequest } from "../../types.ts";

/** A request to lend a folder, as the conversation carries it. A disconnect
 * needs no card: the page carries it out on its own (see useStella). */
type LendRequest = Extract<StellaShareRequest, { kind: "lend" }>;

interface ShareRequestCardProps {
  request: LendRequest;
  /** Open the folder dialog. It is one sheet for the whole view — the same
   * one the composer's menu opens — so it is not drawn inside this card: a
   * `position: fixed` sheet inside the transcript's scroll area would be
   * positioned against whatever box that area happens to be. */
  onPick: () => void;
  /** Refuse to lend one. The run continues without a folder. */
  onDecline: (toolCallId: string) => Promise<void>;
}

/**
 * The `share_request` card: the agent asks for a folder on this computer, and
 * the button opens the folder dialog.
 *
 * A card in the conversation, not a sheet over the window — the same
 * reasoning as EnvRequestCard: the request is a turn of the conversation, and
 * a modal would make reading back what the agent is doing impossible while
 * the user decides what to lend.
 *
 * The button opens the dialog the composer's menu opens (through `onPick`),
 * so the terms are read and set exactly once in this app: choose the folder,
 * then read-only or read-write, then share. The card does not lend on a click
 * of its own button — that would take "choose a folder" for agreement to the
 * terms.
 *
 * A browser tab has no OS folder picker, so the card says that instead of
 * offering a button that cannot work; refusing is the one answer left.
 */
export function ShareRequestCard({
  request,
  onPick,
  onDecline,
}: ShareRequestCardProps) {
  const t = useT();
  const locale = useLocale();
  // Only the refusal is answered here: lending is the dialog's business, and
  // it answers the run the moment it has a grant (see StellaView).
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const desktop = inDesktopShell();

  // One answer at a time: a second click while the first is in flight would
  // send the same answer twice. A failure keeps the card up with its reason,
  // so the reader can try again.
  const decline = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    onDecline(request.toolCallId)
      .catch((failure) => setError(errorMessage(failure)))
      .finally(() => setBusy(false));
  };

  return (
    <div
      className="share-request-card"
      role="group"
      aria-label={t("chat.stella.share.request.title")}
    >
      <h3 className="share-request-title">
        {t("chat.stella.share.request.title")}
      </h3>
      {/* The agent's own words: the one part of this card that cannot be
       * translated, and the part that says whether lending anything is worth
       * it. */}
      <p className="share-request-text">{request.reason}</p>
      {desktop ? (
        <p className="share-request-hint">
          {t("chat.stella.share.request.hint")}
        </p>
      ) : (
        <p className="error-text" role="alert">
          {t("chat.stella.share.request.browserOnly")}
        </p>
      )}
      <p className="share-request-deadline">
        {t("chat.stella.share.request.deadline", {
          time: formatClockTime(request.expiresAt, locale),
        })}
      </p>
      {error !== null && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <div className="share-request-actions">
        <button type="button" className="btn" disabled={busy} onClick={decline}>
          {t("chat.stella.share.request.decline")}
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={busy || !desktop}
          onClick={onPick}
        >
          {t("chat.stella.share.pick")}
        </button>
      </div>
    </div>
  );
}
