/**
 * What the composer's plus button offers, and where its two palette inserters
 * land.
 *
 * The button used to be the paperclip: one control, one action (open the file
 * picker). It now opens a short menu, and which rows that menu has is not a
 * mode name but what the composer was handed: `onFilesChange` says there is a
 * machine to put a non-picture file in (stella), `mentionWorkspaceId` and
 * `slashCommands` say the two palettes exist. Those three callers (ChatView,
 * NewSessionView, StellaView) pass different subsets, so deriving the rows
 * here keeps the three from each answering the same question.
 */

import type { MessageKey } from "@lumisca/core/shared";
import {
  type Icon,
  IconAt,
  IconFolder,
  IconPaperclip,
  IconPhoto,
  IconSlash,
} from "@tabler/icons-preact";

/** The rows, in the order they are drawn. */
export type ComposerMenuItemId = "attach" | "command" | "file" | "share";

export interface ComposerMenuItem {
  id: ComposerMenuItemId;
  /** What the row says (the caller translates it). */
  labelKey: MessageKey;
  icon: Icon;
}

export interface ComposerMenuOptions {
  /** The composer can send a file that is not a picture: it has a machine to
   * write it into. Without one the picker takes pictures only, and the row
   * says so — offering "attach files" where every file but a picture is
   * refused made the refusal look like a bug. */
  canSendFiles: boolean;
  /** Typing `@` offers workspace files (a workspace is attached). */
  canMention: boolean;
  /** Typing `/` opens the command palette. */
  canSlash: boolean;
  /** The composer sits in the desktop app, where a folder on this computer
   * can be lent to the conversation. A browser has no folder picker to
   * offer, so the row does not exist there. */
  canShareFolder: boolean;
}

/** The rows of the plus menu for this composer. */
export function composerMenuItems(
  options: ComposerMenuOptions,
): ComposerMenuItem[] {
  const { canSendFiles, canMention, canSlash, canShareFolder } = options;
  const items: ComposerMenuItem[] = [
    canSendFiles
      ? {
          id: "attach",
          labelKey: "chat.composer.attach.files",
          icon: IconPaperclip,
        }
      : {
          id: "attach",
          labelKey: "chat.composer.attach.image",
          icon: IconPhoto,
        },
  ];
  if (canSlash) {
    items.push({
      id: "command",
      labelKey: "chat.composer.insert.command",
      // The trigger the row inserts, not a "command" key: the menu is what
      // teaches the reader that `/` opens it.
      icon: IconSlash,
    });
  }
  if (canMention) {
    items.push({
      id: "file",
      labelKey: "chat.composer.insert.file",
      icon: IconAt,
    });
  }
  // Last, because it is not something put INTO the message: it changes what
  // the conversation can reach. The three above are about this turn.
  if (canShareFolder) {
    items.push({
      id: "share",
      labelKey: "chat.stella.share.open",
      icon: IconFolder,
    });
  }
  return items;
}

/** Where a trigger may be typed: the palette detection opens only on a
 * trigger that starts a word (`detectSlash` wants whitespace before `/`,
 * `detectMention` a non-word character before `@`), and a space satisfies
 * both. The menu therefore inserts a leading space when the caret is in the
 * middle of a word instead of dropping a trigger the reader cannot open. */
function needsLeadingSpace(before: string, trigger: "/" | "@"): boolean {
  const previous = before.slice(-1);
  if (previous === "") return false;
  return trigger === "/" ? !/\s/.test(previous) : /\w/.test(previous);
}

/** Insert a palette trigger at the selection and report where the caret goes:
 * right after it, so the menu's query starts empty and the reader types the
 * name. The selection is replaced (a highlighted word is what the trigger is
 * meant to stand in front of, not something to append after). */
export function insertTrigger(
  value: string,
  selection: { start: number; end: number },
  trigger: "/" | "@",
): { value: string; caret: number } {
  const start = Math.min(Math.max(selection.start, 0), value.length);
  const end = Math.min(Math.max(selection.end, start), value.length);
  const before = value.slice(0, start);
  const inserted = `${needsLeadingSpace(before, trigger) ? " " : ""}${trigger}`;
  return {
    value: before + inserted + value.slice(end),
    caret: start + inserted.length,
  };
}
