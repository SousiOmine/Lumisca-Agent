/** Slash-command menu for the composer, derived from the core agent-mode
 * registry (AGENT_MODES). Adding a mode in core automatically adds its
 * menu entry here; the icon map below only needs a line per new mode id
 * (unknown ids fall back to a generic icon).
 *
 * The menu is a palette, not a sender: picking an entry only edits the
 * composer text (see SlashCommand.kind). Text-taking modes (those with
 * `buildPromptForText`, e.g. plan mode) are completed to `/id ` and the
 * request typed after the token is wrapped into the mode prompt by the
 * submit path (slashPromptFromText) — wherever the token sits, so
 * `背景メモ /plan 履歴を追加` resolves like `/plan 履歴を追加`. */

import type { ReactNode } from "preact/compat";
import { AGENT_MODES, findAgentMode } from "@lumisca/core/modes";
import type { ModePrompt, SavedPrompt } from "@lumisca/core";
import {
  IconCode,
  IconFileDiff,
  IconGitBranch,
  IconGitCommit,
  IconListCheck,
  IconMessage,
  IconTarget,
} from "@tabler/icons-preact";

/** One selectable entry of the slash-command menu: a command (first level)
 * or one of its subcommands (second level). */
export interface SlashCommandItem {
  id: string;
  label: string;
  description?: string;
  icon?: (props: { size?: string | number; className?: string }) => ReactNode;
  /** Text this entry drops into the composer when picked (saved prompts).
   * Only read by `insert` commands. */
  insertText?: string;
}

/** What picking the command does with the composer text. */
export type SlashCommandKind =
  /** Complete the input to `/id ` and close the menu: the request is typed
   * after the token like normal text and wrapped into the mode prompt on
   * submit (`/plan`, `/goal`). */
  | "complete"
  /** Insert the picked entry's `insertText` at the command position,
   * keeping the text around it (saved prompts). */
  | "insert"
  /** Build the mode prompt from the selection and submit it. Only from the
   * start of the input — that prompt replaces the whole message, so a
   * command typed mid-text is left alone (mode palettes like `/review`). */
  | "run";

/** A slash command offered when `/` is typed at a word start. Commands with
 * `items` open a second level before executing; leaf commands execute
 * directly. */
export interface SlashCommand extends SlashCommandItem {
  /** Subcommands shown after selecting this command (e.g. the review
   * target). Omitted → the command executes right away. */
  items?: SlashCommandItem[];
  /** What picking the command does with the composer text. */
  kind: SlashCommandKind;
}

type Icon = (
  props: { size?: string | number; className?: string },
) => ReactNode;

/** Icons of known modes and their options, keyed by id. */
const MODE_ICONS: Record<string, Icon> = {
  review: IconFileDiff,
  "base-diff": IconGitBranch,
  uncommitted: IconGitCommit,
  plan: IconListCheck,
  goal: IconTarget,
};

const FALLBACK_ICON: Icon = IconCode;

/** The menu offered for `/` at a word start. A mode with
 * `buildPromptForText` is reusable anywhere in the input (`complete`); the
 * others are mode palettes that can only replace a whole message
 * (`run`). */
export const slashCommands: SlashCommand[] = AGENT_MODES.map((mode) => ({
  id: mode.id,
  label: mode.label,
  description: mode.description,
  icon: MODE_ICONS[mode.id] ?? FALLBACK_ICON,
  kind: mode.buildPromptForText === undefined ? "run" : "complete",
  items: mode.options.length > 0
    ? mode.options.map((option) => ({
      id: option.id,
      label: option.label,
      description: option.description,
      icon: MODE_ICONS[option.id] ?? FALLBACK_ICON,
    }))
    : undefined,
}));

/** Build the slash-commands menu including the /prompt submenu.
 * In chat mode only saved prompts are shown (agent modes need a workspace).
 * Shared between ChatView and NewSessionView so the logic is not duplicated. */
export function buildSlashCommands(
  savedPrompts: SavedPrompt[],
  isChat: boolean,
): SlashCommand[] {
  const promptItems: SlashCommandItem[] = savedPrompts.map((p) => ({
    id: p.id,
    label: p.label,
    description: p.prompt.slice(0, 80) + (p.prompt.length > 80 ? "…" : ""),
    insertText: p.prompt,
  }));
  if (isChat) {
    // Chat mode: only saved prompts, no agent modes.
    if (promptItems.length === 0) return [];
    return [{
      id: "prompt",
      label: "保存済みプロンプト",
      description: "保存したプロンプトテンプレートを挿入",
      icon: IconMessage,
      kind: "insert",
      items: promptItems,
    }];
  }
  // Workspace mode: agent modes + saved prompts.
  const commands = [...slashCommands];
  if (promptItems.length > 0) {
    commands.push({
      id: "prompt",
      label: "保存済みプロンプト",
      description: "保存したプロンプトテンプレートを挿入",
      icon: IconMessage,
      kind: "insert",
      items: promptItems,
    });
  }
  return commands;
}

