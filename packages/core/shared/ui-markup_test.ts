import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import {
  CARD_HELP,
  interactiveBlock,
  parseUiMarkup,
  parseUiMarkupPartial,
  resolveUiView,
  segmentsText,
  splitChatText,
  type UiView,
} from "./ui-markup/index.ts";
import { BLOCK_TAGS } from "./ui-markup/reader.ts";

/**
 * Reading the UI markup.
 *
 * The screen reads a card with these functions, and the server cuts the card
 * out of a message's text with the same module (./ui-markup/segments.ts), so
 * the grammar's promises are pinned down here, in one place.
 */

function viewOf(markup: string): UiView {
  const result = parseUiMarkup(markup);
  if (!result.ok) throw new Error(`could not read it: ${result.problem}`);
  return result.view;
}

function problemOfPartial(markup: string): string {
  const result = parseUiMarkupPartial(markup);
  if (result.ok) throw new Error("the markup was accepted");
  return result.problem;
}

function problemOf(markup: string): string {
  const result = parseUiMarkup(markup);
  if (result.ok) throw new Error("the markup was accepted");
  return result.problem;
}

Deno.test("parseUiMarkup reads a card's blocks in the order written", () => {
  const view = viewOf(`<Card title="リリース">
      <Text>確認してください。</Text>
      <List ordered><Item>テスト</Item><Item>公開</Item></List>
      <Table><Row><Cell>名前</Cell><Cell>値</Cell></Row><Row><Cell>a</Cell><Cell>1</Cell></Row></Table>
      <Flow>
        <Node id="start" shape="pill">開始</Node>
        <Node id="check" shape="diamond">成功?</Node>
        <Edge from="start" to="check" label="次へ" dashed />
      </Flow>
      <Choice multiple>
        <Option description="短い確認">スモーク</Option>
        <Option>全テスト</Option>
      </Choice>
    </Card>`);

  assertEquals(view.title, "リリース");
  assertEquals(view.blocks, [
    { type: "text", text: "確認してください。" },
    { type: "list", ordered: true, items: ["テスト", "公開"] },
    {
      type: "table",
      rows: [
        ["名前", "値"],
        ["a", "1"],
      ],
    },
    {
      type: "flow",
      nodes: [
        { id: "start", label: "開始", shape: "pill" },
        { id: "check", label: "成功?", shape: "diamond" },
      ],
      edges: [{ from: "start", to: "check", label: "次へ", dashed: true }],
    },
    {
      type: "choice",
      layout: "list",
      multiple: true,
      options: [
        { label: "スモーク", description: "短い確認" },
        { label: "全テスト", description: null },
      ],
    },
  ]);
});

Deno.test("parseUiMarkup omits the title and the optional attributes", () => {
  const view = viewOf("<Card><List><Item>a</Item></List></Card>");

  assertEquals(view.title, null);
  assertEquals(view.blocks, [{ type: "list", ordered: false, items: ["a"] }]);
});

Deno.test("parseUiMarkup drops the shared indentation and the outer space", () => {
  const view = viewOf(`<Card><Text>
      1 行目
       2 行目
    </Text></Card>`);

  assertEquals(view.blocks, [{ type: "text", text: "1 行目\n 2 行目" }]);
});

Deno.test("parseUiMarkup decodes entities back into characters", () => {
  const view = viewOf(
    '<Card title="A &amp; B"><Text>a &lt; b &amp;&amp; c &quot;d&quot;</Text></Card>',
  );

  assertEquals(view.title, "A & B");
  assertEquals(view.blocks, [{ type: "text", text: 'a < b && c "d"' }]);
});

