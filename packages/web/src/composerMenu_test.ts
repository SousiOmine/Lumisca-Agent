import { assertEquals } from "@std/assert";
import { composerMenuItems, insertTrigger } from "./composerMenu.ts";

/**
 * The plus menu's rows and the two triggers its items insert.
 *
 * Both were the kind of thing that looks right in one mode and wrong in the
 * other: a row that offers "attach files" where every file but a picture is
 * refused, or a `/` dropped in the middle of a word that the palette then
 * does not open on.
 */

const rows = (options: Parameters<typeof composerMenuItems>[0]) =>
  composerMenuItems(options).map((item) => [item.id, item.labelKey]);

Deno.test("composerMenuItems: a mode with a machine takes files, and offers nothing else", () => {
  // stella: a file is written into the machine, and there is no workspace to
  // mention and no command palette in that composer.
  assertEquals(
    rows({
      canSendFiles: true,
      canMention: false,
      canSlash: false,
      canShareFolder: false,
    }),
    [["attach", "chat.composer.attach.files"]],
  );
});

Deno.test("composerMenuItems: code mode offers the picture, the commands and the mention", () => {
  // The order is the one the menu draws: what goes into the message first,
  // then the two palettes.
  assertEquals(
    rows({
      canSendFiles: false,
      canMention: true,
      canSlash: true,
      canShareFolder: false,
    }),
    [
      ["attach", "chat.composer.attach.image"],
      ["command", "chat.composer.insert.command"],
      ["file", "chat.composer.insert.file"],
    ],
  );
  // A mode with no machine says "images", not "files": the picker refuses
  // everything else, and a row promising more reads as a broken attachment.
  assertEquals(
    composerMenuItems({
      canSendFiles: false,
      canMention: true,
      canSlash: true,
      canShareFolder: false,
    })[0]?.labelKey,
    "chat.composer.attach.image",
  );
});

Deno.test("composerMenuItems: a chat session has no mention to offer", () => {
  // No workspace attached: typing `@` opens nothing, so the row would be a
  // dead entry.
  assertEquals(
    rows({
      canSendFiles: false,
      canMention: false,
      canSlash: true,
      canShareFolder: false,
    }),
    [
      ["attach", "chat.composer.attach.image"],
      ["command", "chat.composer.insert.command"],
    ],
  );
});

Deno.test("composerMenuItems: the desktop app offers the folder, last", () => {
  // The folder row changes what the conversation can reach rather than what
  // goes into the next message, so it comes after the message rows. A
  // browser never passes the option: there is no picker to open.
  assertEquals(
    rows({
      canSendFiles: true,
      canMention: false,
      canSlash: false,
      canShareFolder: true,
    }),
    [
      ["attach", "chat.composer.attach.files"],
      ["share", "chat.stella.share.open"],
    ],
  );
});

Deno.test("insertTrigger: the caret lands right after the trigger", () => {
  assertEquals(insertTrigger("", { start: 0, end: 0 }, "/"), {
    value: "/",
    caret: 1,
  });
  assertEquals(insertTrigger("ab ", { start: 3, end: 3 }, "/"), {
    value: "ab /",
    caret: 4,
  });
  assertEquals(insertTrigger("a\nb", { start: 2, end: 2 }, "@"), {
    value: "a\n@b",
    caret: 3,
  });
});

Deno.test("insertTrigger: a trigger in the middle of a word gets a space first", () => {
  // Both palettes open only on a word start (whitespace before `/`, a
  // non-word character before `@`), so a trigger inserted without one would
  // sit there doing nothing.
  assertEquals(insertTrigger("abc", { start: 3, end: 3 }, "/"), {
    value: "abc /",
    caret: 5,
  });
  assertEquals(insertTrigger("abc", { start: 1, end: 1 }, "/"), {
    value: "a /bc",
    caret: 3,
  });
  assertEquals(insertTrigger("abc", { start: 3, end: 3 }, "@"), {
    value: "abc @",
    caret: 5,
  });
  // Punctuation already ends a word for `@`.
  assertEquals(insertTrigger("(", { start: 1, end: 1 }, "@"), {
    value: "(@",
    caret: 2,
  });
});

Deno.test("insertTrigger: the highlighted text is replaced", () => {
  // A word start is a word start, even when the trigger replaces what was
  // highlighted: the space that made the selection a word stays.
  assertEquals(insertTrigger("abcdef", { start: 2, end: 4 }, "/"), {
    value: "ab /ef",
    caret: 4,
  });
  assertEquals(insertTrigger("xabc", { start: 1, end: 3 }, "/"), {
    value: "x /c",
    caret: 3,
  });
  // A selection that begins a word needs no space of its own.
  assertEquals(insertTrigger("ab cd", { start: 3, end: 5 }, "@"), {
    value: "ab @",
    caret: 4,
  });
});

Deno.test("insertTrigger: a selection outside the text is clamped", () => {
  // A caret captured while the field was empty (the menu is reachable before
  // the first keystroke) must not slice past the text.
  assertEquals(insertTrigger("ab", { start: 9, end: 12 }, "/"), {
    value: "ab /",
    caret: 4,
  });
  assertEquals(insertTrigger("ab", { start: -3, end: -1 }, "@"), {
    value: "@ab",
    caret: 1,
  });
});
