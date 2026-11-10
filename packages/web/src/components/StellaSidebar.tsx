import { useClickOutside } from "../hooks/useClickOutside.ts";
import {
  IconDotsVertical,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconTrash,
} from "@tabler/icons-preact";
import { useEffect, useRef, useState } from "preact/compat";
import { api } from "../api.ts";
import { errorText } from "../providers.ts";
import { useLocale, useT } from "../i18n.ts";
import { formatRelativeTime } from "../format.ts";
import type {
  StellaAgent,
  StellaAgentSummary,
  StellaPreview,
} from "../types.ts";
import type { MessageKey, Translator } from "@lumisca/core/shared";
import { Modal } from "./Modal.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { Field } from "./Field.tsx";
import { AgentAvatar } from "./stella/AgentAvatar.tsx";
import { AgentEditDialog } from "./stella/AgentEditDialog.tsx";
import { useArrivals } from "../hooks/useArrivals.ts";

interface StellaSidebarProps {
  agents: StellaAgentSummary[];
  /** The first read of the list is in flight. `agents` is empty until it
   * lands, so this is what keeps the empty state ("no agent yet") from being
   * shown over a list that is on its way. Optional: a caller that has no
   * read of its own (or a test) simply never shows the wait. */
  loading?: boolean;
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

/** Where a row's menu is drawn, in viewport coordinates from the LEFT and
 * top edges. Fixed-position, because the list scrolls and an absolutely
 * placed menu would be clipped by it (the app menu is placed the same way).
 *
 * Left, not right: a right click near the left edge would push a
 * right-anchored menu off the screen, and the sidebar is the leftmost
 * surface in the app. The opening point is a preference, not the final
 * position — the menu is measured after it renders and clamped to the
 * viewport (see MENU_MARGIN). */
interface MenuAnchor {
  agent: StellaAgentSummary;
  /** Distance of the menu's left edge from the viewport's left edge. */
  x: number;
  /** Distance of the menu's top edge from the viewport's top edge. */
  top: number;
}

/** Gap the menu keeps from the viewport's edges, so a menu at the very edge
 * of the screen still reads as a floating surface (the tab menu uses the
 * same value). */
const MENU_MARGIN = 8;

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

/** The line a row shows under the name: the words that were said, or — for a
 * message that carried no words — what it carried. Kept beside the row that
 * draws it rather than in the shared module, because the shared module
 * decides WHAT the line is (see shared/stella-preview.ts) and this decides
 * how it reads in one language. */
function previewTextOf(
  preview: StellaPreview,
  t: Translator,
): string {
  switch (preview.kind) {
    case "text":
      return preview.text;
    case "files":
      return t("chat.stella.agents.preview.files", {
        count: preview.count,
      });
    case "card":
      return t("chat.stella.agents.preview.card");
    case "routine":
      return t("chat.stella.agents.preview.routine", { name: preview.name });
  }
}

/**
 * The list of agents, on the left.
 *
 * This is what stella has instead of a session list: not "conversations you
 * opened" but "who you can talk to". Each row is one agent, and each agent has
 * exactly one conversation that keeps growing — so there is no history to
 * browse, no titles to invent and no tabs to manage.
 *
 * Creating one starts from a wish, not a form: "what should it do for you?"
 * is the one answer this dialog needs, and it becomes the agent's role (the
 * instruction it works from). The name is optional — the server supplies one
 * when it is empty. Examples sit under the field for a user who cannot put
 * the job into words yet; a preset fills the field with a sentence the user
 * can edit, so nothing is decided behind their back.
 *
 * How they want it done is NOT asked here. The new agent asks that itself in
 * its first turn, once the conversation opens: it is the one that knows which
 * blanks its job leaves (see stella/onboarding.ts). The agent can also add
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
  {
    agents,
    loading = false,
    activeId,
    onSelect,
    onChanged,
    onAgentChanged,
    running,
  }: StellaSidebarProps,
) {
  const t = useT();
  const locale = useLocale();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<StellaAgentSummary | null>(null);
  /** The row whose menu is open, with where to draw it. */
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  /** The agent being edited (its name and picture), or null. */
  const [editing, setEditing] = useState<StellaAgentSummary | null>(null);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /** Where the menu is drawn, after it was measured (see MENU_MARGIN). Starts
   * at the point it was opened from and is corrected on the next frame. */
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  // Which rows just appeared (a new agent, or one the agent created itself).
  // Only those animate: the first paint of the list must not stage itself
  // (see hooks/useArrivals).
  const entering = useArrivals(agents.map((agent) => agent.id));

  // The menu belongs to the row, so it closes whenever the row is gone
  // (deleted, or replaced by the edited one).
  /** Keep the menu inside the window.
   *
   * The opening point is where the reader pointed, but a right click near the
   * left edge (the sidebar IS the left edge) would push a menu anchored to
   * that point partly off the screen, and a click near the bottom does the
   * same vertically. Measuring after render is the only honest way: the menu
   * sizes itself to its items and to the language (a long word in one
   * language changes its width), so no constant here would be right.
   *
   * Runs once per opening: `menu` is a fresh object each time it opens, and
   * the position it computes is not an input to it.
   */
  useEffect(() => {
    if (menu === null) {
      setPos(null);
      return;
    }
    const element = menuRef.current;
    if (element === null) return;
    const rect = element.getBoundingClientRect();
    setPos({
      x: Math.max(
        MENU_MARGIN,
        Math.min(menu.x, globalThis.innerWidth - rect.width - MENU_MARGIN),
      ),
      y: Math.max(
        MENU_MARGIN,
        Math.min(menu.top, globalThis.innerHeight - rect.height - MENU_MARGIN),
      ),
    });
  }, [menu]);

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