Deno.test("parseUiMarkup reads a form's fields", () => {
  const view = viewOf(`<Card><Form submit="送る">
      <Field label="名前" required placeholder="例: Tera" />
      <Field label="数" type="number" />
      <Field label="プラン" type="select"><Option>無料</Option><Option>Pro</Option></Field>
      <Field label="同意" type="checkbox" required />
      <Field label="日時">毎週の曜日と時間帯を書いてください</Field>
    </Form></Card>`);

  assertEquals(view.blocks, [
    {
      type: "form",
      submit: "送る",
      fields: [
        {
          label: "名前",
          type: "text",
          required: true,
          placeholder: "例: Tera",
          description: null,
          options: [],
        },
        {
          label: "数",
          type: "number",
          required: false,
          placeholder: null,
          description: null,
          options: [],
        },
        {
          label: "プラン",
          type: "select",
          required: false,
          placeholder: null,
          description: null,
          options: [
            { label: "無料", description: null },
            { label: "Pro", description: null },
          ],
        },
        {
          label: "同意",
          type: "checkbox",
          required: true,
          placeholder: null,
          description: null,
          options: [],
        },
        {
          label: "日時",
          type: "text",
          required: false,
          placeholder: null,
          description: "毎週の曜日と時間帯を書いてください",
          options: [],
        },
      ],
    },
  ]);
});

Deno.test("interactiveBlock returns the block that sends a message", () => {
  const view = viewOf(
    "<Card><Text>a</Text><Choice><Option>a</Option><Option>b</Option></Choice></Card>",
  );
  const block = interactiveBlock(view);

  assertEquals(block?.type, "choice");
  assertEquals(interactiveBlock(viewOf("<Card><Text>a</Text></Card>")), null);
});

Deno.test("parseUiMarkup gives the same result for the same input", () => {
  const markup =
    "<Card><Text>a</Text><Choice><Option>a</Option><Option>b</Option></Choice></Card>";

  assertEquals(parseUiMarkup(markup), parseUiMarkup(markup));
});

// --- what is refused ---------------------------------------------------------

Deno.test("parseUiMarkup refuses an empty markup, a non-Card root or no blocks", () => {
  assertStringIncludes(problemOf(""), "empty");
  assertStringIncludes(problemOf("  \n "), "empty");
  assertStringIncludes(problemOf("<Text>a</Text>"), "the root must be <Card>");
  assertStringIncludes(problemOf("<Card></Card>"), "needs at least one block");
});

Deno.test("parseUiMarkup refuses unknown tags and attributes", () => {
  assertStringIncludes(
    problemOf("<Card><div>a</div></Card>"),
    "<div> is not allowed inside <Card>",
  );
  assertStringIncludes(
    problemOf('<Card foo="1"><Text>a</Text></Card>'),
    'does not take the attribute "foo"',
  );
  assertStringIncludes(
    problemOf('<Card><List foo="1"><Item>a</Item></List></Card>'),
    'does not take the attribute "foo"',
  );
});

Deno.test("parseUiMarkup refuses text written directly inside a tag", () => {
  assertStringIncludes(
    problemOf("<Card>hello</Card>"),
    "text is not allowed directly inside <Card>",
  );
});

Deno.test("parseUiMarkup reads a boolean attribute bare or as true/false", () => {
  assertEquals(
    viewOf('<Card><List ordered="true"><Item>a</Item></List></Card>').blocks[0],
    { type: "list", ordered: true, items: ["a"] },
  );
  assertEquals(
    viewOf('<Card><List ordered="false"><Item>a</Item></List></Card>')
      .blocks[0],
    { type: "list", ordered: false, items: ["a"] },
  );
  assertStringIncludes(
    problemOf('<Card><List ordered="yes"><Item>a</Item></List></Card>'),
    'written bare or given "true" or "false"',
  );
});

Deno.test("parseUiMarkup requires double quotes around an attribute", () => {
  assertStringIncludes(
    problemOf("<Card title=x><Text>a</Text></Card>"),
    "must use double quotes",
  );
  assertStringIncludes(
    problemOf('<Card title="x><Text>a</Text></Card>'),
    "is not closed",
  );
});

Deno.test("parseUiMarkup accepts exactly five entities", () => {
  assertStringIncludes(
    problemOf("<Card><Text>a &nbsp; b</Text></Card>"),
    'unknown entity "&nbsp;"',
  );
  assertStringIncludes(
    problemOf("<Card><Text>a & b</Text></Card>"),
    'write "&" as &amp;',
  );
});

Deno.test('parseUiMarkup wants "<" in prose written as an entity', () => {
  assertStringIncludes(
    problemOf("<Card><Text>a < b</Text></Card>"),
    'write "<" in text as &lt;',
  );
  // Something shaped like a tag is refused as a tag that may not sit there.
  assertStringIncludes(
    problemOf("<Card><Text>a</Text><b>x</b></Card>"),
    "<b> is not allowed inside <Card>",
  );
});

