import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import {
  applyActions,
  bindingOf,
  completeJson,
  createUiAppState,
  parseAppSpec,
  parseAppSpecPartial,
  resolveCondition,
  resolveProps,
  resolveValue,
  type UiAppContext,
} from "./ui-app/index.ts";

/** A spec that uses every shape the parser has to accept. */
function base(): any {
  return {
    version: 1,
    title: "Tasks",
    description: "One card",
    state: {
      draft: "",
      tab: "A",
      choice: "one",
      items: [{ name: "Estimate", done: false }],
    },
    root: "screen",
    elements: {
      screen: {
        type: "Screen",
        children: ["heading", "tabs", "form", "list", "table", "flow"],
      },
      heading: {
        type: "Heading",
        props: { text: "Tasks", level: 2 },
      },
      tabs: {
        type: "Tabs",
        props: { value: { $bindState: "/tab" } },
        children: ["tabA", "tabB"],
      },
      tabA: { type: "Tab", props: { label: "A" }, children: ["textA"] },
      textA: { type: "Text", props: { text: "A" } },
      tabB: { type: "Tab", props: { label: "B" }, children: ["textB"] },
      textB: { type: "Text", props: { text: "B" } },
      form: {
        type: "Row",
        props: { gap: "s" },
        children: ["input", "select", "check", "button"],
      },
      input: {
        type: "Input",
        props: {
          placeholder: "New",
          value: { $bindState: "/draft" },
        },
      },
      select: {
        type: "Select",
        props: {
          label: "Choice",
          options: [
            { label: "One", value: "one" },
            { label: "Two", value: "two" },
          ],
          value: { $bindState: "/choice" },
        },
      },
      check: {
        type: "Checkbox",
        props: {
          label: "Done",
          checked: { $bindState: "/items/0/done" },
        },
      },
      button: {
        type: "Button",
        props: { label: "Add", variant: "primary" },
        on: {
          press: {
            action: "setState",
            path: "/items",
            op: "append",
            value: { name: { $state: "/draft" }, done: false },
          },
        },
      },
      list: {
        type: "Repeat",
        props: { over: { $state: "/items" } },
        children: ["row"],
      },
      row: {
        type: "Checkbox",
        props: {
          label: { $template: "${item.name}" },
          checked: { $bindItem: "done" },
        },
      },
      table: {
        type: "Table",
        props: {
          columns: ["Name", "Done"],
          rows: [["Estimate", "no"]],
        },
      },
      flow: {
        type: "Flow",
        props: {
          nodes: [
            { id: "a", label: "A", shape: "box" },
            { id: "b", label: "B", shape: "round" },
          ],
          edges: [{ from: "a", to: "b" }],
        },
      },
    },
  };
}

function parse(spec: any) {
  return parseAppSpec(JSON.stringify(spec));
}

function problemOf(spec: any): string {
  const result = parse(spec);
  if (result.ok) throw new Error("expected the spec to be refused");
  return result.problem;
}

function expectProblem(spec: any, text: string): void {
  const problem = problemOf(spec);
  assert(problem.includes(text), `expected "${text}" in: ${problem}`);
}

function context(): UiAppContext {
  return {
    state: {
      name: "Ada",
      items: [{ name: "Estimate", done: false }],
    },
    item: { name: "Estimate", done: false },
    index: 0,
    itemPath: "/items/0",
    bindItem: true,
  };
}

test("ui-app: the base spec parses", () => {
  const result = parse(base());
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.spec.title, "Tasks");
});

test("ui-app: unknown components, props and missing required props fail", () => {
  const unknown = base();
  unknown.elements.heading.type = "Nope";
  expectProblem(unknown, "unknown component");

  const prop = base();
  prop.elements.heading.props.nope = 1;
  expectProblem(prop, 'has no prop "nope"');

  const missing = base();
  delete missing.elements.heading.props.text;
  expectProblem(missing, 'needs "text"');
});

