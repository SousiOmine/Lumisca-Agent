import { join } from "node:path";
import { assert, assertEquals } from "@std/assert";
import { createEvalTool } from "./eval.ts";

function makeEval() {
  return createEvalTool();
}

function toolText(result: { content: { type: string; text?: string }[] }) {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}

Deno.test("eval returns the completion value of an expression", async () => {
  const tool = makeEval();
  const result = await tool.execute("1", { code: "1 + 2" }, undefined);
  assertEquals(toolText(result), "[result]\n3");
});

Deno.test("eval captures console output and inspects values", async () => {
  const tool = makeEval();
  const result = await tool.execute(
    "1",
    { code: 'console.log("hello", 1 + 1); ({ items: [1, 2, 3] })' },
    undefined,
  );
  const text = toolText(result);
  assertEquals(
    text,
    "[output]\nhello 2\n\n[result]\n{ items: [ 1, 2, 3 ] }",
  );
});

Deno.test("eval keeps var, function and globalThis state between calls", async () => {
  const tool = makeEval();
  await tool.execute(
    "1",
    { code: "var n = 41; function double(x: number): number { return x * 2 }" },
    undefined,
  );
  const viaVar = await tool.execute("1", { code: "n + 1" }, undefined);
  assertEquals(toolText(viaVar), "[result]\n42");
  const viaFunction = await tool.execute(
    "1",
    { code: "double(21)" },
    undefined,
  );
  assertEquals(toolText(viaFunction), "[result]\n42");
  const viaGlobalThis = await tool.execute(
    "1",
    { code: "globalThis.n = 100; n" },
    undefined,
  );
  assertEquals(toolText(viaGlobalThis), "[result]\n100");
});

Deno.test("eval reset clears the state", async () => {
  const tool = makeEval();
  await tool.execute("1", { code: "var n = 41" }, undefined);
  const result = await tool.execute(
    "1",
    { code: "n + 1", reset: true },
    undefined,
  );
  assert(
    toolText(result).includes("n is not defined"),
    `result: ${toolText(result)}`,
  );
});

Deno.test("eval keeps const and let state between calls", async () => {
  const tool = makeEval();
  await tool.execute("1", { code: "const x = 1; let y = 2" }, undefined);
  const result = await tool.execute("1", { code: "x + y" }, undefined);
  assertEquals(toolText(result), "[result]\n3");
});

Deno.test("eval rejects re-declaring a const or let name", async () => {
  const tool = makeEval();
  await tool.execute("1", { code: "const x = 1" }, undefined);
  const result = await tool.execute("1", { code: "const x = 5" }, undefined);
  assert(
    toolText(result).includes("already been declared"),
    `result: ${toolText(result)}`,
  );
});

Deno.test("eval keeps the state after a runtime error", async () => {
  const tool = makeEval();
  await tool.execute("1", { code: "var y = 5" }, undefined);
  const error = await tool.execute("1", { code: "y.unknown.deep" }, undefined);
  assert(toolText(error).startsWith("[error]"), toolText(error));
  const after = await tool.execute("1", { code: "y" }, undefined);
  assertEquals(toolText(after), "[result]\n5");
});

Deno.test("eval enforces the timeout", async () => {
  const tool = makeEval();
  const result = await tool.execute(
    "1",
    { code: "while (true) {}", timeout: 100 },
    undefined,
  );
  assert(
    toolText(result).includes("timed out"),
    `result: ${toolText(result)}`,
  );
});

Deno.test("eval strips TypeScript types", async () => {
  const tool = makeEval();
  const result = await tool.execute(
    "1",
    { code: "const n: number = 41; n + 1" },
    undefined,
  );
  assertEquals(toolText(result), "[result]\n42");
});

Deno.test("eval exposes Deno and fetch deliberately, but not node globals", async () => {
  const tool = makeEval();
  const result = await tool.execute(
    "1",
    {
      code:
        "[typeof Deno, typeof fetch, typeof process, typeof require].join(',')",
    },
    undefined,
  );
  assertEquals(
    toolText(result),
    "[result]\n'object,function,undefined,undefined'",
  );
});

Deno.test("eval state is isolated per tool instance", async () => {
  const a = makeEval();
  const b = makeEval();
  await a.execute("1", { code: "var shared = 1" }, undefined);
  const result = await b.execute("1", { code: "typeof shared" }, undefined);
  assertEquals(toolText(result), "[result]\n'undefined'");
});

Deno.test("eval reports no output for statements without a value", async () => {
  const tool = makeEval();
  const result = await tool.execute("1", { code: "const z = 1" }, undefined);
  assertEquals(toolText(result), "(no output)");
});

Deno.test("eval can read files via the exposed Deno namespace", async () => {
  const root = await Deno.makeTempDir({ prefix: "lumisca-eval-" });
  try {
    const file = join(root, "data.json");
    await Deno.writeTextFile(file, '{"a": 41}');
    const tool = makeEval();
    const result = await tool.execute(
      "1",
      { code: `JSON.parse(Deno.readTextFileSync(${JSON.stringify(file)}))` },
      undefined,
    );
    assertEquals(toolText(result), "[result]\n{ a: 41 }");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("eval supports top-level await and awaits promise completions", async () => {
  const root = await Deno.makeTempDir({ prefix: "lumisca-eval-" });
  try {
    const file = join(root, "data.txt");
    await Deno.writeTextFile(file, "hello");
    const tool = makeEval();
    // Top-level await runs in the async wrapper; results come via
    // console.log (the wrapper cannot return a completion value).
    const tla = await tool.execute(
      "1",
      { code: `console.log(await Deno.readTextFile(${JSON.stringify(file)}))` },
      undefined,
    );
    assertEquals(toolText(tla), "[output]\nhello");
    // A promise completion without await is awaited by the host.
    const promised = await tool.execute(
      "1",
      { code: `Deno.readTextFile(${JSON.stringify(file)})` },
      undefined,
    );
    assertEquals(toolText(promised), "[result]\n'hello'");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("eval persists globalThis state across async calls", async () => {
  const tool = makeEval();
  await tool.execute("1", { code: "globalThis.g = 41" }, undefined);
  const result = await tool.execute(
    "1",
    { code: "console.log(await Promise.resolve(globalThis.g + 1))" },
    undefined,
  );
  assertEquals(toolText(result), "[output]\n42");
});

Deno.test("eval times out a promise that never resolves", async () => {
  const tool = makeEval();
  const result = await tool.execute(
    "1",
    { code: "new Promise(() => {})", timeout: 100 },
    undefined,
  );
  assert(
    toolText(result).includes("timed out"),
    `result: ${toolText(result)}`,
  );
});
