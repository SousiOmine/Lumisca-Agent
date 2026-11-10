import { assert, assertStringIncludes } from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import { summarizeContextUsage } from "@lumisca/core/shared";
import { EMPTY_DRAFT } from "../hooks/useDrafts.ts";
import type { SessionActions } from "../hooks/useSessionActions.ts";
import { emptyView, type SessionInfo } from "../types.ts";
import { DraftPane, SessionPane } from "./SessionPane.tsx";

/**
 * What the panes owe the App: every open tab keeps its screen mounted, and the
 * one the address does not name is *hidden*, not dropped. The DOM is the whole
 * point of the design — a switch that rebuilt it is what made switching a long
 * transcript slow (see SessionPane) — so the attribute and the kept transcript
 * are asserted here rather than a timing.
 */

const INFO: SessionInfo = {
  id: "s1",
  workspaceId: "w1",
  name: "s",
  modelProvider: "p",
  modelId: "m",
  createdAt: 1,
  updatedAt: 1,
};

/** The actions a pane calls. Each takes the tab key it belongs to; none of
 * them is reached by a render. */
const ACTIONS: SessionActions = {
  prompt: () => Promise.resolve(),
  abort: () => {},
  answer: () => Promise.resolve(),
  rewind: () => Promise.resolve(),
  compact: () => {},
  changeModel: () => Promise.resolve(),
  changeThinkingLevel: () => Promise.resolve(),
};

/** The pane's own opening tag: the `hidden` attribute is what keeps an
 * inactive pane out of layout (and out of the accessibility tree), so it is
 * asserted on the root rather than anywhere in the markup — the composer's
 * file input carries its own `hidden`. */
function rootTag(html: string): string {
  return html.slice(0, html.indexOf(">") + 1);
}

function render(active: boolean): string {
  const view = emptyView(INFO, {
    messages: [{
      role: "user",
      content: "hidden but still drawn",
      timestamp: 1,
    }],
    older: null,
    usage: summarizeContextUsage([]),
  });
  return renderToString(createElement(SessionPane, {
    tabKey: INFO.id,
    view,
    active,
    draft: EMPTY_DRAFT,
    loadingOlder: false,
    actions: ACTIONS,
    loadOlder: () => false,
    updateDraft: () => {},
    onOpenSettings: () => {},
  }));
}

Deno.test("SessionPane: a pane behind another tab is hidden, not rebuilt", () => {
  const html = render(false);
  // `hidden` is the whole switch: the element stays, its layout and paint do
  // not (`.chat[hidden] { display: none }`, pinned by styles_test.ts).
  assert(rootTag(html).includes(" hidden"));
  // Kept mounted: the transcript the reader will come back to is still here,
  // so coming back costs no render (the loaded window is up to 200 rows).
  assertStringIncludes(html, "hidden but still drawn");
});

Deno.test("SessionPane: the pane the address names is the one on screen", () => {
  const html = render(true);
  assertStringIncludes(rootTag(html), 'class="chat"');
  assert(!rootTag(html).includes("hidden"));
});

Deno.test("DraftPane: the new-session screen is hidden the same way", () => {
  const props = {
    draft: EMPTY_DRAFT,
    workspaces: [],
    workspacesLoaded: true,
    settingsVersion: 0,
    updateDraft: () => {},
    clearDraft: () => {},
    startSession: () => Promise.resolve(),
    onWorkspaceChanged: () => {},
    onDeleteWorkspace: () => Promise.resolve(),
    onReopenSession: () => {},
    onOpenSettings: () => {},
  };
  const hidden = renderToString(
    createElement(DraftPane, { ...props, active: false }),
  );
  assert(rootTag(hidden).includes(" hidden"));
  const shown = renderToString(
    createElement(DraftPane, { ...props, active: true }),
  );
  assertStringIncludes(rootTag(shown), 'class="chat"');
  assert(!rootTag(shown).includes("hidden"));
});
