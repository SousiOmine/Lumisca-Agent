import { MAX_PROMPT_TEXT_LENGTH } from "@lumisca/core/shared";
import type {
  Dispatch,
  KeyboardEvent,
  RefObject,
  SetStateAction,
} from "preact/compat";
import { useCallback, useEffect } from "preact/hooks";
import { insertTrigger } from "../composerMenu.ts";
import {
  type SlashCommand,
  type SlashCommandItem,
  slashCompletion,
} from "../slashCommands.ts";
import { useCaretPosition } from "./useCaretPosition.ts";
import { type MentionState, useMention } from "./useMention.ts";
import { type SlashState, useSlashMenu } from "./useSlashMenu.ts";

/**
 * The two palettes the field opens: `@` (a workspace path) and `/` (a
 * command).
 *
 * They are mutually exclusive — a matching `/` takes over the input, so the
 * two lists never overlap — and they share the caret marker the mention list
 * is placed against. Owning both here is what keeps that rule in one place;
 * the state was interleaved with the composer's focus, attachment and send
 * handling, where nothing else needed it.
 *
 * What a pick does to the text is also here (complete the token, insert a
 * saved prompt, or hand a mode command to the caller), because only the field
 * knows where the caret was when the list opened.
 */
export interface ComposerPalettesOptions {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** The current input value; the picks edit it in place. */
  value: string;
  onChange: (value: string) => void;
  /** Workspace to offer `@` files from; undefined disables mentions. */
  mentionWorkspaceId?: string;
  /** Peer owning the workspace ("" = this server). */
  mentionPeerId: string;
  /** The caller's command list; undefined says `/` opens nothing. */
  slashCommands?: SlashCommand[];
  /** A `run` or `action` command was picked at the start of the input. */
  onSlashCommand?: (command: SlashCommand, item?: SlashCommandItem) => void;
  /** The tall new-session field: its caret sits near the top often enough
   * that the mention list flips below the caret line instead of covering the
   * first lines. */
  large?: boolean;
}

export interface ComposerPalettes {
  /** Caret position in the textarea, or null while no mention is open. */
  caretPos: { x: number; y: number } | null;
  mention: MentionState | null;
  setMention: Dispatch<SetStateAction<MentionState | null>>;
  selectMention: (index: number) => void;
  slash: SlashState | null;
  setSlash: Dispatch<SetStateAction<SlashState | null>>;
  slashEntries: SlashCommandItem[];
  selectSlash: (index: number) => void;
  /** Whether the mention list opens above the caret line. */
  showMentionAbove: boolean;
  /** Re-evaluate the command and the mention under the caret after typing or
   * caret moves. */
  updateSuggestions: (nextValue: string, caret: number) => void;
  /** Put a palette trigger at the caret and open the menu it starts. */
  openPalette: (trigger: "/" | "@") => void;
  /** Keyboard handling for an open list; true when the key was consumed. */
  handleKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
}