Deno.test("parseUiMarkup refuses a missing or mismatched closing tag", () => {
  assertStringIncludes(problemOf("<Card><Text>a</Card>"), "expected </Text>");
  assertStringIncludes(problemOf("<Card><Text>a"), "is not closed");
  assertStringIncludes(
    problemOf("<Card><Text>a</Text></Card>trailing"),
    "unexpected text",
  );
});

Deno.test("parseUiMarkup refuses comments", () => {
  assertStringIncludes(
    problemOf("<Card><!-- x --><Text>a</Text></Card>"),
    "comments and declarations",
  );
});

Deno.test("parseUiMarkup nests at most six levels deep", () => {
  assertStringIncludes(
    problemOf(
      "<Card><Text><Text><Text><Text><Text><Text>x</Text></Text></Text></Text></Text></Text></Card>",
    ),
    "nested deeper than 6 levels",
  );
});

Deno.test("parseUiMarkup allows one interactive block per card", () => {
  const problem = problemOf(
    "<Card><Choice><Option>a</Option><Option>b</Option></Choice><Choice><Option>a</Option><Option>b</Option></Choice></Card>",
  );
  assertStringIncludes(problem, "at most one <Choice> or <Form>");
});

Deno.test("parseUiMarkup wants at least two options in a choice", () => {
  assertStringIncludes(
    problemOf("<Card><Choice><Option>a</Option></Choice></Card>"),
    "needs at least two <Option>",
  );
});

Deno.test("parseUiMarkup wants at least one field in a form", () => {
  assertStringIncludes(
    problemOf("<Card><Form></Form></Card>"),
    "needs at least one <Field>",
  );
  assertStringIncludes(
    problemOf("<Card><Form><Field /></Form></Card>"),
    'needs the attribute "label"',
  );
});

Deno.test("parseUiMarkup wants options in a select field", () => {
  assertStringIncludes(
    problemOf('<Card><Form><Field label="a" type="select" /></Form></Card>'),
    "needs at least one <Option>",
  );
});

Deno.test("parseUiMarkup refuses an unknown field type", () => {
  assertStringIncludes(
    problemOf('<Card><Form><Field label="a" type="date" /></Form></Card>'),
    'unknown field type "date"',
  );
});

Deno.test("parseUiMarkup refuses a duplicated flow node id", () => {
  const problem = problemOf(
    '<Card><Flow><Node id="a">x</Node><Node id="a">y</Node></Flow></Card>',
  );
  assertStringIncludes(problem, 'the node id "a" is used twice');
});

Deno.test("parseUiMarkup points a flow edge at a node that exists", () => {
  const problem = problemOf(
    '<Card><Flow><Node id="a">x</Node><Edge from="a" to="b" /></Flow></Card>',
  );
  assertStringIncludes(problem, 'unknown node "b"');
});

Deno.test("parseUiMarkup refuses a flow edge to itself", () => {
  const problem = problemOf(
    '<Card><Flow><Node id="a">x</Node><Edge from="a" to="a" /></Flow></Card>',
  );
  assertStringIncludes(problem, "two different nodes");
});

Deno.test("parseUiMarkup refuses an unknown flow shape", () => {
  assertStringIncludes(
    problemOf('<Card><Flow><Node id="a" shape="star">x</Node></Flow></Card>'),
    'unknown shape "star"',
  );
});

Deno.test("parseUiMarkup refuses content inside a flow edge", () => {
  assertStringIncludes(
    problemOf(
      '<Card><Flow><Node id="a">x</Node><Edge from="a" to="b">y</Edge></Flow></Card>',
    ),
    "has no content",
  );
});

Deno.test("parseUiMarkup wants every table row to carry the same cells", () => {
  const problem = problemOf(
    "<Card><Table><Row><Cell>a</Cell><Cell>b</Cell></Row><Row><Cell>c</Cell></Row></Table></Card>",
  );
  assertStringIncludes(problem, "every row needs 2 cells");
});

