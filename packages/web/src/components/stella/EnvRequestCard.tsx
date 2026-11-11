import { errorMessage } from "@lumisca/core/shared";
import { useState } from "preact/compat";
import { formatClockTime } from "../../format.ts";
import { useLocale, useT } from "../../i18n.ts";
import type { StellaEnvRequest } from "../../types.ts";

interface EnvRequestCardProps {
  /** The variable the run is waiting for. The name is all this card knows:
   * a value never arrives from the server. */
  request: StellaEnvRequest;
  /** Store the value. Rejects when the server did not take it (the wait
   * expired while the card was on screen); the card then shows the failure
   * and keeps the text, so it is not lost. */
  onProvide: (value: string, toolCallId: string) => Promise<void>;
  /** Refuse to enter a value. The run continues without it. */
  onDecline: (toolCallId: string) => Promise<void>;
}

/**
 * The `vm_env` request as a card in the conversation: the agent names a
 * variable it needs, the user types the value.
 *
 * A card, not a sheet over the window. The request is what the run is
 * waiting on — a turn of the conversation as much as a message is — so it
 * belongs where the conversation is. A modal made everything else
 * unreachable for as long as it stood there: reading back what the agent
 * had been doing, or finishing a sentence of one's own, was impossible
 * while the value was being fetched from somewhere else (a password
 * manager, a browser tab, a note). None of that was the wait's business,
 * and the wait is already bounded by its deadline.
 *
 * A card cannot be closed, so the sheet's "closing is a refusal" (Escape,
 * the backdrop) becomes a button that says what it does: the run continues
 * without the value. Dismissing the card without answering is not offered —
 * hiding it would leave the run with no answer and no way back to the
 * question.
 *
 * A password field, not a text field: the value is meant to be unseen, and
 * the browser must not offer to remember it. Nothing here keeps the value
 * after it has been sent — the request that carries it is the only copy
 * that exists on this side, and the component unmounts when the server says
 * the request is over.
 *
 * No autofocus, unlike the sheet it replaces: this appears while the reader
 * may be typing somewhere else, and a focus grab would send their next
 * keystrokes into a secret field. The sheet could autofocus because the
 * user had just opened it with the same gesture.
 */
export function EnvRequestCard({
  request,
  onProvide,
  onDecline,
}: EnvRequestCardProps) {
  const t = useT();
  const locale = useLocale();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState<null | "save" | "decline">(null);
  const [error, setError] = useState<string | null>(null);

  // One answer at a time: a second click while the first is in flight would
  // send the same answer twice. A failure keeps the card up with its
  // reason, so the user can retry (the value is still in the field).
  const submit = () => {
    if (busy !== null || value.trim().length === 0) return;
    setBusy("save");
    setError(null);
    onProvide(value, request.toolCallId)
      // The value has been handed over: drop it from this component so a
      // re-render (before the server's event removes the card) cannot show
      // it again.
      .then(() => setValue(""))
      .catch((failure) => setError(errorMessage(failure)))
      .finally(() => setBusy(null));
  };

  const decline = () => {
    if (busy !== null) return;
    setBusy("decline");
    setError(null);
    onDecline(request.toolCallId)
      .catch((failure) => setError(errorMessage(failure)))
      .finally(() => setBusy(null));
  };

  return (
    <form
      className="env-request-card"
      aria-label={t("chat.stella.env.title")}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <h3 className="env-request-title">{t("chat.stella.env.title")}</h3>
      <p className="env-request-text">
        {t("chat.stella.env.request", { name: request.name })}
      </p>
      {request.exists && (
        <p className="env-request-existing">{t("chat.stella.env.existing")}</p>
      )}
      {/* No visible caption: "値を入力" is the placeholder, and a line above
       * it saying "値" was a third name for the same thing. The accessible
       * name stays, without a row of its own. */}
      <input
        type="password"
        name="env-value"
        aria-label={t("chat.stella.env.value")}
        value={value}
        placeholder={t("chat.stella.env.placeholder")}
        autocomplete="off"
        autocapitalize="off"
        autocorrect="off"
        spellcheck={false}
        onInput={(event) => setValue(event.currentTarget.value)}
      />
      <p className="env-request-hint">{t("chat.stella.env.hint")}</p>
      <p className="env-request-deadline">
        {t("chat.stella.env.deadline", {
          time: formatClockTime(request.expiresAt, locale),
        })}
      </p>
      {error !== null && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <div className="env-request-actions">
        <button
          type="button"
          className="btn"
          disabled={busy !== null}
          onClick={decline}
        >
          {t("chat.stella.env.decline")}
        </button>
        <button
          type="submit"
          className="btn primary"
          disabled={busy !== null || value.trim().length === 0}
        >
          {busy === "save" ? t("chat.stella.env.saving") : t("common.save")}
        </button>
      </div>
    </form>
  );
}
