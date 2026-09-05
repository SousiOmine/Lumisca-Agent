import {
  type ComponentType,
  type Dispatch,
  type KeyboardEvent,
  type SetStateAction,
  useCallback,
  useState,
} from "react";

/** One selectable entry of the slash-command menu: a command (first level)
 * or one of its subcommands (second level). */
export interface SlashCommandItem {
  id: string;
  label: string;
  description?: string;
  icon?: ComponentType<{ size?: number; className?: string }>;
}

/** A slash command offered when the input starts with `/`. Commands with
 * `items` open a second level before executing; leaf commands execute
 * directly. */
export interface SlashCommand extends SlashCommandItem {
  /** Subcommands shown after selecting this command (e.g. the review
   * target). Omitted → the command executes right away. */
  items?: SlashCommandItem[];
  /** The command takes the user's own text as its subject: the text typed
   * after the command token (`/plan <依頼文>`) is handed to onSelect so the
   * parent can wrap it into the mode prompt. When set, the menu hints to
   * type the request while it is still missing. */
  requiresText?: boolean;
}

/** An active `/` command: the caret is inside a query started by `/`. */
export interface SlashState {
  /** Index of the `/` character in the input. */
  start: number;
  query: string;
  /** Text typed after the command token (`/plan 履歴機能を追加して` →
   * "履歴機能を追加して"). Empty for a bare `/command`. */
  rest: string;
  /** Active index in the currently shown list. */
  active: number;
  /** Command whose subcommands are shown (null = first level). */
  submenu: SlashCommand | null;
}

/** Find a `/command` under the caret. The `/` must start the input (only
 * whitespace before it): a slash command replaces the whole message, so it
 * never triggers mid-text (typing `/` in prose stays literal). The text
 * after the command token (`/plan 依頼文`) is captured as `rest` — text-
 * taking commands (e.g. plan mode) use it as their subject. */
function detectSlash(
  value: string,
  caret: number,
): { start: number; query: string; rest: string } | null {
  const before = value.slice(0, caret);
  const match = /^(\s*)\/([^\s]*)(?:\s+([\s\S]*))?$/.exec(before);
  if (!match || match[1] === undefined) return null;
  return {
    start: match[1].length,
    query: match[2] ?? "",
    rest: match[3] ?? "",
  };
}

/** Commands matching the typed query (empty query → all). Matches the id or
 * the label, so both `/rev` and `/レビュー` work. */
function filterSlashCommands(
  commands: SlashCommand[],
  query: string,
): SlashCommand[] {
  if (query === "") return commands;
  const q = query.toLowerCase();
  return commands.filter((command) =>
    command.id.toLowerCase().includes(q) ||
    command.label.toLowerCase().includes(q)
  );
}

/** Items matching the typed query (empty query → all). Used for the second
 * level (e.g. saved prompts inside /prompt). */
function filterSlashItems(
  items: SlashCommandItem[],
  query: string,
): SlashCommandItem[] {
  if (query.trim() === "") return items;
  const q = query.trim().toLowerCase();
  return items.filter((item) =>
    item.id.toLowerCase().includes(q) ||
    item.label.toLowerCase().includes(q)
  );
}

/** Narrowing helper: entries of the first level are commands. */
export function isSlashCommand(
  entry: SlashCommand | SlashCommandItem,
): entry is SlashCommand {
  return "items" in entry;
}

/** Two-level slash-command menu state machine (a mode palette): detection
 * under the caret, query filtering, submenu navigation and keyboard
 * handling. The menu is generic — every caller passes its own command
 * list; selecting a leaf hands the choice to `onSelect`, which builds the
 * actual prompt and submits it. */
