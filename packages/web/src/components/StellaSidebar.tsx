import { IconPlus, IconX } from "@tabler/icons-preact";
import { useState } from "preact/compat";
import { api } from "../api.ts";
import { errorText } from "../providers.ts";
import { useLocale, useT } from "../i18n.ts";
import { formatRelativeTime } from "../format.ts";
import type { StellaAgent } from "../types.ts";
import { Modal } from "./Modal.tsx";
import { Field } from "./Field.tsx";
import { AgentAvatar } from "./stella/AgentAvatar.tsx";

interface StellaSidebarProps {
  agents: StellaAgent[];
  /** The agent whose conversation is showing; null before one exists. */
  activeId: string | null;
  onSelect: (id: string) => void;
  /** Called after a create / delete so the App re-reads the list. */
  onChanged: () => void;
  /** Whether the active agent's conversation is running, so its row can say
   * so (a message app's "typing" in a list). Only the active one is known:
   * the others have no open stream, and asking each would be a request per
   * row. */
  running: boolean;
}

/**
 * The list of agents, on the left.
 *
 * This is what stella has instead of a session list: not "conversations you
 * opened" but "who you can talk to". Each row is one agent, and each agent has
 * exactly one conversation that keeps growing — so there is no history to
 * browse, no titles to invent and no tabs to manage.
 *
 * Creating one is a two-field form (a name and what it is for) rather than a
 * chat with a wizard: the role is a sentence the user already knows. Both
 * fields are optional — an agent can be made first and described later, or
 * never — so "Create" is enabled from the start; the server supplies the name
 * and leaves the role empty (see normalizeAgentInput). The agent can also add
 * agents itself with `agent_create`, in which case the row appears here
 * without this dialog ever opening.
 */
export function StellaSidebar(
  { agents, activeId, onSelect, onChanged, running }: StellaSidebarProps,
) {
  const t = useT();
  const locale = useLocale();
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
    // Both answers are optional: the server fills in a name and leaves the
    // role empty (the agent then works from the app's own instructions).
    if (busy) return;
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
            {
              /* The picture is part of the row's name button, not a control of
                its own: the row's one action is "open this conversation", and
                changing the picture belongs to the conversation (its header),
                not to a list the eye scans. */
            }
            <button
              type="button"
              className="stella-agent-name"
              onClick={() => onSelect(agent.id)}
            >
              <AgentAvatar
                agentId={agent.id}
                name={agent.name}
                icon={agent.icon}
                size={32}
              />
              <span className="stella-agent-text">
                <span className="stella-agent-label">{agent.name}</span>
                {
                  /* The same two facts a message app puts under a name: what
                   * was said last (here: that this conversation is where the
                   * work happens) and when. Which is the second line's
                   * business — the name stays the only thing that is large. */
                }
                <span className="stella-agent-meta">
                  {agent.id === activeId && running
                    ? (
                      <span className="stella-agent-activity">
                        {t("chat.stella.working")}
                      </span>
                    )
                    : (
                      <span className="stella-agent-time">
                        {formatRelativeTime(agent.updatedAt, locale)}
                      </span>
                    )}
                </span>
              </span>
              {
                /* A dot on the agent that is working right now, so the list
                 * answers "is anything happening?" without opening each
                 * conversation. It repeats what the second line says
                 * because the line is text and the dot is what the eye
                 * catches while scanning. */
              }
              {agent.id === activeId && running && (
                <span className="stella-agent-dot" aria-hidden="true" />
              )}
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
              placeholder={t("chat.stella.agents.nameHint")}
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
              disabled={busy}
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
