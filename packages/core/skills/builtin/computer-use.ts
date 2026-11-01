import type { SkillDef } from "../discover.ts";

/**
 * The built-in "computer-use" skill: the bundled guide to the machine-driving
 * tools (computer_screenshot / computer_act / computer_list_windows). The
 * tools are never preloaded into the LLM context — they live in the
 * session's tool registry and are only found through tool_search — so
 * without a skill an agent can go an entire session without realizing it may
 * drive the screen. This skill exists to close exactly that gap.
 *
 * Sessions that must not drive the machine (no host on this platform, or the
 * user has not enabled the feature) must not advertise it: the availability
 * gate lives in builtin/mod.ts (BuiltinContext.computer).
 */

/** The SKILL.md body. English, like the tool descriptions it quotes; kept
 * deliberately compact so the session listing stays small. */
const SKILL_MD =
  `# Built-in computer use (this machine's screen, mouse and keyboard)

A skill for driving the machine the Lumisca server runs on: capturing the
screen, clicking, dragging and typing. The tools are not preloaded, so find
them first with tool_search (see "Most important" below).

## When to use

- Operating a GUI application that has no CLI or API (an installer, a
  desktop app, a launcher)
- Verifying what the user sees: whether a dialog appeared, what a window
  shows, where the pointer is
- Reproducing the user's manual steps ("File → Export, then …")
- Anything a screenshot answers faster than a description would

## Most important: the tools are not preloaded

computer_screenshot / computer_act / computer_list_windows are NOT part of
the session's LLM context. Before using one, find it with tool_search and
execute it with tool_call:

1. tool_search(query: "computer") — returns the three tools with their
   descriptions and argument schemas
2. tool_call(name: "computer_screenshot", args: {}) — execute the tool

When the feature is disabled (Settings → security → computer use) or this
platform has no host, tool_search finds nothing: tell the user to enable it
instead of retrying.

## Coordinates: screenshot first, then act

computer_act coordinates are the pixels of the MOST RECENT
computer_screenshot — not screen pixels; the tool converts them. So:

1. computer_screenshot — read the image and note the reported scale, e.g.
   "image 1280×720 (scale 0.500)"
2. computer_act with x/y as the pixel position you read off that image
3. The result states the screen coordinates it resolved to, e.g.
   \`image (64, 36) → screen (128, 72)\`. If those look wrong, the screen
   changed or the image was misread: take a fresh screenshot.

A coordinate action without a screenshot fails with "no screenshot yet" —
that is the contract, not a bug.

## The three tools

- **computer_screenshot(display?, region?, max_dimension?)** — captures one
  display (default: the primary; the result lists every display with its
  index, size and position) or an explicit region in screen pixels. Use a
  small region to read fine detail: a region below max_dimension comes back
  1:1 (scale 1.000).
- **computer_act(action, …)** — move / click / drag / scroll / type / key /
  focus_window / wait. Pointer movement is interpolated over about 0.1s
  (0.3s for a drag) with a short pause before pressing, so hover-revealed UI
  and drop targets behave as with a real hand. Typing is Unicode, so any
  language works; a newline in the text is typed as an Enter press.
- **computer_list_windows(title_contains?)** — top-level windows in z-order
  with id, title, rectangle and state. Use it to find the window to focus
  before typing, and to see what is currently in the foreground. A platform
  that cannot see windows (Wayland) says so instead of listing nothing.

## Typing reliability

Short typing runs are reliable. A long injected run is not always: on a
machine whose input goes through a remote-desktop or virtual-display stack,
part of the text can arrive corrupted (characters replaced by a repeated
one, extra line breaks). An open IME can also eat injected characters: on
Windows the typing path switches it off for the duration (and fails the call
when it cannot), while on Wayland the input method belongs to the
compositor, so a mis-typed run is the signal to use the clipboard.

If the app does not show what you sent (verify with a screenshot, or by
selecting all and reading the window title):

1. Put the text on the clipboard from the shell instead of typing it, e.g.
   bash: \`Set-Clipboard -Value "<text>"\` (Windows), \`pbcopy\` (macOS),
   \`wl-copy\` (Wayland) or \`xclip -selection clipboard\` (X11) — whichever
   of these is installed
2. computer_act(action: "key", key: "ctrl+v") — a paste is not keyboard
   input, so neither problem can touch it
3. Verify the result; clear the clipboard again when the text was private

When typing is required, keep runs short (a few lines at a time) and verify
before continuing.

## Standard workflow

1. If a specific app is needed, find its window with computer_list_windows
   and raise it: computer_act(action: "focus_window", window: "0x000A0B2C")
   (not on Wayland, which cannot name windows — press alt+tab or click the
   window you see in a screenshot instead)
2. computer_screenshot — look at the image
3. Act one step at a time: click / type / key / drag
4. Screenshot again to verify. Never assume an action worked because the
   tool did not fail: a click can land on the wrong element, and typing goes
   to whichever window holds the focus (the result names it on Windows).

## Rules

- Ask the user before anything destructive or hard to undo: deleting or
  moving files, sending messages or mail, purchases, installing software,
  changing system settings, closing unsaved work.
- Never type credentials, tokens or passwords, and never start a login flow
  unless the user explicitly asked for it.
- The user is sitting in front of this machine. Do not disturb their work:
  focus the window you need first, keep the pointer away from what they are
  doing, and say what you are about to do when the task is not obviously
  safe.
- Do not try to work around a refusal: elevated windows ignore synthetic
  input, and that is reported as a failure.

## Limits

- Only the machine the server runs on. A server on another host drives THAT
  machine's screen, which may have no display at all.
- Windows, and Linux on a Wayland session (GNOME and others that provide the
  desktop portal). An X11 session on Linux has no host: log in with a Wayland
  session instead. The verdict comes from the desktop's own portal, so a
  server started by systemd (before the desktop session exists) asks again
  when the feature is turned on — no restart is needed after logging in.
- Wayland hides windows and the pointer from other processes on purpose, so
  there computer_list_windows reports that it cannot list them, focus_window
  is refused, and no cursor position is reported. Switch windows with
  computer_act(action: "key", key: "alt+tab"), or click what you see in a
  screenshot.
- On Wayland the desktop asks the user twice on first use: once to allow
  screenshots, once to share the screen (at the first input action). Both
  answers are remembered, and both can be revoked in the system's privacy
  settings. A decline comes back as an error — ask the user, do not retry.
- The agent can only act on the monitors the user shared. A click on another
  monitor is refused by name, and the next action asks the user again.
- Protected surfaces cannot be captured: an elevated (UAC) prompt and
  DRM-protected video come back black. A display that is not rendering (a
  virtual monitor with no signal) can also be black — the result names what
  was captured, so try another display.
- Input from a non-elevated process is ignored by elevated windows.
- Long injected typing can be corrupted on some machines; the clipboard path
  above is the reliable alternative.

## Errors and how to handle them

- "computer use is not available in this session" — the feature is off, or
  this platform has no host: tell the user, do not retry
- "no screenshot yet" — call computer_screenshot first
- "unknown display index N" / "does not overlap any display" — re-read the
  display list in the last screenshot's result
- "the screenshot was declined" / "the user cancelled the request to share
  the screen" — the user said no: report it and stop
- "the desktop did not share <monitor> …" — that monitor is outside what the
  user granted; tell them which one is missing
- "input injection failed" — another process is blocking synthetic input
  (usually an elevated window): report it instead of retrying
- "the focused window has an open IME ... could not be switched off" — tell
  the user to switch the IME off (半角/全角) and retry, or use the clipboard
  path above (Windows)
- The app shows text you did not send — do not retype blindly: verify what
  arrived, then use the clipboard path
`;

/** Build the built-in computer-use skill definition. Content is embedded (no
 * filesystem), so it survives bundling and any working directory. */
export function computerUseSkill(): SkillDef {
  return {
    name: "computer-use",
    description:
      "Driving this machine's screen, mouse and keyboard: capturing the " +
      "screen, clicking, dragging and typing in real GUI applications. The " +
      "computer_screenshot / computer_act / computer_list_windows tools are " +
      "not preloaded — find them with tool_search, then execute with " +
      "tool_call. Windows and Linux (Wayland), and only when the feature is " +
      "enabled in settings.",
    source: "builtin",
    read: (relativePath) => {
      if (relativePath !== undefined) {
        // One file per built-in skill for now: no follow-up files exist.
        // The message mirrors the file-based skills' read error.
        return Promise.reject(
          new Error(`No such file in skill "computer-use": ${relativePath}`),
        );
      }
      return Promise.resolve(SKILL_MD);
    },
  };
}
