import { test } from "bun:test";
import { appComponentNames, UI_APP_COMPONENTS } from "@lumisca/core/shared";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import { initLocale } from "../../i18n.ts";
import { AppCard } from "./AppCard.tsx";
import { appComponents } from "./app-components.tsx";

function spec(): string {
  return JSON.stringify({
    version: 1,
    title: "Tasks",
    state: {
      draft: "",
      tab: "A",
      items: [{ name: "Estimate", done: false }],
    },
    root: "screen",
    elements: {
      screen: {
        type: "Screen",
        children: ["heading", "input", "button", "list", "tabs"],
      },
      heading: { type: "Heading", props: { text: "Tasks" } },
      input: {
        type: "Input",
        props: {
          placeholder: "New task",
          value: { $bindState: "/draft" },
        },
      },
      button: {
        type: "Button",
        props: { label: "Add" },
        on: {
          press: {
            action: "sendMessage",
            text: { $template: "Add ${/draft}" },
          },
        },
      },
      list: {
        type: "Repeat",
        props: { over: { $state: "/items" } },
        children: ["row"],
      },
      row: {
        type: "Text",
        props: { text: { $template: "${item.name}" } },
      },
      tabs: {
        type: "Tabs",
        props: { value: { $bindState: "/tab" } },
        children: ["tabA", "tabB"],
      },
      tabA: { type: "Tab", props: { label: "A" }, children: ["textA"] },
      textA: { type: "Text", props: { text: "A content" } },
      tabB: { type: "Tab", props: { label: "B" }, children: ["textB"] },
      textB: { type: "Text", props: { text: "B content" } },
    },
  });
}

function render(json: string, onSend?: (text: string) => void): string {
  initLocale("ja");
  return renderToString(
    createElement(AppCard, {
      json,
      ...(onSend === undefined ? {} : { onSend }),
    }),
  );
}

test("AppCard: a valid spec draws its title and active tab", () => {
  const html = render(spec(), () => {});
  assertStringIncludes(html, "app-card");
  assertStringIncludes(html, "Tasks");
  assertStringIncludes(html, "app-heading");
  assertStringIncludes(html, "app-input");
  assertStringIncludes(html, "app-button");
  assertStringIncludes(html, "Estimate");
  assertStringIncludes(html, "A content");
  assertEquals(html.includes("B content"), false);
  assertStringIncludes(html, "app-tabs");
});

test("AppCard: a read-only conversation draws its controls disabled", () => {
  const html = render(spec());
  assertStringIncludes(html, "app-button");
  assertStringIncludes(html, "disabled");
});

test("AppCard: an invalid spec keeps the source and the reason", () => {
  const html = render('{"version":1}');
  assertStringIncludes(html, "app-card-invalid");
  assertStringIncludes(html, "このUIを表示できませんでした");
  assertStringIncludes(html, "app-card-problem");
  assertStringIncludes(html, "app-card-source");
});

test("AppCard: a streaming spec that cannot parse is a skeleton", () => {
  initLocale("ja");
  const html = renderToString(
    createElement(AppCard, {
      json: '{"version":1',
      streaming: true,
    }),
  );
  assertStringIncludes(html, "app-card-building");
  assertStringIncludes(html, "UIを組み立てています");
});

test("AppCard: every catalog component has a renderer", () => {
  assertEquals(appComponentNames().sort(), Object.keys(appComponents).sort());
  assertEquals(UI_APP_COMPONENTS.length, Object.keys(appComponents).length);
});
