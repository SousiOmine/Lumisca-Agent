import type { Translator } from "@lumisca/core/shared";
import {
  IconPencil,
  IconPlus,
  IconRefresh,
  IconRepeat,
  IconTrash,
} from "@tabler/icons-preact";
import { useEffect, useRef, useState } from "preact/compat";
import { api } from "../api.ts";
import { formatRelativeTime } from "../format.ts";
import { useArrivals } from "../hooks/useArrivals.ts";
import { useClickOutside } from "../hooks/useClickOutside.ts";
import { useCompactViewport } from "../hooks/useMediaQuery.ts";
import { useLocale, useT } from "../i18n.ts";
import { errorText } from "../providers.ts";
import type {
  StellaAgent,
  StellaAgentSummary,
  StellaPreview,
} from "../types.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { AgentAvatar } from "./stella/AgentAvatar.tsx";
import { AgentEditDialog } from "./stella/AgentEditDialog.tsx";
import { AgentRoutinesDialog } from "./stella/AgentRoutinesDialog.tsx";

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
  /** Called after a delete so the App re-reads the list. A create does not
   * need it: its answer carries the row the list is missing (see `create`). */
  onChanged: () => void;
  /** Called with the row the server answered after an edit or a create, so
   * the list (and the conversation's header) redraw without a full re-read. */
  onAgentChanged: (agent: StellaAgent) => void;
  /** Open the create dialog. The list has two ways in (this row over the list
   * at wide widths, the title bar at phone widths), so the dialog itself is
   * the App's, not this component's. */
  onNewAgent: () => void;
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

/** How long a fingertip stays down before the row's menu opens. Shorter is a
 * tap, and a tap opens the conversation; the platforms' own long press is
 * about half a second, so this is the same gesture the reader knows. */
const LONG_PRESS_MS = 500;

/** How far a finger may travel during that wait and still be the same press.
 * A finger that moves is scrolling the list, not holding the row. */
const LONG_PRESS_SLOP_PX = 10;

/** The line a row shows under the name: the words that were said, or — for a
 * message that carried no words — what it carried. Kept beside the row that
 * draws it rather than in the shared module, because the shared module
 * decides WHAT the line is (see shared/stella-preview.ts) and this decides
 * how it reads in one language. */
