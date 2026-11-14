import {
  parseUiMarkup,
  resolveUiView,
  type UiResolvedView,
} from "@lumisca/core/shared";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import { initLocale } from "../../i18n.ts";
import { InvalidCard, UiCard } from "./UiCard.tsx";

/**
 * Drawing a card.
 *
 * What reaches the component is the RESOLVED view — the server refuses a card
 * these functions cannot read, so the renderer never sees a bind. The cases
 * here are about what the reader gets: the blocks in the order written, the
 * repeats already expanded, and one note instead of half a card.
 */

function viewOf(markup: string): UiResolvedView {
  const parsed = parseUiMarkup(markup);
  if (!parsed.ok) throw new Error(`could not read it: ${parsed.problem}`);
  return resolveUiView(parsed.view);
}

function draw(view: UiResolvedView): string {
  initLocale("ja");
  return renderToString(createElement(UiCard, { view, onSend: () => {} }));
}

Deno.test("UiCard draws a metric beside another in a row of columns", () => {
  const html = draw(
    viewOf(`<Card title="状況">
      <Columns gap="m">
        <Metric label="本番" value="81" unit="%" hint="+3.2%" />
        <Metric label="検証" value="42" unit="%" />
      </Columns>
    </Card>`),
  );

  assertStringIncludes(html, "ui-card-columns");
  assertStringIncludes(html, "本番");
  assertStringIncludes(html, "81");
  assertStringIncludes(html, "ui-card-metric-unit");
  assertStringIncludes(html, "+3.2%");
  const first = html.indexOf("本番");
  const second = html.indexOf("検証");
  assertEquals(first !== -1 && second > first, true, html);
});

Deno.test("UiCard draws a repeated block once per item", () => {
  const html = draw(
    viewOf(`<Card>
      <Data>{"envs":[{"name":"prod","load":81},{"name":"stg","load":42}]}</Data>
      <Repeat over="envs"><Text>$item.name: $item.load</Text></Repeat>
    </Card>`),
  );

  assertStringIncludes(html, "prod: 81");
  assertStringIncludes(html, "stg: 42");
  assertEquals(html.includes("$item"), false, html);
});

Deno.test("UiCard draws a grid on its columns and stacks the rest", () => {
  const html = draw(
    viewOf(`<Card>
      <Grid columns="3"><Text>a</Text><Text>b</Text></Grid>
      <Stack gap="s"><Text>c</Text><Text>d</Text></Stack>
    </Card>`),
  );

  assertStringIncludes(html, 'class="ui-card-grid"');
  assertStringIncludes(html, 'data-columns="3"');
  assertStringIncludes(html, 'class="ui-card-stack"');
  assertStringIncludes(html, 'data-gap="s"');
});

Deno.test("UiCard draws a choice as a row of buttons when asked", () => {
  const html = draw(
    viewOf(
      '<Card><Choice layout="row"><Option>再実行</Option><Option>中止</Option></Choice></Card>',
    ),
  );

  assertStringIncludes(html, 'data-layout="row"');
  assertStringIncludes(html, "再実行");
  assertStringIncludes(html, "中止");
});

Deno.test("InvalidCard keeps a card's markup behind the note", () => {
  initLocale("ja");
  const markup = '<Card><Metric label="本番" value="81" /></Card>trailing';
  const html = renderToString(createElement(InvalidCard, { markup }));

  assertStringIncludes(html, "ui-card-invalid");
  assertStringIncludes(html, "このカードを表示できませんでした");
  assertStringIncludes(html, "マークアップ");
  // The source is the agent's words: whatever it wrote stays readable.
  assertStringIncludes(html, "&lt;Card>");
  assertEquals(html.includes("ui-card-metric"), false);
  assert(html.length > 0);
});

Deno.test("UiCard draws the line a field carries under its input", () => {
  const html = draw(
    viewOf(`<Card><Form submit="送る">
      <Field label="日時" required>毎週の曜日と時間帯を書いてください</Field>
    </Form></Card>`),
  );

  assertStringIncludes(html, "ui-card-field-desc");
  assertStringIncludes(html, "毎週の曜日と時間帯を書いてください");
  assertEquals(html.includes("$item"), false, html);
});
