/** Slash-command menu for the composer, derived from the core agent-mode
 * registry (AGENT_MODES). Adding a mode in core automatically adds its
 * menu entry here; the icon map below only needs a line per new mode id
 * (unknown ids fall back to a generic icon). Text-taking modes (those with
 * `buildPromptForText`, e.g. plan mode) execute with the composer text
 * typed after the command token (`/plan 依頼文`) as their subject. */

import type { ComponentType } from "react";
import { AGENT_MODES, findAgentMode } from "@lumisca/core/modes";
import type { ModePrompt } from "@lumisca/core";
import {
  IconCode,
  IconFileDiff,
  IconGitBranch,
  IconGitCommit,
  IconListCheck,
} from "@tabler/icons-react";
import type { SlashCommand, SlashCommandItem } from "./components/Composer.tsx";

type Icon = ComponentType<{ size?: number; className?: string }>;

/** Icons of known modes and their options, keyed by id. */
const MODE_ICONS: Record<string, Icon> = {
  review: IconFileDiff,
  "base-diff": IconGitBranch,
  uncommitted: IconGitCommit,
  plan: IconListCheck,
};

const FALLBACK_ICON: Icon = IconCode;

/** The menu shown when the input starts with `/`. A mode with
 * `buildPromptForText` is marked `requiresText`: its subject is the text
 * after the command token, so the menu instead hints to keep typing. */
export const slashCommands: SlashCommand[] = AGENT_MODES.map((mode) => ({
  id: mode.id,
  label: mode.label,
  description: mode.description,
  icon: MODE_ICONS[mode.id] ?? FALLBACK_ICON,
  requiresText: mode.buildPromptForText !== undefined,
  items: mode.options.length > 0
    ? mode.options.map((option) => ({
      id: option.id,
      label: option.label,
      description: option.description,
      icon: MODE_ICONS[option.id] ?? FALLBACK_ICON,
    }))
    : undefined,
}));

/** Build the user message + mode metadata a slash-command selection sends;
 * null when the selection does not resolve to a registered mode (defensive
 * — the menu only lists registered ones). Text-taking modes wrap the text
 * typed after the command token (the menu hands it over as `text`); with
 * no text nothing is sent (null), so the user keeps typing the request. */
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

/** Resolve composer text that itself starts with a text-taking command
 * token (`/plan 履歴機能を追加して`), used by submit paths that bypass the
 * menu (the send button, Ctrl+Enter). "needs-text" means the token is
 * present but the request is missing — nothing should be sent. Null when
 * the text is not a text-taking command line (a plain message, or a
 * command without text support such as review). */
export function slashPromptFromText(text: string): TextCommandLine | null {
  const match = /^(\/[^\s]+)(?:\s+([\s\S]+))?$/.exec(text.trim());
  if (match === null) return null;
  const mode = findAgentMode(match[1]!.slice(1));
  if (mode?.buildPromptForText === undefined) return null;
  const request = (match[2] ?? "").trim();
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