test("ui-app: the graph is one tree from the root", () => {
  const missingChild = base();
  missingChild.elements.screen.children.push("ghost");
  expectProblem(missingChild, "names no element");

  const duplicate = base();
  duplicate.elements.screen.children.push("heading");
  expectProblem(duplicate, "names a child twice");

  const secondParent = base();
  secondParent.elements.tabA.children.push("textB");
  expectProblem(secondParent, "reached from two parents");

  const orphan = base();
  orphan.elements.orphan = { type: "Text", props: { text: "x" } };
  expectProblem(orphan, "not reachable");

  const cycle = base();
  cycle.elements.screen.children.push("s1");
  cycle.elements.s1 = { type: "Stack", children: ["s2"] };
  cycle.elements.s2 = { type: "Stack", children: ["s1"] };
  expectProblem(cycle, "cycle");
});

test("ui-app: expressions are checked against state and scope", () => {
  const state = base();
  state.elements.heading.props.text = { $state: "/missing" };
  expectProblem(state, "names no state value");

  const item = base();
  item.elements.heading.props.text = { $item: "name" };
  expectProblem(item, "$item is only inside a Repeat");

  const index = base();
  index.elements.heading.props.text = { $index: true };
  expectProblem(index, "$index is only inside a Repeat");

  const bindItem = base();
  bindItem.elements.input.props.value = { $bindItem: "name" };
  expectProblem(bindItem, "$bindItem needs a Repeat");

  const bindState = base();
  bindState.elements.heading.props.text = { $bindState: "/draft" };
  expectProblem(bindState, "$bindState is only an input value");

  const wrongBind = base();
  wrongBind.elements.tabs.props.value = { $bindItem: "name" };
  expectProblem(wrongBind, "must be $bindState here");

  const itemField = base();
  itemField.state.items[0] = { name: "Estimate" };
  itemField.elements.form.children = itemField.elements.form.children.filter(
    (id: string) => id !== "check",
  );
  delete itemField.elements.check;
  expectProblem(itemField, 'no field "done"');
});

test("ui-app: props are checked against the catalog", () => {
  const tabs = base();
  tabs.state.tab = "C";
  expectProblem(tabs, "names no <Tab>");

  const select = base();
  select.state.choice = "three";
  expectProblem(select, "names no option");

  const table = base();
  table.elements.table.props.rows = [["only one"]];
  expectProblem(table, "cells for 2 columns");

  const flow = base();
  flow.elements.flow.props.edges = [{ from: "a", to: "c" }];
  expectProblem(flow, 'unknown node "c"');

  const enumValue = base();
  enumValue.elements.heading.props.level = 9;
  expectProblem(enumValue, "at most 4");

  const text = base();
  text.elements.heading.props.text = "x".repeat(201);
  expectProblem(text, "characters");
});

test("ui-app: actions are checked against the state they change", () => {
  const toggle = base();
  toggle.elements.button.on.press = {
    action: "setState",
    path: "/draft",
    op: "toggle",
  };
  expectProblem(toggle, "toggle needs a boolean");

  const append = base();
  append.elements.button.on.press = {
    action: "setState",
    path: "/draft",
    op: "append",
    value: "x",
  };
  expectProblem(append, "append needs an array");

  const remove = base();
  remove.elements.button.on.press = {
    action: "setState",
    path: "/items",
    op: "remove",
    index: "x",
  };
  expectProblem(remove, "must be a number or an expression");

  const send = base();
  send.elements.button.on.press = { action: "sendMessage", text: "" };
  expectProblem(send, "must not be empty");

  const unknown = base();
  unknown.elements.button.on.press = { action: "fetch", text: "x" };
  expectProblem(unknown, "unknown action");
});