Deno.test("parseUiMarkup limits the length of the whole markup", () => {
  const problem = problemOf(`<Card><Text>${"a".repeat(20_000)}</Text></Card>`);
  assertStringIncludes(problem, "the limit is 20000");
});

Deno.test("parseUiMarkup reports an error with a line and column", () => {
  const problem = problemOf("<Card>\n  <Text>a</Text>\n  <Nope />\n</Card>");
  assertMatch(problem, /^line 3, column 3:/);
});

// --- layouts, data and binds ------------------------------------------------

function resolvedOf(markup: string) {
  return resolveUiView(viewOf(markup));
}

Deno.test("parseUiMarkup reads a metric and the layouts", () => {
  const view = viewOf(`<Card>
      <Stack gap="s">
        <Columns gap="l">
          <Metric label="本番" value="81" unit="%" hint="+3.2%" />
          <Grid columns="2"><Text>a</Text><Text>b</Text></Grid>
        </Columns>
        <Text>end</Text>
      </Stack>
    </Card>`);

  assertEquals(view.blocks, [
    {
      type: "stack",
      gap: "s",
      blocks: [
        {
          type: "columns",
          gap: "l",
          blocks: [
            {
              type: "metric",
              label: "本番",
              value: "81",
              unit: "%",
              hint: "+3.2%",
            },
            {
              type: "grid",
              columns: 2,
              blocks: [
                { type: "text", text: "a" },
                { type: "text", text: "b" },
              ],
            },
          ],
        },
        { type: "text", text: "end" },
      ],
    },
  ]);
});

Deno.test("parseUiMarkup reads <Data> as plain JSON", () => {
  const view = viewOf(
    '<Card><Data>{"envs":[{"name":"prod"}],"note":"a < b & c"}</Data><Text>x</Text></Card>',
  );

  assertEquals(view.data, {
    envs: [{ name: "prod" }],
    note: "a < b & c",
  });
});

Deno.test("resolveUiView repeats a block once per item", () => {
  const view = resolvedOf(`<Card>
      <Data>{"total":2,"envs":[{"name":"prod","load":81},{"name":"stg","load":42}]}</Data>
      <Columns gap="m">
        <Repeat over="envs">
          <Metric label="$item.name" value="$item.load" unit="%" />
        </Repeat>
      </Columns>
      <Text>全 $data.total 件</Text>
    </Card>`);

  assertEquals(view.blocks, [
    {
      type: "columns",
      gap: "m",
      blocks: [
        { type: "metric", label: "prod", value: "81", unit: "%", hint: null },
        { type: "metric", label: "stg", value: "42", unit: "%", hint: null },
      ],
    },
    { type: "text", text: "全 2 件" },
  ]);
});

Deno.test("resolveUiView draws an <If> only for a matching item", () => {
  const view = resolvedOf(`<Card>
      <Data>{"envs":[{"name":"prod","load":81},{"name":"stg","load":42}]}</Data>
      <Repeat over="envs">
        <If test="$item.load" eq="81"><Text>$item.name</Text></If>
      </Repeat>
    </Card>`);

  assertEquals(view.blocks, [{ type: "text", text: "prod" }]);
});

Deno.test("resolveUiView counts the items and keeps $$ literal", () => {
  const view = resolvedOf(`<Card>
      <Data>{"price":100,"items":["a","b"]}</Data>
      <Repeat over="items"><Text>$index: $item</Text></Repeat>
      <Text>$$data.price と $data.price</Text>
    </Card>`);

  assertEquals(view.blocks, [
    { type: "text", text: "0: a" },
    { type: "text", text: "1: b" },
    { type: "text", text: "$data.price と 100" },
  ]);
});

Deno.test("interactiveBlock finds a choice inside a layout", () => {
  const view = viewOf(
    "<Card><Stack><Choice><Option>a</Option><Option>b</Option></Choice></Stack></Card>",
  );

  assertEquals(interactiveBlock(view)?.type, "choice");
});

Deno.test("CARD_HELP names every tag a card may carry", () => {
  assertStringIncludes(CARD_HELP, "<Card");
  assertStringIncludes(CARD_HELP, "<Data>");
  for (const tag of BLOCK_TAGS) {
    assertStringIncludes(CARD_HELP, tag);
  }
});

