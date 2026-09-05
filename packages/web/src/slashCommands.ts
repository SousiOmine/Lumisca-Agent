/** Slash-command menu for the composer, derived from the core agent-mode
 * registry (AGENT_MODES). Adding a mode in core automatically adds its
 * menu entry here; the icon map below only needs a line per new mode id
 * (unknown ids fall back to a generic icon). */

import type { ComponentType } from "react";
import { AGENT_MODES, findAgentMode } from "@lumisca/core/modes";
import type { ModePrompt } from "@lumisca/core";
import {
  IconCode,
  IconFileDiff,
  IconGitBranch,
  IconGitCommit,
} from "@tabler/icons-react";
import type { SlashCommand, SlashCommandItem } from "./components/Composer.tsx";

type Icon = ComponentType<{ size?: number; className?: string }>;

/** Icons of known modes and their options, keyed by id. */
const MODE_ICONS: Record<string, Icon> = {
  review: IconFileDiff,
  "base-diff": IconGitBranch,
  uncommitted: IconGitCommit,
};

const FALLBACK_ICON: Icon = IconCode;

/** The menu shown when the input starts with `/`. */
export const slashCommands: SlashCommand[] = AGENT_MODES.map((mode) => ({
  id: mode.id,
  label: mode.label,
  description: mode.description,
  icon: MODE_ICONS[mode.id] ?? FALLBACK_ICON,
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
 * — the menu only lists registered ones). */
export function slashPrompt(
  command: SlashCommand,
  item?: SlashCommandItem,
): { text: string; mode: ModePrompt } | null {
  const mode = findAgentMode(command.id);
  if (!mode) return null;
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