/** Build the user message + mode metadata a slash-command selection sends;
 * null when the selection does not resolve to a registered mode (defensive
 * — the menu only lists registered ones). Text-taking modes take the user's
 * own text as their subject (buildPromptForText); the composer completes
 * those commands in place instead of picking them, so `text` only matters
 * for a caller that hands the request over directly. Without it nothing is
 * sent (null), so the user keeps typing the request. */
export function slashPrompt(
  command: SlashCommand,
  item?: SlashCommandItem,
  text = "",
): { text: string; mode: ModePrompt } | null {
  const mode = findAgentMode(command.id);
  if (!mode) return null;
  if (mode.buildPromptForText !== undefined) {
    const request = text.trim();
    if (request.length === 0) return null;
    return {
      text: mode.buildPromptForText(request),
      mode: {
        modeId: mode.id,
        optionId: "",
        modeLabel: mode.modeLabel,
        shortText: request,
      },
    };
  }
  const optionId = item !== undefined ? item.id : "";
  if (item !== undefined || mode.options.length === 0) {
    return {
      text: mode.buildPrompt(optionId),
      mode: {
        modeId: mode.id,
        optionId,
        modeLabel: mode.modeLabel,
        shortText: mode.buildShortText(optionId),
      },
    };
  }
  return null;
}

/** A text-taking command line parsed from composer text. */
export type TextCommandLine =
  | { kind: "wrap"; text: string; mode: ModePrompt }
  | { kind: "needs-text" };

/** The composer text to restore when rewinding a mode message (the undo
 * action on a user message): text-taking modes come back as their command
 * line (`/plan 依頼文`), so a re-send re-enters the mode; menu modes keep
 * their short text (as before — it is self-contained). */
export function modeRewindText(modeId: string, shortText: string): string {
  const mode = findAgentMode(modeId);
  return mode?.buildPromptForText !== undefined
    ? `/${modeId} ${shortText}`
    : shortText;
}

/** Resolve composer text that contains a text-taking command token
 * (`/plan 履歴機能を追加して`), used by the submit paths (send button,
 * Ctrl+Enter). The token may sit anywhere a word starts — `背景メモ /plan
 * 履歴を追加` wraps too — and the request is everything the user wrote
 * around it (the token removed, the two sides joined by a single space), so
 * no text is silently dropped. "needs-text" means the token is present but
 * the request is empty — nothing should be sent. Null when the text has no
 * text-taking command (a plain message, or a command without text support
 * such as review). */
export function slashPromptFromText(text: string): TextCommandLine | null {
  // Word-start token: `/` at the start of the input or after whitespace,
  // followed by the command name. The name stops at whitespace or another
  // `/`, so a path like `/usr/local/bin` is not read as a command — the
  // same boundary rule the slash menu detects with.
  const token = /(?:^|\s)\/([^\s/]+)/g;
  for (let m = token.exec(text); m !== null; m = token.exec(text)) {
    const name = m[1]!;
    const mode = findAgentMode(name);
    if (mode?.buildPromptForText === undefined) continue;
    const start = m.index + m[0].length - name.length - 1;
    const request = joinRequest(
      text.slice(0, start),
      text.slice(start + name.length + 1),
    );
    if (request.length === 0) return { kind: "needs-text" };
    return {
      kind: "wrap",
      text: mode.buildPromptForText(request),
      mode: {
        modeId: mode.id,
        optionId: "",
        modeLabel: mode.modeLabel,
        shortText: request,
      },
    };
  }
  return null;
}

/** Join the text written around a command token into the mode's subject:
 * each side trimmed, the two joined by a single space (the whitespace the
 * token was surrounded with is gone with it). Newlines inside a side are
 * kept as written. */
function joinRequest(before: string, after: string): string {
  const head = before.trim();
  const tail = after.trim();
  if (head.length === 0) return tail;
  if (tail.length === 0) return head;
  return `${head} ${tail}`;
}
