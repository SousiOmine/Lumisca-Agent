import { useClickOutside } from "../hooks/useClickOutside.ts";
import {
  IconDotsVertical,
  IconPencil,
  IconPlus,
  IconTrash,
} from "@tabler/icons-preact";
import { useRef, useState } from "preact/compat";
import { api } from "../api.ts";
import { errorText } from "../providers.ts";
import { useLocale, useT } from "../i18n.ts";
import { formatRelativeTime } from "../format.ts";
import type { StellaAgent } from "../types.ts";
import { Modal } from "./Modal.tsx";
import { Field } from "./Field.tsx";
import { AgentAvatar } from "./stella/AgentAvatar.tsx";
import { AgentEditDialog } from "./stella/AgentEditDialog.tsx";
import { useArrivals } from "../hooks/useArrivals.ts";

interface StellaSidebarProps {
  agents: StellaAgent[];
  /** The agent whose conversation is showing; null before one exists. */
  activeId: string | null;
  onSelect: (id: string) => void;
  /** Called after a create / delete so the App re-reads the list. */
  onChanged: () => void;
  /** Called with the row the server answered after an edit, so the list
   * (and the conversation's header) redraw without a full re-read. */
  onAgentChanged: (agent: StellaAgent) => void;
  /** Whether the active agent's conversation is running, so its row can say
   * so (a message app's "typing" in a list). Only the active one is known:
   * the others have no open stream, and asking each would be a request per
   * row. */
  running: boolean;
}

/** Where a row's menu is drawn: under its ⋮ button, right-aligned to the
 * list. Fixed-position, because the list scrolls and an absolutely placed
 * menu would be clipped by it (the app menu is placed the same way). */
interface MenuAnchor {
  agent: StellaAgent;
  /** Distance from the viewport's right and top edges. */
  right: number;
  top: number;
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
 *
 * A row's ⋮ menu holds what can be done TO an agent — edit its name and
 * picture, delete it — apart from what the row itself does, which is open the
 * conversation. Deleting is not on the row: an always-visible × on every row
 * reads as "something to delete here", and it put a destructive control one
 * stray click from the thing the list exists for.
 */
export function StellaSidebar(
  { agents, activeId, onSelect, onChanged, onAgentChanged, running }:
    StellaSidebarProps,
) {
  const t = useT();
  const locale = useLocale();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<StellaAgent | null>(null);
  /** The row whose menu is open, with where to draw it. */
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  /** The agent being edited (its name and picture), or null. */
  const [editing, setEditing] = useState<StellaAgent | null>(null);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Which rows just appeared (a new agent, or one the agent created itself).
  // Only those animate: the first paint of the list must not stage itself
  // (see hooks/useArrivals).
  const entering = useArrivals(agents.map((agent) => agent.id));

  // The menu belongs to the row, so it closes whenever the row is gone
  // (deleted, or replaced by the edited one).
  useClickOutside(menuRef, () => setMenu(null), menu !== null, {
    onScroll: true,
  });

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

  /** Open a row's menu under its own ⋮ button. The position is read from the
   * button at click time: the list scrolls, so where the row is now is the
   * only useful answer (and a menu placed in CSS would be clipped by the
   * scrolling list it lives in). */
  const openMenu = (
    agent: StellaAgent,
    button: HTMLButtonElement,
  ) => {
    if (menu?.agent.id === agent.id) {
      setMenu(null);
      return;
    }
    const rect = button.getBoundingClientRect();
    setMenu({
      agent,
      right: globalThis.innerWidth - rect.right,
      top: rect.bottom + 4,
    });
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
            data-enter={entering.has(agent.id) || undefined}
          >
            {
              /* The picture is part of the row's name button, not a control of
                its own: the row's one action is "open this conversation", and
                what the agent is called or looks like belongs to the ⋮ menu
                beside it — not to a list the eye scans. */
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
              className="stella-agent-menu"
              onClick={(event) => openMenu(agent, event.currentTarget)}
              title={t("chat.stella.agents.menu", { name: agent.name })}
              aria-label={t("chat.stella.agents.menu", { name: agent.name })}
              aria-haspopup="menu"
              aria-expanded={menu?.agent.id === agent.id}
            >
              <IconDotsVertical size={14} />
            </button>
          </div>
        ))}
      </nav>
      {menu !== null && (
        <div
          className="app-menu"
          role="menu"
          ref={menuRef}
          style={{
            position: "fixed",
            top: menu.top,
            right: menu.right,
          }}
        >
          <button
            type="button"
            className="app-menu-item"
            role="menuitem"
            onClick={() => {
              setEditing(menu.agent);
              setMenu(null);
            }}
          >
            <IconPencil size={14} />
            <span>{t("common.edit")}</span>
          </button>
          <button
            type="button"
            className="app-menu-item"
            role="menuitem"
            onClick={() => {
              setDeleting(menu.agent);
              setMenu(null);
            }}
          >
            <IconTrash size={14} />
            <span>{t("common.delete")}</span>
          </button>
        </div>
      )}
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
      {editing !== null && (
        <AgentEditDialog
          agent={editing}
          onChanged={(agent) => {
            onAgentChanged(agent);
            setEditing(null);
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </aside>
  );
}