export function useSlashMenu(options: {
  enabled: boolean;
  commands: SlashCommand[];
  /** Handed the selection plus the text typed after the command token
   * (`/plan 依頼文` → "依頼文"; empty for a bare `/command`). Text-taking
   * commands (requiresText) use it as their subject; the others ignore
   * it. */
  onSelect?: (
    command: SlashCommand,
    item?: SlashCommandItem,
    text?: string,
  ) => void;
}): {
  slash: SlashState | null;
  setSlash: Dispatch<SetStateAction<SlashState | null>>;
  /** Entries shown right now: query-filtered commands at the first level,
   * the subcommand list inside a submenu. */
  slashEntries: SlashCommandItem[];
  /** Re-evaluate the command under the caret after typing or caret moves.
   * Returns true when a command is now active. */
  updateSlash: (nextValue: string, caret: number) => boolean;
  /** Close the menu. */
  resetSlash: () => void;
  /** Execute the entry at `index` of the current level, or descend into
   * it when it is a command with subcommands. */
  selectSlash: (index: number) => void;
  /** Keyboard navigation for an open menu; true when the key was consumed
   * by the menu. */
  handleKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
} {
  const { enabled, commands, onSelect } = options;
  const [slash, setSlash] = useState<SlashState | null>(null);

  /** Entries shown in the slash menu right now: query-filtered commands at
   * the first level, the subcommand list (filtered by the text after the
   * command when present) inside a submenu. */
  const slashEntries: SlashCommandItem[] = slash !== null
    ? slash.submenu !== null
      ? filterSlashItems(slash.submenu.items ?? [], slash.rest)
      : filterSlashCommands(commands, slash.query)
    : [];

  const updateSlash = useCallback(
    (nextValue: string, caret: number): boolean => {
      const det = enabled ? detectSlash(nextValue, caret) : null;
      if (!det) return false;
      setSlash((prev) => {
        // Keep the submenu open while the user types the filter text
        // after the command (e.g. `/prompt test` filters the prompt list
        // by "test" instead of closing the submenu).
        if (
          prev !== null && prev.submenu !== null &&
          prev.start === det.start &&
          prev.query.toLowerCase() === det.query.toLowerCase() &&
          prev.submenu.id.toLowerCase() === det.query.toLowerCase()
        ) {
          if (prev.rest === det.rest) return prev;
          return { ...prev, rest: det.rest, active: 0 };
        }

        // Auto-open the submenu when the query exactly matches a single
        // command that has subcommands (e.g. typing `/prompt` or
        // `/prompt ` immediately shows the saved prompts).
        const filtered = filterSlashCommands(commands, det.query);
        const first = filtered[0];
        const exact = filtered.length === 1 && first !== undefined &&
          (first.items?.length ?? 0) > 0 &&
          first.id.toLowerCase() === det.query.toLowerCase();
        if (exact && first !== undefined) {
          const submenu: SlashCommand = first;
          if (
            prev !== null && prev.submenu?.id === submenu.id &&
            prev.start === det.start && prev.query === det.query &&
            prev.rest === det.rest
          ) {
            return prev;
          }
          return {
            start: det.start,
            query: det.query,
            rest: det.rest,
            active: 0,
            submenu,
          };
        }

        if (
          prev && prev.start === det.start && prev.query === det.query &&
          prev.rest === det.rest && prev.submenu === null
        ) {
          return prev;
        }
        return {
          start: det.start,
          query: det.query,
          rest: det.rest,
          active: 0,
          submenu: null,
        };
      });
      return true;
    },
    [enabled, commands],
  );

  const resetSlash = useCallback(() => {
    setSlash(null);
  }, []);

  /** Execute the entry at `index` of the current level, or descend into
   * it when it is a command with subcommands. Execution hands the
   * selection to the parent (onSelect), which builds the prompt and
   * submits it. */
  const selectSlash = useCallback(
    (index: number) => {
      const current = slash;
      const entry = slashEntries[index];
      if (!current || !entry) return;
      if (
        current.submenu === null && isSlashCommand(entry) &&
        (entry.items?.length ?? 0) > 0
      ) {
        setSlash({ ...current, submenu: entry, active: 0 });
        return;
      }
      setSlash(null);
      if (current.submenu === null) {
        onSelect?.(entry as SlashCommand, undefined, current.rest);
      } else {
        onSelect?.(current.submenu, entry, current.rest);
      }
    },
    [slash, slashEntries, onSelect],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!slash) return false;
      if (e.key === "ArrowDown" && slashEntries.length > 0) {
        e.preventDefault();
        setSlash({
          ...slash,
          active: (slash.active + 1) % slashEntries.length,
        });
        return true;
      }
      if (e.key === "ArrowUp" && slashEntries.length > 0) {
        e.preventDefault();
        setSlash({
          ...slash,
          active: (slash.active - 1 + slashEntries.length) %
            slashEntries.length,
        });
        return true;
      }
      // → opens the submenu of the active command; ← returns from a
      // submenu to the first level.
      if (e.key === "ArrowRight" && slash.submenu === null) {
        const entry = slashEntries[slash.active];
        if (entry && isSlashCommand(entry) && (entry.items?.length ?? 0) > 0) {
          e.preventDefault();
          setSlash({ ...slash, submenu: entry, active: 0 });
          return true;
        }
      }
      if (e.key === "ArrowLeft" && slash.submenu !== null) {
        e.preventDefault();
        setSlash({ ...slash, submenu: null, active: 0 });
        return true;
      }
      if ((e.key === "Enter" || e.key === "Tab") && slashEntries.length > 0) {
        e.preventDefault();
        selectSlash(slash.active);
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        if (slash.submenu !== null) {
          setSlash({ ...slash, submenu: null, active: 0 });
        } else {
          setSlash(null);
        }
        return true;
      }
      return false;
    },
    [slash, slashEntries, selectSlash],
  );

  return {
    slash,
    setSlash,
    slashEntries,
    updateSlash,
    resetSlash,
    selectSlash,
    handleKeyDown,
  };
}