function previewTextOf(preview: StellaPreview, t: Translator): string {
  switch (preview.kind) {
    case "text":
      return preview.text;
    case "files":
      return t("chat.stella.agents.preview.files", {
        count: preview.count,
      });
    case "card":
      return t("chat.stella.agents.preview.card");
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
 * Creating one starts from a wish, not a form (AgentCreateDialog): "what
 * should it do for you?" is the one answer that dialog needs, and it becomes
 * the agent's role (the instruction it works from). The dialog's two ways
 * in are the button over the list at wide widths and the title bar's at phone
 * widths, where this list is a screen of its own and the row above it is the
 * only place for a control.
 *
 * How they want it done is NOT asked here. The new agent asks that itself in
 * its first turn, once the conversation opens: it is the one that knows which
 * blanks its job leaves (see stella/onboarding.ts). The agent can also add
 * agents itself with `agent_create`, in which case the row appears here
 * without this dialog ever opening.
 *
 * A row's menu holds what can be done TO an agent — edit its name, picture and
 * model, see its routines, ask it to set itself up again, delete it — apart
 * from what the row itself does, which is open the conversation. Routines are
 * here rather than in the settings dialog because they belong to one agent,
 * and this is where the reader names that agent without opening anything.
 * Deleting is not on the row: an always-visible × on every row reads as
 * "something to delete here", and it put a destructive control one stray
 * click from the thing the list exists for.
 */
export function StellaSidebar({
  agents,
  loading = false,
  activeId,
  onSelect,
  onChanged,
  onAgentChanged,
  onNewAgent,
}: StellaSidebarProps) {
  const t = useT();
  const locale = useLocale();
  /** At phone widths the title bar carries the create button (the list and
   * the conversation are one screen each, so the button belongs in the one
   * row above the list), and this header would be a second one under it. */
  const compact = useCompactViewport();
  const [deleting, setDeleting] = useState<StellaAgentSummary | null>(null);
  /** The row whose menu is open, with where to draw it. */
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  /** The agent being edited (its name and picture), or null. */
  const [editing, setEditing] = useState<StellaAgentSummary | null>(null);
  /** The agent whose routines are showing, or null. Routines belong to one
   * agent, so they open from that agent's row and never from the settings
   * dialog, which holds the installation's settings. */
  const [routinesFor, setRoutinesFor] = useState<StellaAgentSummary | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /** The press a fingertip is holding, while it is still a candidate for the
   * long press: whose row it is, where it went down, and the timer. */
  const press = useRef<{
    agent: StellaAgentSummary;
    x: number;
    y: number;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  /** Set when a long press opened the menu. The click a lifting finger still
   * sends is the end of that press, not a second act, and must not open the
   * conversation under the menu. */
  const pressOpenedMenu = useRef(false);
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

  // A finger can still be down when the list goes away (the reader opens an
  // agent, the panel unmounts): the timer must not open a menu for a row
  // that is no longer drawn.
  useEffect(
    () => () => {
      const current = press.current;
      if (current !== null) clearTimeout(current.timer);
    },
    [],
  );

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

  /** Open a row's menu along the row itself. This is where a keyboard's menu
   * key lands (Shift+F10 too): it has no pointer of its own, and the row's
   * left edge under the name is the place the reader is looking at. */
  const openMenuOnRow = (agent: StellaAgentSummary, row: HTMLElement) => {
    const rect = row.getBoundingClientRect();
    setMenu({ agent, x: rect.left + 8, top: rect.bottom });
  };

  /** The menu from a right click on the row, at the pointer. The row's verbs
   * (edit, routines, delete) are the browser's context-menu verbs too, and a
   * right click is where a reader looks for them. */
  const openMenuAt = (agent: StellaAgentSummary, event: MouseEvent) => {
    event.preventDefault();
    // A keyboard's menu key arrives as this event with no pointer: both
    // coordinates are 0, which is the window's corner. The row answers
    // instead, the same as Shift+F10 (see onKeyDown below).
    if (event.clientX === 0 && event.clientY === 0) {
      const row = event.currentTarget;
      if (row instanceof HTMLElement) openMenuOnRow(agent, row);
      return;
    }
    setMenu({ agent, x: event.clientX, top: event.clientY });
  };

  /** Stop watching a press: its finger lifted, was cancelled, or moved far
   * enough to be scrolling. */
  const endPress = () => {
    const current = press.current;
    if (current !== null) clearTimeout(current.timer);
    press.current = null;
  };

  /** A fingertip has no right click, so the row's menu opens on a held press
   * — the same menu, at the same point, on the input a phone has. A mouse is
   * not watched: its right click already does this, and watching every click
   * would put a timer under the pointer's normal use. */
  const startPress = (agent: StellaAgentSummary, event: PointerEvent) => {
    // A press that is not followed by a swallowed click (a finger cancelled
    // before it lifted) must not eat the next one.
    pressOpenedMenu.current = false;
    if (event.pointerType === "mouse") return;
    endPress();
    const x = event.clientX;
    const y = event.clientY;
    const timer = setTimeout(() => {
      press.current = null;
      pressOpenedMenu.current = true;
      setMenu({ agent, x, top: y });
    }, LONG_PRESS_MS);
    press.current = { agent, x, y, timer };
  };

  const movePress = (event: PointerEvent) => {
    const current = press.current;
    if (current === null) return;
    if (
      Math.abs(event.clientX - current.x) > LONG_PRESS_SLOP_PX ||
      Math.abs(event.clientY - current.y) > LONG_PRESS_SLOP_PX
    )
      endPress();
  };

  /** The click that ends a long press: swallow it so the conversation does
   * not open underneath the menu the press just opened. */
  const swallowPressClick = (event: MouseEvent) => {
    if (!pressOpenedMenu.current) return;
    pressOpenedMenu.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <aside className="stella-sidebar">
      {/* The list's one control, on the row above the list — the same row the
       * title bar's create button takes at phone widths, so only one of them
       * is drawn at a time. */}
      {!compact && (
        <div className="stella-sidebar-header">
          <button
            type="button"
            className="icon-btn"
            onClick={onNewAgent}
            title={t("chat.stella.agents.new")}
            aria-label={t("chat.stella.agents.new")}
          >
            <IconPlus size={15} />
          </button>
        </div>
      )}
      <nav className="stella-sidebar-list">
        {/* An empty list and a list still being read look identical, and the
            empty state's advice ("create one") is wrong for half of them. */}
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
            onPointerDown={(event) => startPress(agent, event)}
            onPointerMove={movePress}
            onPointerUp={endPress}
            onPointerCancel={endPress}
            onPointerLeave={endPress}
            onClickCapture={swallowPressClick}
            onKeyDown={(event) => {
              // The browser's own context-menu keys. The menu is a popover
              // now, not a button on the row, so this is how a keyboard
              // reaches it.
              if (
                event.key === "ContextMenu" ||
                (event.shiftKey && event.key === "F10")
              ) {
                event.preventDefault();
                openMenuOnRow(agent, event.currentTarget);
              }
            }}
          >
            {/* The picture is part of the row's name button, not a control of
                its own: the row's one action is "open this conversation", and
                what the agent is called or looks like belongs to the ⋮ menu
                beside it — not to a list the eye scans. */}
            <button
              type="button"
              className="stella-agent-name"
              onClick={() => onSelect(agent.id)}
            >
              <AgentAvatar
                agentId={agent.id}
                name={agent.name}
                icon={agent.icon}
                size={40}
              />
              <span className="stella-agent-text">
                {/* The two facts a message app puts in a row: who, and when
                 * that conversation last said something. The time sits at
                 * the far edge of the name's line — scanned down the list,
                 * the column of times is what tells the reader which
                 * conversation is current, and it is the time of the
                 * MESSAGE, not of the last visit (a list that says "3分前"
                 * about something said last week is about the reader, not
                 * the conversation). */}
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
                {/* What was said last. It stays while the agent works: a
                 * row that replaced the message with "working" took away
                 * the one thing the reader was looking at. A fresh agent
                 * has said nothing, so its row is one line, exactly like a
                 * message app's row for someone you have not talked to
                 * yet. */}
                {agent.preview !== null && (
                  <span className="stella-agent-meta">
                    {previewTextOf(agent.preview, t)}
                  </span>
                )}
              </span>
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
              setRoutinesFor(menu.agent);
              setMenu(null);
            }}
          >
            <IconRepeat size={14} />
            <span>{t("chat.stella.agents.routines")}</span>
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
        <p className="error-text stella-sidebar-error" role="alert">
          {error}
        </p>
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
      {routinesFor !== null && (
        <AgentRoutinesDialog
          agent={routinesFor}
          onClose={() => setRoutinesFor(null)}
        />
      )}
    </aside>
  );
}
