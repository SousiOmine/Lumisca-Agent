import { IconPlus, IconX } from "@tabler/icons-preact";
import { useState } from "preact/compat";
import { api } from "../api.ts";
import { errorText } from "../providers.ts";
import { useT } from "../i18n.ts";
import type { StellaAgent } from "../types.ts";
import { Modal } from "./Modal.tsx";
import { Field } from "./Field.tsx";

interface StellaSidebarProps {
  agents: StellaAgent[];
  /** The agent whose conversation is showing; null before one exists. */
  activeId: string | null;
  onSelect: (id: string) => void;
  /** Called after a create / delete so the App re-reads the list. */
  onChanged: () => void;
}

/**
 * The list of counterparts, on the left.
 *
 * This is what stella has instead of a session list: not "conversations you
 * opened" but "who you can talk to". Each row is one agent, and each agent has
 * exactly one conversation that keeps growing — so there is no history to
 * browse, no titles to invent and no tabs to manage.
 *
 * Creating one is a two-field form (a name and what it is for) rather than a
 * chat with a wizard: the role is a sentence the user already knows. The agent
 * can also add counterparts itself with `agent_create`, in which case the row
 * appears here without this dialog ever opening.
 */
export function StellaSidebar(
  { agents, activeId, onSelect, onChanged }: StellaSidebarProps,
) {
  const t = useT();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<StellaAgent | null>(null);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetForm = () => {
    setCreating(false);
    setName("");
    setRole("");
    setError(null);
  };

  const create = async () => {
    if (name.trim() === "" || role.trim() === "" || busy) return;
    setBusy(true);
    setError(null);
    try {
      const agent = await api.createStellaAgent(name, role);
      onChanged();
      onSelect(agent.id);
      resetForm();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (agent: StellaAgent) => {
    setDeleting(null);
    try {
      await api.deleteStellaAgent(agent.id);
      onChanged();
    } catch (failure) {
      setError(errorText(failure));
    }
  };

  return (
    <aside className="stella-sidebar">
      <div className="stella-sidebar-header">
        <span>{t("chat.stella.agents.title")}</span>
        <button
          type="button"
          className="icon-btn"
          onClick={() => setCreating(true)}
          title={t("chat.stella.agents.new")}
          aria-label={t("chat.stella.agents.new")}
        >
          <IconPlus size={15} />
        </button>
      </div>
      <nav className="stella-sidebar-list">
        {agents.length === 0 && (
          <p className="stella-sidebar-empty">
            {t("chat.stella.agents.empty")}
          </p>
        )}
        {agents.map((agent) => (
          <div
            key={agent.id}
            className={`stella-agent${agent.id === activeId ? " active" : ""}`}
          >
            <button
              type="button"
              className="stella-agent-name"
              onClick={() => onSelect(agent.id)}
            >
              {agent.name}
            </button>
            <button
              type="button"
              className="stella-agent-delete"
              onClick={() => setDeleting(agent)}
              title={t("chat.stella.agents.delete")}
              aria-label={t("chat.stella.agents.delete")}
            >
              <IconX size={12} />
            </button>
          </div>
        ))}
      </nav>
      {error !== null && (
        <p className="error-text stella-sidebar-error" role="alert">{error}</p>
      )}
      {creating && (
        <Modal onClose={resetForm}>
          <h2>{t("chat.stella.agents.new")}</h2>
          <Field label={t("chat.stella.agents.name")}>
            <input
              type="text"
              value={name}
              onInput={(event) => setName(event.currentTarget.value)}
              autoFocus
            />
          </Field>
          <Field label={t("chat.stella.agents.role")}>
            <textarea
              value={role}
              rows={4}
              placeholder={t("chat.stella.agents.roleHint")}
              onInput={(event) => setRole(event.currentTarget.value)}
            />
          </Field>
          {error !== null && <p className="error-text" role="alert">{error}</p>}
          <div className="modal-actions">
            <button type="button" className="btn" onClick={resetForm}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={busy || name.trim() === "" || role.trim() === ""}
              onClick={() => void create()}
            >
              {busy
                ? t("chat.stella.agents.creating")
                : t("chat.stella.agents.create")}
            </button>
          </div>
        </Modal>
      )}
      {deleting !== null && (
        <Modal onClose={() => setDeleting(null)}>
          <h2>
            {t("chat.stella.agents.deleteTitle", { name: deleting.name })}
          </h2>
          <p className="confirm-body">{t("chat.stella.agents.deleteBody")}</p>
          <div className="modal-actions">
            <button
              type="button"
              className="btn"
              onClick={() => setDeleting(null)}
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="btn danger"
              onClick={() => void remove(deleting)}
            >
              {t("common.delete")}
            </button>
          </div>
        </Modal>
      )}
    </aside>
  );
}