  const remove = async (agent: StellaAgentSummary) => {
    setDeleting(null);
    try {
      await api.deleteStellaAgent(agent.id);
      onChanged();
    } catch (failure) {
      setError(errorText(failure));
    }
  };

  /** Ask the agent to set itself up again, then show the conversation the
   * questions arrive in. A run already in flight refuses the restart (the
   * core will not steer setup text into that work), which is said rather
   * than swallowed: the click did something, and it did nothing visible. */
  const redoSetup = async (agent: StellaAgentSummary) => {
    setError(null);
    try {
      const { started } = await api.restartStellaOnboarding(agent.id);
      if (!started) {
        setError(t("chat.stella.agents.onboardingBusy"));
        return;
      }
      onSelect(agent.id);
    } catch (failure) {
      setError(errorText(failure));
    }
  };

  /** A preset starts a sentence; it does not replace one the user wrote.
   * Clicking two adds both, which is the honest reading of two clicks. */
  const applyPreset = (text: string) => {
    setRole((current) => {
      const trimmed = current.trim();
      return trimmed === "" ? text : `${trimmed}\n${text}`;
    });
  };

  /** Open a row's menu under its own ⋮ button. The position is read from the
   * button at click time: the list scrolls, so where the row is now is the
   * only useful answer (and a menu placed in CSS would be clipped by the
   * scrolling list it lives in). */
  const openMenu = (
    agent: StellaAgentSummary,
    button: HTMLButtonElement,
  ) => {
    if (menu?.agent.id === agent.id) {
      setMenu(null);
      return;
    }
    const rect = button.getBoundingClientRect();
    setMenu({
      agent,
      x: rect.left,
      top: rect.bottom + 4,
    });
  };

  /** The same menu from a right click on the row, at the pointer. A row's two
   * verbs (edit, delete) are the browser's context-menu verbs too, and a
   * right click is where a reader looks for them; the ⋮ button stays for
   * touch, where there is no right click. */
  const openMenuAt = (
    agent: StellaAgentSummary,
    event: MouseEvent,
  ) => {
    event.preventDefault();
    setMenu({
      agent,
      x: event.clientX,
      top: event.clientY,
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
        {
          /* An empty list and a list still being read look identical, and the
            empty state's advice ("create one") is wrong for half of them. */
        }
        {agents.length === 0 && loading && (
          <p className="stella-sidebar-empty" role="status">
            {t("common.loading")}
          </p>
        )}
        {agents.length === 0 && !loading && (
          <p className="stella-sidebar-empty">
            {t("chat.stella.agents.empty")}
          </p>
        )}
        {agents.map((agent) => (
          <div
            key={agent.id}
            className={`stella-agent${agent.id === activeId ? " active" : ""}`}
            data-enter={entering.has(agent.id) || undefined}
            onContextMenu={(event) => openMenuAt(agent, event)}
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
                {
                  /* The two facts a message app puts in a row: who, and when
                   * that conversation last said something. The time sits at
                   * the far edge of the name's line — scanned down the list,
                   * the column of times is what tells the reader which
                   * conversation is current, and it is the time of the
                   * MESSAGE, not of the last visit (a list that says "3分前"
                   * about something said last week is about the reader, not
                   * the conversation). */
                }
                <span className="stella-agent-head">
                  <span className="stella-agent-label">{agent.name}</span>
                  {agent.preview !== null && (
                    <time
                      className="stella-agent-time"
                      dateTime={new Date(agent.preview.at).toISOString()}
                    >
                      {formatRelativeTime(agent.preview.at, locale)}
                    </time>
                  )}
                </span>
                {
                  /* What was said last. It stays while the agent works: a
                   * row that replaced the message with "working" took away
                   * the one thing the reader was looking at, and the dot
                   * beside the row already says that work is happening. A
                   * fresh agent has said nothing, so its row is one line,
                   * exactly like a message app's row for someone you have
                   * not talked to yet. */
                }
                {agent.preview !== null && (
                  <span className="stella-agent-meta">
                    {previewTextOf(agent.preview, t)}
                  </span>
                )}
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
            // Drawn at the measured point. Until the measurement lands (the
            // frame this mounts), the menu stays invisible rather than
            // flashing at a position it is about to leave.
            top: pos?.y ?? menu.top,
            left: pos?.x ?? menu.x,
            visibility: pos === null ? "hidden" : "visible",
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
              const agent = menu.agent;
              setMenu(null);
              void redoSetup(agent);
            }}
          >
            <IconRefresh size={14} />
            <span>{t("chat.stella.agents.onboarding")}</span>
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
        <Modal onClose={resetForm} label={t("chat.stella.agents.new")}>
          <h2>{t("chat.stella.agents.new")}</h2>
          <Field label={t("chat.stella.agents.role")}>
            <textarea
              value={role}
              rows={4}
              placeholder={t("chat.stella.agents.roleHint")}
              onInput={(event) =>
                setRole(event.currentTarget.value)}
              autoFocus
            />
          </Field>
          {
            /* The same sentence the field holds, not a hidden prompt: a user
             * who cannot describe the job starts from one and edits it. */
          }
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
              onInput={(event) =>
                setName(event.currentTarget.value)}
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
              disabled={busy || role.trim() === ""}
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
        <ConfirmDialog
          title={t("chat.stella.agents.deleteTitle", { name: deleting.name })}
          body={t("chat.stella.agents.deleteBody")}
          confirmLabel={t("common.delete")}
          onConfirm={() => void remove(deleting)}
          onCancel={() => setDeleting(null)}
        />
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
