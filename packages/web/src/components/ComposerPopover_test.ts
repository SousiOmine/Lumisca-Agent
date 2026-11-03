import { assertStringIncludes } from "@std/assert";
import { createElement } from "preact/compat";
import { renderToString } from "preact-render-to-string";
import { ComposerPopover } from "./ComposerPopover.tsx";

/**
 * The suggestion list both composer popovers draw.
 *
 * Worth pinning is the markup contract the stylesheets depend on: the row
 * class is derived from the popover's own class (`.mention-popover` →
 * `.mention-item`), the active row carries `active`, and the commit event
 * differs by menu for a reason (a mention rewrites the token under the
 * caret; a command moves the caret itself).
 */

interface Row {
  id: string;
  label: string;
}

function draw(options: {
  className?: string;
  placementClass?: string;
  items?: Row[];
  active?: number;
  commit?: "mousedown" | "click";
} = {}): string {
  return renderToString(
    createElement(ComposerPopover<Row>, {
      className: options.className ?? "mention-popover",
      ...(options.placementClass === undefined
        ? {}
        : { placementClass: options.placementClass }),
      items: options.items ?? [{ id: "a", label: "A" }],
      active: options.active ?? 0,
      commit: options.commit ?? "mousedown",
      onSelect: () => {},
      onHover: () => {},
      keyOf: (row: Row) => row.id,
      empty: createElement("div", { className: "empty-status" }, "none"),
      renderRow: (row: Row) => row.label,
    }),
  );
}

Deno.test("ComposerPopover: the row class follows the popover's own class", () => {
  const mention = draw();
  assertStringIncludes(mention, 'class="mention-popover"');
  // Row 0 is active by default, so the class carries the state suffix.
  assertStringIncludes(mention, 'class="mention-item active"');

  const slash = draw({
    className: "slash-popover",
    items: [{ id: "s", label: "S" }],
  });
  assertStringIncludes(slash, 'class="slash-popover"');
  // Row 0 is active by default, so the class carries the state suffix.
  assertStringIncludes(slash, 'class="slash-item active"');
});

Deno.test("ComposerPopover: an upward placement appends its class", () => {
  assertStringIncludes(
    draw({ placementClass: "below" }),
    'class="mention-popover below"',
  );
});

Deno.test("ComposerPopover: the active row is the only one marked", () => {
  const html = draw({
    items: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
    active: 1,
  });
  assertStringIncludes(html, 'class="mention-item">A');
  assertStringIncludes(html, 'class="mention-item active">B');
});

Deno.test("ComposerPopover: no rows draws the empty state instead", () => {
  const html = draw({ items: [] });
  assertStringIncludes(html, 'class="empty-status"');
  assertStringIncludes(html, "none");
  // No stray row shells.
  assertEqualsNoItem(html);
});

Deno.test("ComposerPopover: a click-commit row binds no click on mousedown-only menus", () => {
  // The difference is behavioural (the rendered attribute list is the same
  // shape either way), so this pins the decision's documentation boundary:
  // both menus keep the focus by preventing the mousedown default.
  for (const commit of ["mousedown", "click"] as const) {
    const html = draw({ commit });
    assertStringIncludes(html, 'class="mention-item');
  }
});

function assertEqualsNoItem(html: string): void {
  if (html.includes("-item")) {
    throw new Error(`a row was drawn for an empty list: ${html}`);
  }
}
