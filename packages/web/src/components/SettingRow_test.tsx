import { assertEquals, assertStringIncludes } from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import { SettingRow, Toggle } from "./SettingRow.tsx";

Deno.test("Toggle renders the switch markup the styles expect", () => {
  const html = renderToString(
    createElement(Toggle, {
      checked: true,
      onChange: () => {},
      label: "Computer use",
    }),
  );
  assertStringIncludes(html, 'class="toggle-switch"');
  assertStringIncludes(html, 'class="toggle-slider"');
  assertStringIncludes(html, 'type="checkbox"');
  // The accessible name: the row's label, not a second visible string.
  assertStringIncludes(html, 'aria-label="Computer use"');
  assertStringIncludes(html, "checked");
});

Deno.test("Toggle can be disabled (a load in flight)", () => {
  const html = renderToString(
    createElement(Toggle, {
      checked: false,
      disabled: true,
      onChange: () => {},
      label: "x",
    }),
  );
  assertStringIncludes(html, "disabled");
});

Deno.test("SettingRow keeps label, description and control in one row", () => {
  const html = renderToString(
    createElement(
      SettingRow,
      { label: "自動更新", description: "起動後と 6 時間ごと" },
      createElement("span", { className: "mono" }, "v1.2.3"),
    ),
  );
  assertStringIncludes(html, 'class="update-item"');
  assertStringIncludes(html, 'class="update-label"');
  assertStringIncludes(html, 'class="update-desc"');
  assertStringIncludes(html, "自動更新");
  assertStringIncludes(html, "v1.2.3");
});

Deno.test("SettingRow without a description renders one line", () => {
  const html = renderToString(
    createElement(SettingRow, { label: "一行" }, null),
  );
  assertStringIncludes(html, "一行");
  // No empty description element: it would add a gap under the label.
  assertEquals(html.includes("update-desc"), false);
});