Deno.test("CARD_HELP names every comparison an <If> accepts", () => {
  // The parser takes both, and a model can only use what it is told about.
  assertStringIncludes(CARD_HELP, 'eq="');
  assertStringIncludes(CARD_HELP, 'ne="');
});

Deno.test("splitChatText: a card fence is lifted out of the prose", () => {
  assertEquals(
    splitChatText(
      "前です。\n\n```card\n<Card><Text>a</Text></Card>\n```\n\n後です。",
    ),
    [
      { type: "text", text: "前です。" },
      { type: "card", markup: "<Card><Text>a</Text></Card>" },
      { type: "text", text: "後です。" },
    ],
  );
});

Deno.test("splitChatText: text without a card is one prose segment", () => {
  assertEquals(splitChatText("  ただの文です。\n\n続き。  "), [
    { type: "text", text: "ただの文です。\n\n続き。" },
  ]);
  assertEquals(splitChatText(""), []);
  assertEquals(splitChatText("   \n\n "), []);
});

Deno.test("splitChatText: a message may be cards alone, and several", () => {
  assertEquals(splitChatText("```card\n<Card><Text>a</Text></Card>\n```"), [
    { type: "card", markup: "<Card><Text>a</Text></Card>" },
  ]);
  assertEquals(
    splitChatText(
      "```card\n<Card><Text>a</Text></Card>\n```\n" +
        "```card\n<Card><Text>b</Text></Card>\n```",
    ),
    [
      { type: "card", markup: "<Card><Text>a</Text></Card>" },
      { type: "card", markup: "<Card><Text>b</Text></Card>" },
    ],
  );
});

Deno.test("splitChatText: an unclosed fence is a partial card", () => {
  // The model is still writing: the screen draws what has closed. It is a
  // card segment either way — the caller draws it, and an invalid finished
  // card says so.
  assertEquals(splitChatText("```card\n<Card><Text>half"), [
    { type: "card", markup: "<Card><Text>half" },
  ]);
});

Deno.test("splitChatText: other fences stay prose, delimiters included", () => {
  assertEquals(
    splitChatText("```js\nconst a = 1;\n```\n\n```card\n<Card/>\n```"),
    [
      { type: "text", text: "```js\nconst a = 1;\n```" },
      { type: "card", markup: "<Card/>" },
    ],
  );
  // A card's fence written INSIDE a code sample is a sample.
  assertEquals(splitChatText("```xml\n```card\n<Card/>\n```\n```"), [
    { type: "text", text: "```xml\n```card\n<Card/>\n```\n```" },
  ]);
});

Deno.test("splitChatText: a tilde fence is a card fence too", () => {
  assertEquals(splitChatText("~~~card\n<Card/>\n~~~"), [
    { type: "card", markup: "<Card/>" },
  ]);
});

Deno.test("splitChatText: words after </Card> in the fence are prose again", () => {
  // The model writes the closing tag and then keeps talking inside the
  // fence. The card is over at the tag, and its words are the reply's.
  assertEquals(
    splitChatText("```card\n<Card><Text>a</Text></Card>\n\n後です。\n```"),
    [
      { type: "card", markup: "<Card><Text>a</Text></Card>" },
      { type: "text", text: "後です。" },
    ],
  );
  // A </Card> written inside <Data> is JSON, not the end of the card.
  assertEquals(
    splitChatText(
      '```card\n<Card><Data>{"note":"a </Card> b"}</Data>' +
        "<Text>a</Text></Card>\n続き。\n```",
    ),
    [
      {
        type: "card",
        markup:
          '<Card><Data>{"note":"a </Card> b"}</Data><Text>a</Text></Card>',
      },
      { type: "text", text: "続き。" },
    ],
  );
});

Deno.test("splitChatText: a fence holding a card is a card, whatever its label", () => {
  // The info string is a hint. A model that fences its card as html, jsx or
  // with no label meant the card, and drawing the block as code would show
  // the markup instead of the picture.
  for (const info of ["", "html", "jsx"]) {
    assertEquals(
      splitChatText(`\`\`\`${info}\n<Card><Text>a</Text></Card>\n\`\`\``),
      [{ type: "card", markup: "<Card><Text>a</Text></Card>" }],
    );
  }
  // A sample that merely mentions the markup stays a sample.
  assertEquals(
    splitChatText("```html\n<div>a</div>\n<Card>\n```")[0]?.type,
    "text",
  );
  assertEquals(splitChatText("```txt\n  <Cards>\n```")[0]?.type, "text");
});

