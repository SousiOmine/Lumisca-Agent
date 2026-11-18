import { test } from "bun:test";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import { initLocale } from "../../i18n.ts";
import { ServerStep } from "./ServerStep.tsx";

test("the connection screen asks for a server and keeps the local walk quiet", () => {
  initLocale("ja");
  const html = renderToString(
    createElement(ServerStep, { onUseLocal: () => {} }),
  );
  assertStringIncludes(html, "サーバーに接続");
  assertStringIncludes(html, "認証トークン");
  assertStringIncludes(html, "ローカルでセットアップを続行");
  // The screen is the choice and its fields: the three explanatory lines it
  // once carried are gone.
  assertEquals(html.includes("別のPCやサーバーで動いている"), false);
  assertEquals(html.includes("認証トークンは、接続先のサーバー"), false);
  assertEquals(html.includes("プロバイダーとモデルを設定します"), false);
  // The form's one primary move, and the way into the local walk as a plain
  // button rather than a second filled capsule.
  assertStringIncludes(html, 'type="submit"');
  assertStringIncludes(html, 'class="btn setup-local"');
});
