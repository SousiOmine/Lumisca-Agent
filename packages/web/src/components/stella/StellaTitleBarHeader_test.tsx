import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import { initLocale } from "../../i18n.ts";
import type { StellaAgentSummary } from "../../types.ts";
import { StellaTitleBarHeader } from "./StellaTitleBarHeader.tsx";

/** One agent, named so the header has something to show. */
const agent: StellaAgentSummary = {
  id: "a1",
  name: "Aide",
  icon: "",
  model: null,
  createdAt: 0,
  updatedAt: 0,
  preview: null,
};

function render(
  overrides: {
    agent?: StellaAgentSummary | null;
    onBack?: () => void;
    onEditAgent?: () => void;
    onToggleScreen?: () => void;
    screenOpen?: boolean;
  } = {},
): string {
  initLocale("ja");
  return renderToString(
    createElement(StellaTitleBarHeader, {
      agent: overrides.agent === undefined ? agent : overrides.agent,
      onEditAgent: overrides.onEditAgent ?? (() => {}),
      ...(overrides.onBack === undefined ? {} : { onBack: overrides.onBack }),
      ...(overrides.onToggleScreen === undefined
        ? {}
        : { onToggleScreen: overrides.onToggleScreen }),
      screenOpen: overrides.screenOpen ?? false,
    }),
  );
}

/** The toggle's opening tag, or "" when it is not drawn. The attributes come
 * out in render order (not source order), so the tag is located by the class
 * it carries. */
function toggleTag(html: string): string {
  const at = html.indexOf("stella-screen-toggle");
  if (at < 0) return "";
  const start = html.lastIndexOf("<button", at);
  return html.slice(start, html.indexOf(">", at) + 1);
}

Deno.test("StellaTitleBarHeader: the open agent is the title", () => {
  const html = render();
  // The face and the name are the two things a message app puts at the top
  // of a conversation, and both are the agent's.
  assertStringIncludes(html, "stella-titlebar");
  assertStringIncludes(html, "stella-titlebar-avatar");
  assertStringIncludes(html, ">Aide</h1>");
  // The app's own name is not beside it: this strip names the conversation,
  // and the mode's name in the corner would name a setting, not the window.
  assertEquals(html.includes("Lumisca Agent"), false);
});

Deno.test("StellaTitleBarHeader: with nothing picked the strip names nothing", () => {
  // The phone's list screen and the first run both have no open agent. The
  // app's own name stood here, and a window already framed as Lumisca Agent
  // was naming itself twice; the strip is a drag surface and the controls'
  // row then, not a caption. There is no face to edit, either.
  const html = render({ agent: null });
  assertEquals(html.includes("stella-titlebar-name"), false);
  assertEquals(html.includes("Lumisca Agent"), false);
  assertEquals(html.includes("stella-titlebar-avatar"), false);
  assertEquals(html.includes("stella-back"), false);
});

Deno.test("StellaTitleBarHeader: the info toggle is drawn while a conversation is open", () => {
  const onToggle = () => {};
  const running = render({ onToggleScreen: onToggle });
  const tag = toggleTag(running);
  assert(tag !== "", "the toggle is missing while a conversation is open");
  // Closed reads as "not pressed" *and* as the crossed-out monitor; the
  // label says what the next click does.
  assertStringIncludes(tag, 'aria-pressed="false"');
  assertStringIncludes(tag, 'title="情報を表示"');
  assert(!tag.includes(" on "), `closed must not carry .on: ${tag}`);
  assertStringIncludes(running, "tabler-icon-device-desktop-off");

  // Open: pressed, the monitor itself, and the label names the other way.
  const open = render({ onToggleScreen: onToggle, screenOpen: true });
  const openTag = toggleTag(open);
  assertStringIncludes(openTag, 'aria-pressed="true"');
  assertStringIncludes(openTag, 'title="情報を隠す"');
  assertStringIncludes(open, 'tabler-icon-device-desktop"');
});

Deno.test("StellaTitleBarHeader: the toggle exists while a conversation is open", () => {
  // The panel now holds what the conversation can reach (a lent folder) as
  // well as the screen, so a starting machine is no reason to withhold it.
  assertStringIncludes(
    toggleTag(render({ onToggleScreen: () => {} })),
    "stella-screen-toggle",
  );
  // A caller that offers no toggle at all (no conversation, or a hand-over
  // owns the pane) gets no button.
  assertEquals(toggleTag(render()), "");
});

Deno.test("StellaTitleBarHeader: the machine's state is not drawn here", () => {
  // A reason is a sentence ("podman is not available: ..."), and this strip
  // is one line holding a name. The strip says who the conversation is with;
  // why the machine is down belongs to StellaView, which has the room.
  const html = render();
  assertEquals(html.includes("stella-note"), false);
  assertEquals(html.includes('role="alert"'), false);
});

Deno.test("StellaTitleBarHeader: the back button appears only when the caller gives one", () => {
  // A phone has one screen at a time, so the way back to the list is a
  // control on the conversation. A wide window has the list beside it, and
  // a back button there would point at something already visible — which is
  // why its absence is decided by the caller, not by CSS.
  assertEquals(render().includes("stella-back"), false);
  const narrow = render({ onBack: () => {} });
  assertStringIncludes(narrow, "stella-back");
  assertStringIncludes(narrow, "エージェント一覧に戻る");
});