Deno.test("segmentsText: the prose is what a preview reads", () => {
  assertEquals(
    segmentsText([
      { type: "text", text: "前" },
      { type: "card", markup: "<Card/>" },
      { type: "text", text: "後" },
    ]),
    "前\n\n後",
  );
  assertEquals(segmentsText([{ type: "card", markup: "<Card/>" }]), "");
});

Deno.test("parseUiMarkup refuses a <Data> that is late, doubled or no object", () => {
  assertStringIncludes(
    problemOf('<Card><Text>a</Text><Data>{"a":1}</Data></Card>'),
    "write <Data> before the blocks",
  );
  assertStringIncludes(
    problemOf(
      '<Card><Data>{"a":1}</Data><Data>{"b":1}</Data><Text>a</Text></Card>',
    ),
    "at most one <Data>",
  );
  assertStringIncludes(
    problemOf("<Card><Data>{a:1}</Data><Text>a</Text></Card>"),
    "is not valid JSON",
  );
  assertStringIncludes(
    problemOf("<Card><Data>[1,2]</Data><Text>a</Text></Card>"),
    "must be a JSON object",
  );
  assertStringIncludes(
    problemOf("<Card><Data></Data><Text>a</Text></Card>"),
    "<Data> is empty",
  );
});

Deno.test("parseUiMarkup refuses a data key a path could not read", () => {
  assertStringIncludes(
    problemOf('<Card><Data>{"__proto__":{"a":1}}</Data><Text>a</Text></Card>'),
    'the data key "__proto__" is reserved',
  );
  assertStringIncludes(
    problemOf('<Card><Data>{"a b":1}</Data><Text>a</Text></Card>'),
    "must use letters, digits",
  );
});

Deno.test("parseUiMarkup checks a reference against the data", () => {
  assertStringIncludes(
    problemOf("<Card><Text>$data.total</Text></Card>"),
    "$data.total names no field of <Data>",
  );
  assertStringIncludes(
    problemOf('<Card><Data>{"list":[]}</Data><Text>$data.list</Text></Card>'),
    "must be text, a number or true/false",
  );
  assertStringIncludes(
    problemOf("<Card><Text>$data</Text></Card>"),
    "$data needs a field",
  );
  assertStringIncludes(
    problemOf("<Card><Text>$item.name</Text></Card>"),
    "$item can only be used inside a <Repeat>",
  );
  assertStringIncludes(
    problemOf("<Card><Text>$index</Text></Card>"),
    "$index can only be used inside a <Repeat>",
  );
});

Deno.test("parseUiMarkup reads a $ that names no reference as text", () => {
  // A shell variable, a price and a template literal are sentences, not
  // references, and refusing them used to take the whole card with it.
  const view = viewOf(
    "<Card><Text>$XDG_CONFIG_HOME と $5 を ${name} に書く</Text></Card>",
  );
  assertEquals(view.blocks, [
    { type: "text", text: "$XDG_CONFIG_HOME と $5 を ${name} に書く" },
  ]);
  // `$$` still stands for one `$`, so a reference can be written literally.
  assertEquals(
    resolveUiView(viewOf("<Card><Text>$$data.x</Text></Card>")).blocks,
    [{ type: "text", text: "$data.x" }],
  );
});

Deno.test("parseUiMarkup refuses a repeat that does not name an array", () => {
  assertStringIncludes(
    problemOf(
      '<Card><Data>{"n":1}</Data><Repeat over="n"><Text>a</Text></Repeat></Card>',
    ),
    "must name an array",
  );
  assertStringIncludes(
    problemOf('<Card><Repeat over="n"><Text>a</Text></Repeat></Card>'),
    "names no field of <Data>",
  );
  assertStringIncludes(
    problemOf(
      '<Card><Data>{"bad key":[]}</Data><Repeat over="bad key"><Text>a</Text></Repeat></Card>',
    ),
    "must use letters, digits",
  );
});

