import type { MessageKey } from "@lumisca/core/shared";
import { useState } from "preact/compat";
import { api } from "../../api.ts";
import { useT } from "../../i18n.ts";
import { errorText } from "../../providers.ts";
import type { StellaAgent } from "../../types.ts";
import { Field } from "../Field.tsx";
import { Modal } from "../Modal.tsx";

/** The example jobs the create dialog offers.
 *
 * A preset fills the wish field with a full sentence the user can edit. It is
 * a head start for someone who does not know how to describe the job — not a
 * hidden prompt: the sentence IS the role, and it is readable before the
 * agent is created. */
const PRESETS: ReadonlyArray<{ label: MessageKey; text: MessageKey }> = [
  {
    label: "chat.stella.agents.preset.secretary",
    text: "chat.stella.agents.preset.secretaryText",
  },
  {
    label: "chat.stella.agents.preset.bookkeeping",
    text: "chat.stella.agents.preset.bookkeepingText",
  },
  {
    label: "chat.stella.agents.preset.research",
    text: "chat.stella.agents.preset.researchText",
  },
  {
    label: "chat.stella.agents.preset.travel",
    text: "chat.stella.agents.preset.travelText",
  },
];

export interface AgentCreateDialogProps {
  /** Called with the row the server answered, so the list holds the agent
   * before anything names it. */
  onCreated: (agent: StellaAgent) => void;
  onClose: () => void;
}

/**
 * Create an agent from a wish: "what should it do for you?" is the one answer
 * this dialog needs, and it becomes the agent's role (the instruction it
 * works from). The name is optional — the server supplies one when it is
 * empty.
 *
 * The examples sit under the field for a user who cannot put the job into
 * words yet; a preset fills the field with a sentence the user can edit, so
 * nothing is decided behind their back.
 *
 * How they want it done is NOT asked here. The new agent asks that itself in
 * its first turn, once its conversation opens (see stella/onboarding.ts).
 *
 * The dialog is its own component because the list has two ways in: the
 * button over the list at wide widths, and the one in the title bar at phone
 * widths, where the list and the conversation are one screen each.
 */
export function AgentCreateDialog({
  onCreated,
  onClose,
}: AgentCreateDialogProps) {
  const t = useT();
  const [role, setRole] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** A preset starts a sentence; it does not replace one the user wrote.
   * Clicking two adds both, which is the honest reading of two clicks. */
  const applyPreset = (text: string) => {
    setRole((current) => {
      const trimmed = current.trim();
      return trimmed === "" ? text : `${trimmed}\n${text}`;
    });
  };

  const create = async () => {
    // Both answers are optional: the server fills in a name and leaves the
    // role empty (the agent then works from the app's own instructions).
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const agent = await api.createStellaAgent(name, role);
      // The row goes into the list BEFORE the address names it. Selecting
      // first sent the reader to an agent the list had not read yet, and the
      // App treats an address naming an agent it cannot find as one that is
      // gone — it replaced the address with the list, so the dialog closed
      // and the screen did not move. The create's own answer carries the
      // row, so nothing has to be re-read to know it exists.
      onCreated(agent);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label={t("chat.stella.agents.new")}>
      <h2>{t("chat.stella.agents.new")}</h2>
      <Field label={t("chat.stella.agents.role")}>
        <textarea
          value={role}
          rows={4}
          placeholder={t("chat.stella.agents.roleHint")}
          onInput={(event) => setRole(event.currentTarget.value)}
          autoFocus
        />
      </Field>
      {/* The same sentence the field holds, not a hidden prompt: a user
       * who cannot describe the job starts from one and edits it. */}
      <div
        className="stella-presets"
        role="group"
        aria-label={t("chat.stella.agents.presets")}
      >
        {PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            className="stella-preset"
            onClick={() => applyPreset(t(preset.text))}
          >
            {t(preset.label)}
          </button>
        ))}
      </div>
      <Field label={t("chat.stella.agents.name")}>
        <input
          type="text"
          value={name}
          placeholder={t("chat.stella.agents.nameHint")}
          onInput={(event) => setName(event.currentTarget.value)}
        />
      </Field>
      {error !== null && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>
          {t("common.cancel")}
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={busy || role.trim() === ""}
          onClick={() => void create()}
        >
          {busy
            ? t("chat.stella.agents.creating")
            : t("chat.stella.agents.create")}
        </button>
      </div>
    </Modal>
  );
}
