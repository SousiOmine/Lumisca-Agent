import { assertEquals } from "@std/assert";
import type { BackspaceEvent, BackspaceTarget } from "./useBackspaceGuard.ts";
import {
  isTextEditTarget,
  shouldSwallowBackspace,
} from "./useBackspaceGuard.ts";

/** Helper: a target as the guard reads it off the DOM. */
function target(props: Partial<BackspaceTarget>): BackspaceTarget {
  return { tagName: "DIV", ...props };
}

Deno.test("isTextEditTarget: the text fields keep Backspace", () => {
  assertEquals(isTextEditTarget(target({ tagName: "INPUT" })), true);
  assertEquals(
    isTextEditTarget(target({ tagName: "INPUT", type: "text" })),
    true,
  );
  // The URL field of the server list and the token field: the report was
  // that Backspace in these closes the settings dialog.
  assertEquals(
    isTextEditTarget(target({ tagName: "INPUT", type: "url" })),
    true,
  );
  assertEquals(
    isTextEditTarget(target({ tagName: "INPUT", type: "password" })),
    true,
  );
  assertEquals(
    isTextEditTarget(target({ tagName: "INPUT", type: "number" })),
    true,
  );
  assertEquals(isTextEditTarget(target({ tagName: "TEXTAREA" })), true);
  assertEquals(
    isTextEditTarget(target({ tagName: "DIV", isContentEditable: true })),
    true,
  );
});

Deno.test("isTextEditTarget: no caret means Backspace is not an edit", () => {
  assertEquals(isTextEditTarget(target({ tagName: "DIV" })), false);
  assertEquals(isTextEditTarget(target({ tagName: "BODY" })), false);
  assertEquals(isTextEditTarget(target({ tagName: "BUTTON" })), false);
  assertEquals(isTextEditTarget(target({ tagName: "SPAN" })), false);
  assertEquals(isTextEditTarget(target({ tagName: "A" })), false);
  assertEquals(
    isTextEditTarget(target({ tagName: "INPUT", type: "checkbox" })),
    false,
  );
  assertEquals(
    isTextEditTarget(target({ tagName: "INPUT", type: "radio" })),
    false,
  );
  assertEquals(
    isTextEditTarget(target({ tagName: "INPUT", type: "range" })),
    false,
  );
  assertEquals(
    isTextEditTarget(target({ tagName: "INPUT", type: "file" })),
    false,
  );
  assertEquals(isTextEditTarget(target({ tagName: "SELECT" })), false);
  // A target the guard could not read (a synthetic event's document, ...):
  // treated as "no text field" so the WebView never navigates.
  assertEquals(isTextEditTarget({ tagName: "" }), false);
});

Deno.test("isTextEditTarget: a control that cannot be edited is not an edit", () => {
  // Read-only and disabled fields hold nothing to delete, and WebKit's
  // delete command refuses them: this is exactly where Backspace would
  // navigate instead.
  assertEquals(
    isTextEditTarget(
      target({ tagName: "INPUT", type: "text", readOnly: true }),
    ),
    false,
  );
  assertEquals(
    isTextEditTarget(target({ tagName: "TEXTAREA", readOnly: true })),
    false,
  );
  assertEquals(
    isTextEditTarget(
      target({ tagName: "INPUT", type: "text", disabled: true }),
    ),
    false,
  );
});

/** Helper: a key event as the guard reads it off the DOM. */
function key(props: Partial<BackspaceEvent>): BackspaceEvent {
  return {
    key: "Backspace",
    defaultPrevented: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    ...props,
  };
}

Deno.test("shouldSwallowBackspace: the settings dialog survives Backspace", () => {
  // The report: with the server list open, Backspace that is not a text
  // edit must not reach the WebView's history. Shift is deliberately not
  // consulted — WebKit walks *forward* on Shift+Backspace, and that would
  // reload the app just the same.
  const panel = target({ tagName: "DIV" }); // the dialog body
  assertEquals(shouldSwallowBackspace(key({}), panel), true);
  assertEquals(
    shouldSwallowBackspace(key({}), target({ tagName: "BUTTON" })),
    true,
  );
  // Selected static text (the current server URL, a test result, ...).
  assertEquals(
    shouldSwallowBackspace(key({}), target({ tagName: "P" })),
    true,
  );
});

Deno.test("shouldSwallowBackspace: text editing is never touched", () => {
  // The URL field of the server card, where the user corrects a typo.
  const url = target({ tagName: "INPUT", type: "url" });
  assertEquals(shouldSwallowBackspace(key({}), url), false);
  assertEquals(
    shouldSwallowBackspace(key({}), target({ tagName: "TEXTAREA" })),
    false,
  );
  // A widget that consumed the key itself (the folder browser's "go up").
  assertEquals(
    shouldSwallowBackspace(
      key({ defaultPrevented: true }),
      target({ tagName: "DIV" }),
    ),
    false,
  );
  // Shortcuts WebKit does not navigate for.
  assertEquals(shouldSwallowBackspace(key({ metaKey: true }), url), false);
  assertEquals(shouldSwallowBackspace(key({ ctrlKey: true }), url), false);
  assertEquals(shouldSwallowBackspace(key({ altKey: true }), url), false);
  // Every other key stays as it is.
  assertEquals(shouldSwallowBackspace(key({ key: "Delete" }), url), false);
  assertEquals(shouldSwallowBackspace(key({ key: "ArrowLeft" }), url), false);
});
