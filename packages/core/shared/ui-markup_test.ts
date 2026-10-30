import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import {
  interactiveBlock,
  parseUiMarkup,
  type UiView,
} from "./ui-markup/index.ts";

/**
 * Reading the UI markup.
 *
 * The screen (client) and the validation (the tool that accepts a card) call
 * the same functions, so the grammar's promises are pinned down here, in one
 * place.
 */

function viewOf(markup: string): UiView {
  const result = parseUiMarkup(markup);
  if (!result.ok) throw new Error(`could not read it: ${result.problem}`);
  return result.view;
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
          options: [],
        },
        {
          label: "数",
          type: "number",
          required: false,
          placeholder: null,
          options: [],
        },
        {
          label: "プラン",
          type: "select",
          required: false,
          placeholder: null,
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
  assertStringIncludes(
    problemOf("<Card></Card>"),
    "needs at least one block",
  );
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

Deno.test("parseUiMarkup refuses a value on a boolean attribute", () => {
  assertStringIncludes(
    problemOf('<Card><List ordered="yes"><Item>a</Item></List></Card>'),
    "takes no value",
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

Deno.test("parseUiMarkup nests at most four levels deep", () => {
  assertStringIncludes(
    problemOf(
      "<Card><Text><Text><Text><Text>x</Text></Text></Text></Text></Card>",
    ),
    "nested deeper than 4 levels",
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