test("ui-app: limits stop a card that became a page", () => {
  const deep = base();
  let previous = "screen";
  for (let index = 0; index < 9; index++) {
    const id = `deep${index}`;
    deep.elements[id] = { type: "Stack", children: [] };
    deep.elements[previous].children = [id];
    previous = id;
  }
  deep.elements[previous].children = ["heading"];
  expectProblem(deep, "deeper than");

  const wide = base();
  wide.elements.screen.children = [];
  for (let stack = 0; stack < 5; stack++) {
    const stackId = `s${stack}`;
    wide.elements[stackId] = { type: "Stack", children: [] };
    wide.elements.screen.children.push(stackId);
    for (let index = 0; index < 40; index++) {
      const id = `t${stack}_${index}`;
      wide.elements[id] = { type: "Text", props: { text: "x" } };
      wide.elements[stackId].children.push(id);
    }
  }
  expectProblem(wide, "elements; the limit");

  const repeated = base();
  repeated.state.items = Array.from({ length: 100 }, (_, index) => ({
    name: `Item ${index}`,
    done: false,
  }));
  repeated.elements.row = { type: "Text", props: { text: "x" } };
  repeated.elements.list.children = ["row", "e1", "e2", "e3", "e4"];
  for (const id of ["e1", "e2", "e3", "e4"]) {
    repeated.elements[id] = { type: "Text", props: { text: "x" } };
  }
  expectProblem(repeated, "after repeats");

  const state = base();
  state.state.draft = "x".repeat(16_001);
  expectProblem(state, "characters; the limit is 16000");

  const source = "x".repeat(48_001);
  const result = parseAppSpec(source);
  assertEquals(result.ok, false);
  if (!result.ok) assert(result.problem.includes("48000"));
});

test("ui-app: reserved keys never reach a prototype", () => {
  const source = JSON.stringify(base()).replace(
    '"state":{',
    '"state":{"__proto__":{},',
  );
  const result = parseAppSpec(source);
  assertEquals(result.ok, false);
  if (!result.ok) assert(result.problem.includes("reserved key"));
});

test("ui-app: partial JSON is completed for streaming", () => {
  assertEquals(completeJson('{"a": "b'), '{"a": "b"}');
  assertEquals(completeJson('{"a": [1, 2'), '{"a": [1, 2]}');
  assertEquals(completeJson('{"a": 1,'), '{"a": 1}');
  assertEquals(completeJson('{"a":'), '{"a": null}');
  assertEquals(completeJson('{"a": "b\\'), '{"a": "b\\\\"}');

  const full = JSON.stringify({
    version: 1,
    state: {},
    root: "screen",
    elements: {
      screen: { type: "Screen", children: ["h"] },
      h: { type: "Heading", props: { text: "Hi" } },
    },
  });
  const partial = parseAppSpecPartial(full.slice(0, -2));
  assertEquals(partial.ok, true);
});

test("ui-app: state is immutable and resets to the spec", () => {
  const store = createUiAppState({
    count: 0,
    form: { name: "" },
    items: [{ done: false }],
  });
  const before = store.snapshot();
  store.set("/form/name", "Ada");
  assertEquals(store.get("/form/name"), "Ada");
  assert(store.snapshot() !== before);
  assertEquals(before.form, { name: "" });

  store.update("/count", (value) => (value as number) + 1);
  assertEquals(store.get("/count"), 1);
  store.reset();
  assertEquals(store.get("/count"), 0);
  assertEquals(store.get("/form/name"), "");

  let notified = 0;
  const unsubscribe = store.subscribe(() => {
    notified++;
  });
  store.set("/form/name", "Grace");
  assertEquals(notified, 1);
  unsubscribe();
  store.set("/form/name", "Ada");
  assertEquals(notified, 1);

  assertEquals(store.get("/items/0/done"), false);
  store.set("/items/0/done", true);
  assertEquals(store.get("/items/0/done"), true);
});

test("ui-app: state refuses dangerous paths", () => {
  const store = createUiAppState({ name: "" });
  let thrown = false;
  try {
    store.set("/__proto__/polluted", true);
  } catch {
    thrown = true;
  }
  assert(thrown);

  const parsed = JSON.parse('{"__proto__":{"polluted":true}}');
  thrown = false;
  try {
    createUiAppState(parsed);
  } catch {
    thrown = true;
  }
  assert(thrown);
});

