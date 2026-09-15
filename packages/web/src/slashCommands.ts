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
 * `背景メモ /plan 履歴を追加` resolves like `/plan 履歴を追加`.
 *
 * The skill palette is the dynamic source of the same shape: `/skill` lists
 * the session's skill catalog (fetched per workspace, see useSkills) and
 * completes to `/skill <name> `, which skillPromptFromText turns into the
 * skill prompt on submit.
 *
 * EVERY string this module renders comes from the catalogue through the
 * `t` the caller passes in: the mode labels are catalogue keys (core/modes
 * holds no text), and passing the translator keeps the menu's memos — its
 * callers rebuild the list with `useMemo` — tied to the app language. The
 * PROMPTS the modes send are uniformly English on purpose (see
 * core/modes/mod.ts). */

import type { ReactNode } from "preact/compat";
import { buildSkillPrompt } from "@lumisca/core/skills/slash";
import { AGENT_MODES, findAgentMode } from "@lumisca/core/modes";
import type { ModePrompt, SavedPrompt } from "@lumisca/core";
import type { Translator } from "@lumisca/core/shared";
import type { SkillInfo } from "./types.ts";
import {
  IconArrowsMinimize,
  IconCode,
  IconFileDiff,
  IconGitBranch,
  IconGitCommit,
  IconListCheck,
  IconMessage,
  IconSparkles,
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
  /** Complete the input and close the menu: the request is typed after the
   * token like normal text and wrapped into the command's prompt on submit
   * (`/plan`, `/goal`). A command with `items` completes to
   * `/id <picked item> ` instead: the item id is the command's argument
   * (the skill palette's `/skill <name> `, see slashCompletion). */
  | "complete"
  /** Insert the picked entry's `insertText` at the command position,
   * keeping the text around it (saved prompts). */
  | "insert"
  /** Build the mode prompt from the selection and submit it. Only from the
   * start of the input — that prompt replaces the whole message, so a
   * command typed mid-text is left alone (mode palettes like `/review`). */
  | "run"
  /** Run a client-side action instead of sending a prompt (`/compact`
   * condenses the history through the session API). Only from the start of
   * the input, like `run`. */
  | "action";

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

/** Client-side commands that are not agent modes (see SlashCommandKind
 * "action"): `/compact` condenses the session's older history into a
 * checkpoint. They need no workspace, so they are offered in chat sessions
 * too. */
function actionCommands(t: Translator): SlashCommand[] {
  return [
    {
      id: "compact",
      label: t("chat.slash.compact.label"),
      description: t("chat.slash.compact.description"),
      icon: IconArrowsMinimize,
      kind: "action",
    },
  ];
}

/** The menu offered for `/` at a word start. A mode with
 * `buildPromptForText` is reusable anywhere in the input (`complete`); the
 * others are mode palettes that can only replace a whole message
 * (`run`). */
function modeCommands(t: Translator): SlashCommand[] {
  return AGENT_MODES.map((mode) => ({
    id: mode.id,
    label: t(mode.label),
    description: t(mode.description),
    icon: MODE_ICONS[mode.id] ?? FALLBACK_ICON,
    kind: mode.buildPromptForText === undefined ? "run" : "complete",
    items: mode.options.length > 0
      ? mode.options.map((option) => ({
        id: option.id,
        label: t(option.label),
        description: t(option.description),
        icon: MODE_ICONS[option.id] ?? FALLBACK_ICON,
      }))
      : undefined,
  }));
}

/** The id of the skill palette's first level; its submenu holds the
 * session's skill catalog. */
const SKILL_COMMAND_ID = "skill";

/** The text a `complete` pick leaves in the composer (see
 * SlashCommandKind "complete"): `/id ` for the command itself, and
 * `/id <item> ` when an entry of its submenu was picked — the item id is
 * the command's argument, which the submit path reads back out (the skill
 * name, see skillPromptFromText). */
export function slashCompletion(
  command: SlashCommand,
  item?: SlashCommandItem,
): string {
  return item === undefined ? `/${command.id} ` : `/${command.id} ${item.id} `;
}

/** One-line menu text, capped like the popover's own ellipsis (a 500
 * character skill description would still be a huge DOM string). */
function menuDescription(text: string): string {
  return text.slice(0, 80) + (text.length > 80 ? "…" : "");
}

/** The `/skill` submenu: one entry per skill of the session catalog (name +
 * catalog description). Hidden while the catalog is empty — a dead entry
 * would promise skills that cannot be loaded. Picking a skill completes the
 * input to `/skill <name> `, so the request is typed after it like any
 * other text; skillPromptFromText then wraps that line into the prompt that
 * makes the agent load the skill. */
export function skillMenu(
  skills: readonly SkillInfo[],
  t: Translator,
): SlashCommand[] {
  if (skills.length === 0) return [];
  return [{
    id: SKILL_COMMAND_ID,
    label: t("chat.slash.skill.label"),
    description: t("chat.slash.skill.description"),
    icon: IconSparkles,
    kind: "complete",
    items: skills.map((skill) => ({
      id: skill.name,
      label: skill.name,
      description: menuDescription(skill.description),
    })),
  }];
}

/** Build the slash-commands menu including the /skill and /prompt submenus.
 * In chat mode only skills, saved prompts and client-side actions are shown
 * (agent modes need a workspace; global and built-in skills do not).
 * Shared between ChatView and NewSessionView so the logic is not duplicated.
 * The callers pass the translator so their `useMemo` follows the app
 * language. */
export function buildSlashCommands(
  savedPrompts: SavedPrompt[],
  isChat: boolean,
  skills: readonly SkillInfo[],
  t: Translator,
): SlashCommand[] {
  const promptItems: SlashCommandItem[] = savedPrompts.map((p) => ({
    id: p.id,
    label: p.label,
    description: menuDescription(p.prompt),
    insertText: p.prompt,
  }));
  const skillCommands = skillMenu(skills, t);
  if (isChat) {
    // Chat mode: skills (global and built-in only), saved prompts and
    // client-side actions, no agent modes.
    return [
      ...skillCommands,
      ...actionCommands(t),
      ...promptItemsMenu(promptItems, t),
    ];
  }
  // Workspace mode: agent modes + skills + client-side actions + prompts.
  const commands = [
    ...modeCommands(t),
    ...skillCommands,
    ...actionCommands(t),
  ];
  commands.push(...promptItemsMenu(promptItems, t));
  return commands;
}

/** The `/prompt` submenu entry, or nothing when the user saved none. */
function promptItemsMenu(
  promptItems: SlashCommandItem[],
  t: Translator,
): SlashCommand[] {
  if (promptItems.length === 0) return [];
  return [{
    id: "prompt",
    label: t("chat.slash.prompt.label"),
    description: t("chat.slash.prompt.description"),
    icon: IconMessage,
    kind: "insert",
    items: promptItems,
  }];
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
  item: SlashCommandItem | undefined,
  text: string,
  t: Translator,
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
        modeLabel: t(mode.modeLabel),
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
        modeLabel: t(mode.modeLabel),
        // The short text is the one the transcript shows instead of the
        // prompt: the picked option's, else the mode's own (see
        // AgentMode.shortText).
        shortText: t(
          mode.options.find((option) => option.id === optionId)?.shortText ??
            mode.shortText ?? mode.modeLabel,
        ),
      },
    };
  }
  return null;
}