Deno.test("parseUiMarkup refuses a repeat inside a repeat", () => {
  assertStringIncludes(
    problemOf(`<Card><Data>{"a":[{"b":[]}]}</Data>
      <Repeat over="a"><Repeat over="a"><Text>x</Text></Repeat></Repeat>
    </Card>`),
    "cannot sit inside another <Repeat>",
  );
});

Deno.test("parseUiMarkup checks the field an item is asked for", () => {
  assertStringIncludes(
    problemOf(`<Card><Data>{"a":[{"x":1},{"y":2}]}</Data>
      <Repeat over="a"><Text>$item.x</Text></Repeat>
    </Card>`),
    'the repeated items have no field "x"',
  );
});

Deno.test("parseUiMarkup bounds the items a repeat expands", () => {
  const items = Array.from({ length: 101 }, (_, index) => index);
  const problem = problemOf(
    `<Card><Data>{"n":${JSON.stringify(items)}}</Data>` +
      '<Repeat over="n"><Text>$item</Text></Repeat></Card>',
  );

  assertStringIncludes(problem, "the limit is 100");
});

Deno.test("parseUiMarkup bounds the blocks a card expands to", () => {
  const items = Array.from({ length: 100 }, (_, index) => index);
  const row = "<Text>a</Text>".repeat(5);
  const problem = problemOf(
    `<Card><Data>{"n":${JSON.stringify(items)}}</Data>` +
      `<Repeat over="n"><Stack>${row}</Stack></Repeat></Card>`,
  );

  assertStringIncludes(problem, "the repeats expand to");
});

Deno.test("parseUiMarkup keeps <If> to a field of the item", () => {
  assertStringIncludes(
    problemOf('<Card><If test="$item.a" eq="1"><Text>x</Text></If></Card>'),
    "<If> can only sit inside a <Repeat>",
  );
  assertStringIncludes(
    problemOf(`<Card><Data>{"a":[{"x":1}]}</Data>
      <Repeat over="a"><If test="$item.x"><Text>x</Text></If></Repeat>
    </Card>`),
    'needs exactly one of "eq" and "ne"',
  );
  assertStringIncludes(
    problemOf(`<Card><Data>{"a":[{"x":1}]}</Data>
      <Repeat over="a"><If test="$data.x" eq="1"><Text>x</Text></If></Repeat>
    </Card>`),
    "must name a field of the item",
  );
});

// --- a card that is still being written -------------------------------------

function partialOf(markup: string): UiView {
  const result = parseUiMarkupPartial(markup);
  if (!result.ok) throw new Error(`could not read it: ${result.problem}`);
  return result.view;
}

Deno.test("parseUiMarkupPartial reads a whole card exactly like the strict parse", () => {
  const markup = '<Card title="x"><Text>a</Text></Card>';

  assertEquals(parseUiMarkupPartial(markup), parseUiMarkup(markup));
});

Deno.test("parseUiMarkupPartial draws the blocks that closed so far", () => {
  const markup =
    '<Card title="状況"><Text>a</Text><Metric label="b" value="1" /><Tab';

  assertEquals(partialOf(markup).blocks, [
    { type: "text", text: "a" },
    { type: "metric", label: "b", value: "1", unit: null, hint: null },
  ]);
});

Deno.test("parseUiMarkupPartial reads the data before the blocks that follow it", () => {
  const markup =
    `<Card><Data>{"envs":[{"name":"prod"}]}</Data>` +
    '<Repeat over="envs"><Metric label="$item.name" value="1" /></Repeat>' +
    "<Text>tail";

  assertEquals(resolveUiView(partialOf(markup)).blocks, [
    { type: "metric", label: "prod", value: "1", unit: null, hint: null },
  ]);
});

Deno.test("parseUiMarkupPartial says nothing until the first block closes", () => {
  assertStringIncludes(
    problemOfPartial("<Card><Text>abc"),
    "tag <Text> is not closed",
  );
  assertStringIncludes(problemOfPartial("<Card>"), "is not closed");
  assertStringIncludes(
    problemOfPartial('<Card><Data>{"a":'),
    "tag <Data> is not closed",
  );
});
