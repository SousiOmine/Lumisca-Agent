/**
 * The browser's side of the clipboard exchange with the machine.
 *
 * What can be decided without a browser lives here: which key combination
 * means paste, and how a browser's line endings are normalized. The exchange
 * itself needs the RFB client and the server, so it stays in the pane
 * (StellaPane).
 *
 * The machine's clipboard is reached through the server, not through the VNC
 * connection: x11vnc's cut text is ISO 8859-1, so Japanese would arrive as
 * question marks (see core/vm/clipboard.ts).
 */

/** A paste chord, in the shape the machine's side should receive it. `shift`
 * is the variant a terminal uses (xterm pastes with Ctrl+Shift+V, where a
 * bare Ctrl+V means "quote the next character"). */
export interface PasteChord {
  shift: boolean;
}

/** The keys a keyboard event carries, for {@link pasteChordOf}. */
export interface PasteChordEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * The paste chord an event carries, or null when it is not a paste.
 *
 * Both platforms answer: macOS users press Cmd+V, and the machine is Linux, so
 * that becomes Ctrl+V there — a Meta+V would reach the application as
 * super+v, which pastes nothing. Alt is excluded: Alt+V is a menu or a dead
 * key in most applications, not a paste.
 */
export function pasteChordOf(event: PasteChordEvent): PasteChord | null {
  if (event.altKey) return null;
  if (event.key !== "v" && event.key !== "V") return null;
  if (!event.ctrlKey && !event.metaKey) return null;
  return { shift: event.shiftKey };
}

/** The text as the machine should receive it: a browser copies Windows line
 * endings, and an application inside the machine would insert the `\r`
 * literally (a visible `^M` in a terminal). The server applies the same rule;
 * this one exists so the pane counts and drops whitespace exactly as the
 * machine will see it. */
export function normalizeClipboardText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}
