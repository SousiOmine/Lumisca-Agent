import {
  type Dispatch,
  type KeyboardEvent,
  type SetStateAction,
  useCallback,
  useState,
} from "preact/compat";
import type { SlashCommand, SlashCommandItem } from "../slashCommands.ts";

export type { SlashCommand, SlashCommandItem };

/** An active `/` command: the caret sits inside a command token started by
 * `/` (or, while a submenu is open, behind the token — see `rest`). The
 * command may sit anywhere a word starts, not only at the input's start. */
export interface SlashState {
  /** Index of the `/` character in the input. */
  start: number;
  /** Index right after the command token (`/plan` → start + 5). The token
   * covers `[start, end)`: the text a pick replaces. */
  end: number;
  /** Text from the `/` to the caret (the command name, filtered as it is
   * typed). */
  query: string;
  /** Text between the token and the caret while a submenu is open
   * (`/prompt test` → "test"), used as the subcommand filter. */
  rest: string;
  /** Active index in the currently shown list. */
  active: number;
  /** Command whose subcommands are shown (null = first level). */
  submenu: SlashCommand | null;
}

/** What `detectSlash` found: the token position and text of a match. */
interface SlashMatch {
  start: number;
  end: number;
  query: string;
  rest: string;
}

/** Whitespace between a command and the text around it. `\s` includes the
 * full-width space, so Japanese prose separates a command as expected. */
const SPACE = /\s/;

/** Find the `/command` token the caret points at. The `/` must start the
 * input or follow whitespace, so paths (`src/foo`) and URLs
 * (`https://example.com`) never open the menu — the palette is triggered
 * deliberately, like `@` mentions need a word start. The caret must also
 * sit inside the token: the menu is done as soon as the command is
 * followed by a space (it completes or inserts, it does not embed itself
 * into running text). Only while a submenu is open (allowRest) may the
 * caret sit behind the token: the text in between is that submenu's filter
 * (`/prompt test`).
 *
 * Exported for the unit tests; the hook wires it to typing and caret
 * moves. */
export function detectSlash(
  value: string,
  caret: number,
  allowRest: boolean,
): SlashMatch | null {
  const at = Math.min(Math.max(caret, 0), value.length);
  // The nearest token behind the caret wins (`/plan ... /re` detects
  // `/re`).
  for (let i = at - 1; i >= 0; i--) {
    if (value[i] !== "/") continue;
    const prev = value[i - 1];
    if (prev !== undefined && !SPACE.test(prev)) continue;
    // The command name ends at the first whitespace or `/`, so
    // `/usr/local/bin` is one token named `usr`, never a command.
    let end = i + 1;
    while (
      end < value.length && !SPACE.test(value[end]!) && value[end] !== "/"
    ) {
      end++;
    }
    if (at > end && !allowRest) return null;
    return {
      start: i,
      end,
      query: value.slice(i + 1, Math.min(at, end)),
      rest: at > end ? value.slice(end, at) : "",
    };
  }
  return null;
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
 * list; picking a leaf hands the choice to `onSelect`, which edits the
 * composer text (completion, insertion) or runs the mode. */
export function useSlashMenu(options: {
  enabled: boolean;
  commands: SlashCommand[];
  /** A leaf entry was picked (click, Enter or Tab). `state` is the palette
   * state the pick was made from — the `/command` token position and text —
   * so the caller can complete or insert at the right place. Text-taking
   * commands and saved prompts are applied to the text by the caller; mode
   * palettes are submitted by it. */
  onSelect?: (
    command: SlashCommand,
    item: SlashCommandItem | undefined,
    state: SlashState,
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
      // An open submenu keeps following the caret behind its token (the
      // filter text); everywhere else the caret must sit in the token.
      const allowRest = slash !== null && slash.submenu !== null;
      const det = enabled ? detectSlash(nextValue, caret, allowRest) : null;
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
            end: det.end,
            query: det.query,
            rest: det.rest,
            active: 0,
            submenu,
          };
        }

        if (
          prev && prev.start === det.start && prev.end === det.end &&
          prev.query === det.query && prev.rest === det.rest &&
          prev.submenu === null
        ) {
          return prev;
        }
        return {
          start: det.start,
          end: det.end,
          query: det.query,
          rest: det.rest,
          active: 0,
          submenu: null,
        };
      });
      return true;
    },
    [enabled, commands, slash],
  );

  const resetSlash = useCallback(() => {
    setSlash(null);
  }, []);

  /** Execute the entry at `index` of the current level, or descend into
   * it when it is a command with subcommands. Execution hands the
   * selection (with the token it was made from) to the parent
   * (onSelect), which edits the text or runs the mode. */
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
        onSelect?.(entry as SlashCommand, undefined, current);
      } else {
        onSelect?.(current.submenu, entry, current);
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
