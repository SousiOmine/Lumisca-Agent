/**
 * stella's screen and which of its two surfaces it says is showing.
 *
 * The attribute is the one thing the stylesheet and the layout agree on, so it
 * is worth a check of its own: the two columns of a wide window and the two
 * screens of a phone both read it (stella.css), and the wrong answer draws the
 * wrong surface without any error anywhere.
 */
import { assertStringIncludes } from "@std/assert";
import { renderToString } from "preact-render-to-string";
import { initLocale } from "../i18n.ts";
import type { StellaHook } from "../hooks/useStella.ts";
import { emptyStellaState } from "../stella-state.ts";
import type { StellaAgentSummary } from "../types.ts";
import { StellaModeScreen } from "./StellaModeScreen.tsx";

const agent: StellaAgentSummary = {
  id: "a1",
  name: "Aide",
  icon: "",
  model: null,
  createdAt: 0,
  updatedAt: 0,
  preview: null,
};

/** Everything the hook answers. Rendering this screen talks to no server, so
 * the actions are no-ops here; the two fields under test come from the caller. */
function hook(overrides: Partial<StellaHook>): StellaHook {
  return {
    agents: [agent],
    agentsLoading: false,
    activeAgentId: null,
    conversation: null,
    sessionId: null,
    prompt: () => Promise.resolve(),
    abort: () => {},
    answer: () => Promise.resolve(),
    rewind: () => Promise.resolve(),
    finishHandover: () => Promise.resolve(),
    loadOlder: () => false,
    loadingOlder: false,
    error: null,
    loading: false,
    reloadAgents: () => {},
    replaceAgent: () => {},
    ...overrides,
  };
}

function render(stella: StellaHook): string {
  initLocale("ja");
  return renderToString(
    <StellaModeScreen
      stella={stella}
      agent={stella.activeAgentId === null ? null : agent}
      status={null}
      input=""
      onInputChange={() => {}}
      images={[]}
      onImagesChange={() => {}}
      files={[]}
      onFilesChange={() => {}}
      onAgentChanged={() => {}}
      onSelectAgent={() => {}}
      onOpenSettings={() => {}}
      screenOpen={false}
      onScreenOpenChange={() => {}}
    />,
  );
}

Deno.test("StellaModeScreen: nobody picked is the list", () => {
  // The answer is the selection's, not the window's: asked of the viewport, a
  // wide window would say "list" while a conversation is open — and the
  // stylesheet hides the conversation for that value, so the agent the reader
  // just picked would not appear.
  assertStringIncludes(
    render(hook({ activeAgentId: null })),
    'data-screen="list"',
  );
});

Deno.test("StellaModeScreen: a picked agent is the conversation", () => {
  assertStringIncludes(
    render(hook({
      activeAgentId: "a1",
      conversation: emptyStellaState("Aide"),
      sessionId: "s1",
    })),
    'data-screen="conversation"',
  );
});
