import { errorMessage } from "@lumisca/core/shared";
import { useState } from "preact/compat";
import { formatClockTime } from "../../format.ts";
import { useLocale, useT } from "../../i18n.ts";
import type { StellaEnvRequest } from "../../types.ts";
import { Field } from "../Field.tsx";
import { Modal } from "../Modal.tsx";

interface EnvRequestDialogProps {
  /** The variable the run is waiting for. The name is all this dialog
   * knows: a value never arrives from the server. */
  request: StellaEnvRequest;
  /** Store the value. Rejects when the server did not take it (the wait
   * expired while the dialog was open); the dialog then shows the failure
   * and stays up so the text is not lost. */
  onProvide: (value: string, toolCallId: string) => Promise<void>;
  /** Refuse to enter a value. The run continues without it. */
  onDecline: (toolCallId: string) => Promise<void>;
}

/**
 * The `vm_env` dialog: the user types a secret the agent asked for.
 *
 * A password field, not a text field: the value is meant to be unseen, and
 * the browser must not offer to remember it. Nothing here keeps the value
 * after it has been sent — the request that carries it is the only copy
 * that exists on this side, and the component unmounts when the server says
 * the request is over.
 *
 * Closing the sheet (Escape, the backdrop) is a refusal, not a dismissal:
 * the run is blocked on this dialog, so there is no "later". The tool's
 * result tells the agent that the user declined, which is an answer. A
 * refusal that cannot be delivered is not shown: the sheet is already
 * leaving by then, and the request ends at its deadline.
 */
export function EnvRequestDialog({
  request,
  onProvide,
  onDecline,
}: EnvRequestDialogProps) {
  const t = useT();
  const locale = useLocale();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState<null | "save" | "decline">(null);
  const [error, setError] = useState<string | null>(null);

  // One answer at a time: a second click while the first is in flight would
  // send the same answer twice. A failure keeps the dialog up with its
  // reason, so the user can retry (the value is still in the field).
  const submit = () => {
    if (busy !== null || value.trim().length === 0) return;
    setBusy("save");
    setError(null);
    onProvide(value, request.toolCallId)
      // The value has been handed over: drop it from this component so a
      // re-render (before the server's event closes the dialog) cannot show
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
    <Modal
      label={t("chat.stella.env.title")}
      // The sheet is leaving, so a failed refusal has nowhere to be shown;
      // the request then ends at its deadline. See the class comment.
      onClose={() => void onDecline(request.toolCallId).catch(() => {})}
    >
      <form
        className="env-request-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <h2>{t("chat.stella.env.title")}</h2>
        <p className="confirm-body">
          {t("chat.stella.env.request", { name: request.name })}
        </p>
        {request.exists && (
          <p className="env-request-existing">
            {t("chat.stella.env.existing")}
          </p>
        )}
        <Field label={t("chat.stella.env.value")}>
          <input
            type="password"
            name="env-value"
            value={value}
            placeholder={t("chat.stella.env.placeholder")}
            autocomplete="off"
            autocapitalize="off"
            autocorrect="off"
            spellcheck={false}
            autoFocus
            onInput={(event) => setValue(event.currentTarget.value)}
          />
        </Field>
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
        <div className="modal-actions">
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            onClick={decline}
          >
            {t("common.cancel")}
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
    </Modal>
  );
}
