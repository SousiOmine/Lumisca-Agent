import type { SkillDef } from "../discover.ts";

/**
 * The built-in "desktop-apps" skill: the bundled guide to driving the
 * machine's GUI by what its widgets ARE (`vm_find` / `vm_do` / `vm_wait`)
 * rather than by where they happen to be drawn.
 *
 * The three tools are preloaded, so this skill is not what makes them usable
 * — it is what makes them the default. Without it an agent that has just
 * taken a screenshot will read coordinates off it for everything, because a
 * picture is the most obvious thing to reach for; the whole point of the
 * semantic path is that it is tried first.
 *
 * Always available in a stella session (the tools are), so it is not gated on
 * a runtime capability the way the computer-use skill is.
 */

/** The SKILL.md body. English, like the tool descriptions it quotes. */
const SKILL_MD = `# Working with desktop applications in the machine

The machine has a screen, and the fastest way to use a GUI is usually NOT to
look at it. Every application publishes its widgets through the operating
system's accessibility layer, and three preloaded tools read and act on that:

- **vm_find** — locate an element by role, name or text; returns a ref
- **vm_do** — act on a ref (click, set_value, check, uncheck, select, focus,
  key, scroll)
- **vm_wait** — wait for a tree condition (or a plain delay)

Because the action goes through the application's own interface, it does not
move the pointer and cannot land on a neighbouring control. The result is
read back, so "the click did nothing" is visible instead of assumed.

## Which tool for which job

| Goal | Use |
| --- | --- |
| Press a button, fill a field, tick a box | vm_find, then vm_do |
| Read a table, a list, or what a form says | vm_find with actionable "no" |
| See the layout, or something with no widgets | vm_screenshot |
| Drag across an image, drive a canvas, press somewhere by eye | vm_act |
| Wait for a page or a dialog | vm_wait with a condition |

Prefer the semantic path. Take a screenshot when the question is about
appearance or when there is no element to name; do not mix the two on the
same target (a coordinate click and a semantic click do the same thing, and
one of them is aimed at a rectangle).

## The loop

1. **vm_find** with what you know: \`{app: "chromium", role: "push button",
   name: "Save"}\`
2. **vm_do** with the ref it returned: \`{ref: "@s12345:e8", action: "click"}\`
3. Read the result. \`delivered_verified\` means the element's state changed.
   \`delivered_unverified\` means the application accepted the action but
   nothing readable changed — look with vm_find before repeating it, because a
   second click may act twice.
4. **vm_find** again when you are done with that part of the window: a ref is
   valid only against the snapshot it came from.

## Roles and names

A role is the kind of control. These cover most applications:

\`push button\`, \`toggle button\`, \`check box\`, \`radio button\`,
\`combo box\`, \`entry\` (a text field), \`menu item\`, \`page tab\`, \`link\`,
\`slider\`, \`table cell\`, \`list item\`, \`tree item\`, plus \`label\` and
\`heading\` for text.

A name is what the control says. Use \`name\` when you know the label, \`text\`
to match content anywhere in an element (a table row by a cell's value).

A find that matches nothing lists the roles that window DOES have. Read it
before searching again: the usual cause is a wrong role word, not an empty
window — a browser's text field is \`entry\`, not \`textbox\`.

## Filling a form

\`\`\`
vm_find  {app: "chromium", role: "entry", name: "Email"}
vm_do    {ref: "@s…:e4", action: "set_value", value: "a@example.com"}
vm_find  {app: "chromium", role: "push button", name: "Submit"}
vm_do    {ref: "@s…:e9", action: "click"}
vm_wait  {app: "chromium", text: "Thank you", timeout_ms: 5000}
\`\`\`

- \`set_value\` writes a GTK field directly and types into a web field (it
  focuses the field and replaces its contents). If it answers that the field
  cannot take the focus, click it first with \`vm_do action "focus"\`.
- \`select\` takes the option's visible name. A miss lists the options offered.
- \`check\` and \`uncheck\` are idempotent; the result says \`unchanged\` when
  it was already in that state.

## Keys

\`vm_do action "key"\` sends keys to whatever has the focus, by X11 name:
\`Return\`, \`Escape\`, \`Tab\`, \`ctrl+a\`, \`ctrl+v\`, \`alt+Tab\`, \`super\`.
Focus the target first (\`vm_do action "focus"\`, or \`click\`) — otherwise
the keys go to whatever window is in front.

## Reading a window without a screenshot

\`\`\`
vm_find {app: "chromium", actionable: "no", limit: 60}
\`\`\`

That lists static text and containers as well, which answers questions like
"what does this page say" for a fraction of the cost of an image. For a table,
search by \`role: "table cell"\`.

## When it does not work

- **"no running application matches"** — the result names what IS running.
  Use that name. (A terminal such as xterm does not publish itself at all;
  drive those with the shell instead of the GUI.)
- **An empty web area** — the page has not finished rendering, or it is a
  browser that was started without accessibility. \`vm_wait\` for a text on the
  page first; if it never appears, look with \`vm_screenshot\` to see what the
  window actually shows.
- **"the element is gone" / "no longer matches"** — the window changed under
  the ref. Run vm_find again; that is the contract, not a failure.
- **Two identical elements** — the tree cannot tell them apart. Use
  \`vm_screenshot\` and \`vm_act\` with coordinates for that one control.
- **A disabled control** shows \`[disabled]\` in the find result. Do not click
  it: an action on a disabled element does nothing, and the app normally says
  why somewhere on the screen.
- **The action answers \`delivered_unverified\`** — read again before
  repeating. The app may have opened a dialog, started a download, or ignored
  the action.

## Rules

- Ask the user before anything destructive or hard to undo: deleting or
  moving files, sending messages or mail, purchases, installing software,
  closing unsaved work.
- Never type credentials, tokens or passwords. If a step needs one, hand the
  screen to the user with \`vm_ask_user\`.
- The result of an action is evidence of what the app reported, not of what
  the user will see. When the outcome matters, confirm it (a new row, a
  changed label, a closed dialog) before saying it worked.
`;

/** Build the built-in desktop-apps skill definition. */
export function desktopAppsSkill(): SkillDef {
  return {
    name: "desktop-apps",
    description:
      "Operating the machine's graphical applications by their widgets: " +
      "finding a button or field by role and name (vm_find), acting on it " +
      "(vm_do), and waiting for a page or dialog (vm_wait) — cheaper and more " +
      "precise than reading coordinates off a screenshot. Also covers when " +
      "the pixel path (vm_screenshot / vm_act) is the right one.",
    source: "builtin",
    read: (relativePath) => {
      if (relativePath !== undefined) {
        // One file per built-in skill for now: no follow-up files exist.
        return Promise.reject(
          new Error(`No such file in skill "desktop-apps": ${relativePath}`),
        );
      }
      return Promise.resolve(SKILL_MD);
    },
  };
}