export function useComposerPalettes({
  textareaRef,
  value,
  onChange,
  mentionWorkspaceId,
  mentionPeerId,
  slashCommands,
  onSlashCommand,
  large,
}: ComposerPalettesOptions): ComposerPalettes {
  const {
    caretPos,
    setCaretPos,
    measure: measureCaret,
  } = useCaretPosition(textareaRef);
  const clearCaret = useCallback(() => setCaretPos(null), [setCaretPos]);
  const {
    mention,
    setMention,
    updateMention,
    selectMention,
    closeMention,
    handleKeyDown: handleMentionKeyDown,
  } = useMention({
    textareaRef,
    workspaceId: mentionWorkspaceId,
    peerId: mentionPeerId,
    value,
    onChange,
    clearCaret,
  });

  /** Replace the `/command` token the pick was made from with `text`,
   * keeping the text around it: the palette edits the input in place
   * instead of replacing the whole message. `trimAfter` drops the
   * whitespace that followed the token, so completing to `/plan ` does not
   * double the space it inserts. The caret lands right after the inserted
   * text (the textarea keeps focus: the popover suppresses its own
   * mousedown). */
  const replaceSlashToken = useCallback(
    (state: SlashState, text: string, trimAfter: boolean) => {
      const ta = textareaRef.current;
      const caret = ta?.selectionStart ?? state.end;
      const before = value.slice(0, state.start);
      let after = value.slice(Math.max(state.end, caret));
      if (trimAfter) after = after.replace(/^\s+/, "");
      onChange(before + text + after);
      const caretAfter = before.length + text.length;
      requestAnimationFrame(() => {
        ta?.focus();
        ta?.setSelectionRange(caretAfter, caretAfter);
      });
    },
    [value, onChange, textareaRef],
  );

  /** Apply a slash entry picked by click, Enter or Tab. Text-taking
   * commands (`/plan`, `/goal`) are completed to `/id ` and the menu
   * closes: the request is typed after the token like normal input and
   * wrapped into the mode prompt on submit (see ChatView/NewSessionView) —
   * picking the command never sends by itself. A command with subcommands
   * completes to `/id <picked item> ` (the skill palette), so the picked
   * entry stays an argument of the command line. Saved prompts are inserted
   * where the command was typed. Mode palettes run through the parent, but
   * only from the start of the input: their prompt replaces the whole
   * message, so a command typed mid-text is left alone instead of
   * discarding the text around it. */
  const handleSlashSelect = useCallback(
    (
      command: SlashCommand,
      item: SlashCommandItem | undefined,
      state: SlashState,
    ) => {
      if (command.kind === "complete") {
        replaceSlashToken(state, slashCompletion(command, item), true);
        return;
      }
      // An action command that takes an argument completes to `/id ` like a
      // text-taking mode: the argument is typed after the token and read
      // back on submit (see actionCommandFromText). The menu stays a
      // palette, never a sender.
      if (command.kind === "action" && command.takesText === true) {
        replaceSlashToken(state, slashCompletion(command, item), true);
        return;
      }
      if (command.kind === "insert") {
        const insert = item?.insertText ?? command.insertText;
        if (insert !== undefined) replaceSlashToken(state, insert, false);
        return;
      }
      // "run" and "action" replace the whole message (a mode prompt, or a
      // client-side command that sends nothing), so they only apply from
      // the start of the input.
      if (value.slice(0, state.start).trim() === "") {
        onSlashCommand?.(command, item);
      }
    },
    [value, replaceSlashToken, onSlashCommand],
  );

  const {
    slash,
    setSlash,
    slashEntries,
    updateSlash,
    resetSlash,
    selectSlash,
    handleKeyDown: handleSlashKeyDown,
  } = useSlashMenu({
    enabled: slashCommands !== undefined,
    commands: slashCommands ?? [],
    onSelect: handleSlashSelect,
  });

  // Switching sessions (different workspace) must not leak a stale mention
  // or slash command.
  useEffect(() => {
    closeMention();
    resetSlash();
  }, [mentionWorkspaceId, mentionPeerId, closeMention, resetSlash]);

  /** Re-evaluate the slash command and the mention under the caret after
   * typing or caret moves. They are mutually exclusive: a matching `/`
   * takes over the input, so the two popovers never overlap. */
  const updateSuggestions = (nextValue: string, caret: number) => {
    if (updateSlash(nextValue, caret)) {
      closeMention();
      return;
    }
    resetSlash();
    if (updateMention(nextValue, caret)) {
      measureCaret();
    } else if (mention !== null) {
      clearCaret();
    }
  };

  /** Put a palette trigger at the caret and open the menu it starts. The
   * plus menu runs the same detection as typing the character, so the two
   * paths cannot drift apart. The detected token is what the popover is
   * placed against, so the caret is moved before the detection runs: the
   * frame callback is after the render that writes the field's value. */
  const openPalette = (trigger: "/" | "@") => {
    const field = textareaRef.current;
    const next = insertTrigger(
      value,
      {
        start: field?.selectionStart ?? value.length,
        end: field?.selectionEnd ?? value.length,
      },
      trigger,
    );
    // The field refuses a value past the cap; inserting one it would drop
    // leaves a trigger on screen that does not open anything.
    if (next.value.length > MAX_PROMPT_TEXT_LENGTH) return;
    onChange(next.value);
    requestAnimationFrame(() => {
      const target = textareaRef.current;
      if (target === null) return;
      target.focus();
      target.setSelectionRange(next.caret, next.caret);
      updateSuggestions(next.value, next.caret);
    });
  };

  // The popover opens above the caret line. Only in the tall new-session
  // textarea does the caret sit near the top often enough to flip below
  // instead of covering the first lines.
  const showMentionAbove = !(large && caretPos !== null && caretPos.y < 60);

  return {
    caretPos,
    mention,
    setMention,
    selectMention,
    slash,
    setSlash,
    slashEntries,
    selectSlash,
    showMentionAbove,
    updateSuggestions,
    openPalette,
    handleKeyDown: (e) => handleSlashKeyDown(e) || handleMentionKeyDown(e),
  };
}
