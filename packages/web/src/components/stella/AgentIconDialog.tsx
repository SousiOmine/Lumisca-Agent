import { useRef, useState } from "preact/compat";
import { api } from "../../api.ts";
import { useT } from "../../i18n.ts";
import { errorText } from "../../providers.ts";
import { AGENT_ICON_FORMATS, MAX_AGENT_ICON_BYTES } from "@lumisca/core/shared";
import type { StellaAgent } from "../../types.ts";
import { Modal } from "../Modal.tsx";
import { AgentAvatar } from "./AgentAvatar.tsx";

export interface AgentIconDialogProps {
  agent: StellaAgent;
  /** Called with the row the server answered (after an upload or a clear), so
   * the caller can put it back into its list without re-reading everything. */
  onChanged: (agent: StellaAgent) => void;
  onClose: () => void;
}

/** MB with one decimal. The cap is half a megabyte, so a user reads
 * "0.5 MB" rather than a six-digit byte count. */
function megabytes(bytes: number): string {
  const value = bytes / (1024 * 1024);
  return `${value < 10 ? Math.round(value * 10) / 10 : Math.round(value)} MB`;
}

/**
 * Pick the picture an agent is drawn with.
 *
 * A file input rather than a drag-and-drop zone: choosing a picture is a
 * once-per-agent action, and a drop target invites a drop the dialog cannot
 * accept at another moment. The input accepts only the formats the server
 * stores, and the dialog explains the two limits a browser cannot enforce
 * (the size cap and the format), so a refused upload arrives as a sentence
 * instead of as a silent non-change.
 *
 * The preview is the same component the sidebar and the header draw, at a
 * large size: what the user sees here is exactly what will be shown there.
 * "Back to the initial" is offered only when there is a picture to remove —
 * a control that does nothing is one more thing to read.
 */
export function AgentIconDialog(
  { agent, onChanged, onClose }: AgentIconDialogProps,
) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      // The same envelope the composer's images travel in: a data URL, which
      // the route strips back to base64. Read as text rather than as bytes so
      // the payload reaches the server in the shape every image endpoint
      // already takes.
      const data = await readAsDataUrl(file);
      const updated = await api.setStellaAgentIcon(agent.id, {
        data,
        mimeType: file.type,
      });
      onChanged(updated);
      onClose();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    setError(null);
    try {
      onChanged(await api.clearStellaAgentIcon(agent.id));
      onClose();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={busy ? () => {} : onClose}>
      <h2>{t("chat.stella.agents.icon.title", { name: agent.name })}</h2>
      <div className="agent-icon-preview">
        <AgentAvatar
          agentId={agent.id}
          name={agent.name}
          icon={agent.icon}
          size={72}
        />
      </div>
      <p className="agent-icon-hint">
        {t("chat.stella.agents.icon.hint", {
          formats: AGENT_ICON_FORMATS,
          size: megabytes(MAX_AGENT_ICON_BYTES),
        })}
      </p>
      {
        /* Hidden and triggered by the button below: a bare file input is a
          browser control with its own wording, and it cannot be styled to
          sit in this dialog. */
      }
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"
        className="agent-icon-input"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file !== undefined) void upload(file);
        }}
      />
      {error !== null && <p className="error-text" role="alert">{error}</p>}
      <div className="modal-actions">
        {agent.icon !== "" && (
          <button
            type="button"
            className="btn danger"
            disabled={busy}
            onClick={() => void clear()}
          >
            {t("chat.stella.agents.icon.reset")}
          </button>
        )}
        <button type="button" className="btn" disabled={busy} onClick={onClose}>
          {t("common.close")}
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy
            ? t("chat.stella.agents.icon.saving")
            : t("chat.stella.agents.icon.choose")}
        </button>
      </div>
    </Modal>
  );
}

/** Read a file as a data URL. Rejects with the reader's failure rather than
 * resolving to something the server would refuse. */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("Could not read the file"));
    reader.onerror = () =>
      reject(reader.error ?? new Error("Could not read the file"));
    reader.readAsDataURL(file);
  });
}
