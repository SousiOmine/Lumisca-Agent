import { assertEquals, assertStringIncludes } from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import type { ThinkingLevel } from "../types.ts";
import { ThinkingLevelSelect } from "./ThinkingLevelSelect.tsx";

/**
 * The thinking control is the app's own dropdown (components/Select.tsx), so
 * what is worth pinning is the decision it makes: which level it names, and
 * when it is not there at all. The catalogue's default language is Japanese,
 * which is the label these assertions read.
 */

function draw(
  value: ThinkingLevel,
  levels: ThinkingLevel[],
): string {
  return renderToString(
    createElement(ThinkingLevelSelect, {
      value,
      levels,
      onChange: () => {},
    }),
  );
}

Deno.test("ThinkingLevelSelect: the current level is the trigger's text", () => {
  const html = draw("high", ["off", "low", "high"]);
  assertStringIncludes(html, 'class="select"');
  assertStringIncludes(html, 'class="select-trigger"');
  assertStringIncludes(html, "高");
  // The accessible name says what the control is, not which value it holds.
  assertStringIncludes(html, 'aria-label="推論強度（思考レベル）"');
});

Deno.test("ThinkingLevelSelect: nothing to choose draws nothing", () => {
  // A model without levels has no choice to offer: a disabled control would
  // take a row in the composer's footer and answer nothing.
  assertEquals(draw("off", []), "");
  assertEquals(draw("off", ["off"]), "");
});

Deno.test("ThinkingLevelSelect: an unsupported stored level shows the nearest one", () => {
  // The catalog changed, or another client wrote a level this model no longer
  // accepts: the trigger must not name a choice that is missing from its own
  // list.
  assertStringIncludes(draw("max", ["off", "low", "high"]), "高");
  // …and a level between two supported ones lands on the closer one.
  assertStringIncludes(draw("minimal", ["off", "high"]), "オフ");
});
