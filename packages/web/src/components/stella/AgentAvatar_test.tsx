import { assertEquals, assertStringIncludes } from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import { initLocale } from "../../i18n.ts";
import { AgentAvatar } from "./AgentAvatar.tsx";

/**
 * The agent's face: the picture when it has one, the initial on a derived
 * colour when it does not.
 *
 * What is checked is the contract the rest of the UI relies on — the URL an
 * icon resolves to, and that a missing one draws a letter rather than an
 * empty circle (a broken avatar looks like a bug, not like "no picture yet").
 */

const AGENT = "6f0c1f9e-2a44-4f4d-9f0e-8a3b7c5d1e2f";

function render(
  props: {
    agentId?: string;
    name: string;
    icon: string;
    size?: number;
  },
): string {
  initLocale("ja");
  return renderToString(
    createElement(AgentAvatar, {
      agentId: props.agentId ?? AGENT,
      name: props.name,
      icon: props.icon,
      size: props.size ?? 20,
    }),
  );
}

Deno.test("AgentAvatar: a stored picture is drawn from the agent's route", () => {
  const html = render({ name: "Aide", icon: "9f3c2a1b4d5e.png" });
  assertStringIncludes(
    html,
    `src="/api/stella/agents/${AGENT}/icon/9f3c2a1b4d5e.png"`,
  );
  // Decorative: the name is right next to it in every surface that draws
  // one, so the image carries no alternative text of its own. Preact writes
  // an empty string attribute without a value (`alt`), which is still the
  // empty alt the accessibility rule asks for.
  assertStringIncludes(html, " alt");
  assertEquals(/alt="[^"]+"/.test(html), false);
  assertStringIncludes(html, "agent-avatar");
});

Deno.test("AgentAvatar: without a picture it draws the name's initial", () => {
  const html = render({ name: "aide", icon: "" });
  // Uppercased, because a lowercase initial reads as a truncated word.
  assertStringIncludes(html, ">A<");
  assertStringIncludes(html, "agent-avatar-initial");
  // Hidden from a screen reader: "A" before "Aide" is noise.
  assertStringIncludes(html, 'aria-hidden="true"');
  // No image element at all — an <img> with no source is the broken-icon
  // state, which reads as an error rather than as "no picture yet".
  assertStringIncludes(html.includes("<img") ? "has-img" : "no-img", "no-img");
});

Deno.test("AgentAvatar: the colour is the id's, as a CSS variable", () => {
  const html = render({ name: "Aide", icon: "" });
  // The hue reaches the stylesheet as a variable (styles/README.md: dynamic
  // values go through CSS variables, never an inline colour), so the rule
  // that paints the circle stays in stella.css.
  assertStringIncludes(html, "--agent-avatar-hue:");
  // Two different agents do not share one colour.
  const other = render({ agentId: "other-agent", name: "Aide", icon: "" });
  const hueOf = (markup: string): string =>
    markup.match(/--agent-avatar-hue:\s*(\d+)/)?.[1] ?? "";
  assertStringIncludes(
    hueOf(html) === hueOf(other) ? "same" : "differs",
    "differs",
  );
});

Deno.test("AgentAvatar: the size is the caller's, on the element", () => {
  const html = render({ name: "Aide", icon: "", size: 72 });
  assertStringIncludes(html, "width:72px");
  assertStringIncludes(html, "height:72px");
  // The initial scales with the circle rather than staying at one size.
  assertStringIncludes(html, "font-size:32px");
});