test("ui-app: values resolve against state and the repeat", () => {
  const ctx = context();
  assertEquals(resolveValue({ $state: "/name" }, ctx), "Ada");
  assertEquals(resolveValue({ $item: "name" }, ctx), "Estimate");
  assertEquals(resolveValue({ $index: true }, ctx), 0);
  assertEquals(resolveValue({ $template: "Hi ${/name}" }, ctx), "Hi Ada");
  assertEquals(
    resolveValue({ $template: "${item.name} #${index}" }, ctx),
    "Estimate #0",
  );
  assertEquals(
    resolveValue(
      { $cond: { $state: "/name", eq: "Ada" }, $then: "yes", $else: "no" },
      ctx,
    ),
    "yes",
  );
  assertEquals(bindingOf({ $bindState: "/name" }, ctx), { path: "/name" });
  assertEquals(bindingOf({ $bindItem: "name" }, ctx), {
    path: "/items/0/name",
  });

  const props = resolveProps(
    {
      text: { $template: "Hi ${/name}" },
      value: { $bindState: "/name" },
    },
    ctx,
  );
  assertEquals(props.props.text, "Hi Ada");
  assertEquals(props.bindings.value, { path: "/name" });
});

test("ui-app: conditions compare and combine", () => {
  const ctx = context();
  assert(resolveCondition(true, ctx));
  assert(!resolveCondition(false, ctx));
  assert(resolveCondition({ $state: "/name" }, ctx));
  assert(resolveCondition({ $state: "/name", eq: "Ada" }, ctx));
  assert(!resolveCondition({ $state: "/name", neq: "Ada" }, ctx));
  assert(resolveCondition({ $item: "done", eq: false }, ctx));
  assert(resolveCondition({ $index: true, eq: 0 }, ctx));
  assert(
    resolveCondition(
      {
        $and: [
          { $state: "/name", eq: "Ada" },
          { $item: "done", eq: false },
        ],
      },
      ctx,
    ),
  );
  assert(
    resolveCondition(
      {
        $or: [
          { $state: "/name", eq: "Grace" },
          { $item: "done", eq: false },
        ],
      },
      ctx,
    ),
  );
  assert(!resolveCondition({ $state: "/name", not: true }, ctx));
});

test("ui-app: actions change state in order and send one message", () => {
  const store = createUiAppState({
    count: 0,
    on: false,
    items: [] as unknown[],
    name: "",
  });
  const sent: string[] = [];
  const ctx: UiAppContext = {
    state: store.snapshot(),
    item: null,
    index: 0,
    itemPath: null,
    bindItem: false,
  };
  applyActions(
    [
      { action: "setState", path: "/count", op: "increment", by: 2 },
      { action: "setState", path: "/on", op: "toggle" },
      {
        action: "setState",
        path: "/items",
        op: "append",
        value: { $template: "item ${/count}" },
      },
      { action: "setState", path: "/name", value: "Ada" },
      { action: "sendMessage", text: { $template: "Hi ${/name}" } },
    ],
    ctx,
    store,
    (text) => sent.push(text),
  );
  assertEquals(store.get("/count"), 2);
  assertEquals(store.get("/on"), true);
  assertEquals(store.get("/items"), ["item 2"]);
  assertEquals(store.get("/name"), "Ada");
  assertEquals(sent, ["Hi Ada"]);

  applyActions(
    [{ action: "setState", path: "/items", op: "remove", index: 0 }],
    { ...ctx, state: store.snapshot() },
    store,
  );
  assertEquals(store.get("/items"), []);

  applyActions([{ action: "resetState" }], ctx, store);
  assertEquals(store.get("/count"), 0);
  assertEquals(store.get("/name"), "");
});

test("ui-app: a spec cannot draw two values from one state path", () => {
  const spec = base();
  spec.elements.button.on.press = {
    action: "setState",
    path: "/draft",
    value: 1,
  };
  expectProblem(spec, "same type as the state value");
});