/** A command line parsed from composer text — `/plan 依頼文` (a text-taking
 * mode) or `/skill スキル名 依頼文` (the skill palette). "wrap" carries the
 * message to send: with mode metadata when the line named an agent mode
 * (the transcript stores a ModeMessage with a badge), without it for a
 * skill (a plain user message). "needs-text" means the command is
 * incomplete — its request or its skill name is missing — so nothing is
 * sent. */
export type TextCommandLine =
  | { kind: "wrap"; text: string; mode?: ModePrompt }
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
export function slashPromptFromText(
  text: string,
  t: Translator,
): TextCommandLine | null {
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
        modeLabel: t(mode.modeLabel),
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

/** Resolve composer text that contains the skill palette's command line
 * (`/skill <name> [依頼文]`, e.g. `/skill canvas-design ポスターを作って`)
 * into the message that invokes that skill. The name is the first word
 * after the token and the request is everything the user wrote around the
 * pair — each side trimmed and joined by a space (joinRequest), so text
 * before the command is not dropped: `ポスターを作って /skill canvas-design`
 * resolves the same as the form above.
 *
 * `skills` is the session's catalog (useSkills). Null when the text holds
 * no skill command, or names a skill outside that catalog: like an unknown
 * mode token, the text is then sent as written (the menu only lists the
 * catalog, so an unknown name is hand-typed). "needs-text" means the
 * command is present without a name — nothing is sent. */
export function skillPromptFromText(
  text: string,
  skills: readonly SkillInfo[],
): TextCommandLine | null {
  const token = /(?:^|\s)\/([^\s/]+)/g;
  for (let m = token.exec(text); m !== null; m = token.exec(text)) {
    const command = m[1]!;
    if (command !== SKILL_COMMAND_ID) continue;
    // Right after `/skill`: whitespace, then the skill name.
    const rest = text.slice(m.index + m[0].length);
    const nameMatch = /^\s+(\S+)/.exec(rest);
    if (nameMatch === null) return { kind: "needs-text" };
    const name = nameMatch[1]!;
    if (!skills.some((skill) => skill.name === name)) return null;
    return {
      kind: "wrap",
      text: buildSkillPrompt(
        name,
        joinRequest(text.slice(0, m.index), rest.slice(nameMatch[0].length)),
      ),
    };
  }
  return null;
}
