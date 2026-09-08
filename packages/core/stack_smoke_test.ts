import { DatabaseSync } from "node:sqlite";
import {
  Agent,
  type AgentTool,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  LumiscaModels,
} from "@lumisca/core";
import { builtinProviders } from "./models/dev-catalog.ts";
import { extraProviders } from "./models/extra-providers.ts";
import { IconMoon, IconPlus, IconSun } from "@tabler/icons-preact";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";
import { assertEquals } from "@std/assert";

/**
 * Stack smoke tests: verify that the external building blocks this project
 * relies on (node:sqlite, the Lumisca AI layer backed by Vercel AI SDK,
 * tabler icons) work under Deno. These guard against silent incompatibilities
 * when the stack is upgraded.
 */

Deno.test("node:sqlite works in Deno", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE workspaces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  db.prepare("INSERT INTO workspaces (name, created_at) VALUES (?, ?)")
    .run("my-workspace", Date.now());
  const row = db.prepare("SELECT name FROM workspaces WHERE id = 1").get() as {
    name: string;
  };
  assertEquals(row.name, "my-workspace");
  db.close();
});

Deno.test("the model registry loads builtin and extra providers", () => {
  const models = new LumiscaModels();
  for (const provider of builtinProviders()) models.setProvider(provider);
  for (const provider of extraProviders()) models.setProvider(provider);
  assertEquals(models.getProviders().length > 0, true);
  assertEquals(models.getModels().length > 0, true);
});

Deno.test("the agent runs a simple prompt", async () => {
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage("Hello from faux!")]);
  const agent = new Agent({
    initialState: {
      systemPrompt: "You are a helpful assistant.",
      model: faux.getModel(),
      tools: [],
    },
    streamFn: faux.streamFn,
    sessionId: "s1",
  });

  const events: string[] = [];
  agent.subscribe((event) => {
    events.push(event.type);
  });

  await agent.prompt("Hi");
  const last = agent.messages.at(-1) as { role: string; content: unknown[] };
  assertEquals(last.role, "assistant");
  assertEquals(events.includes("agent_start"), true);
  assertEquals(events.includes("agent_end"), true);
  assertEquals(events.includes("turn_end"), true);
});

function fauxToolDef(): AgentTool {
  return {
    name: "get_time",
    label: "Get Time",
    description: "Get the current time",
    parameters: {
      type: "object",
      properties: { timezone: { type: "string" } },
      required: ["timezone"],
    },
    execute: () =>
      Promise.resolve({
        content: [{ type: "text", text: "12:00 UTC" }],
        details: {},
      }),
  };
}

Deno.test("the agent executes tools", async () => {
  const faux = fauxProvider();
  const model = faux.getModel();

  faux.setResponses([
    fauxAssistantMessage([
      fauxText("Let me check the time."),
      fauxToolCall("get_time", { timezone: "UTC" }),
    ]),
    fauxAssistantMessage("The time is noon."),
  ]);

  const agent = new Agent({
    initialState: {
      systemPrompt: "You are a helpful assistant.",
      model,
      tools: [fauxToolDef()],
    },
    streamFn: faux.streamFn,
    sessionId: "s1",
  });

  const events: string[] = [];
  agent.subscribe((event) => {
    events.push(event.type);
  });

  await agent.prompt("What time is it?");
  assertEquals(events.includes("tool_execution_start"), true);
  assertEquals(events.includes("tool_execution_end"), true);
  const toolResults = agent.messages.filter((m) => m.role === "toolResult");
  assertEquals(toolResults.length, 1);
});

Deno.test("tabler icons render in Deno (SSR)", () => {
  const html = renderToString(
    createElement(
      "div",
      null,
      createElement(IconPlus, { size: 16 }),
      createElement(IconMoon, { size: 16 }),
      createElement(IconSun, { size: 16 }),
    ),
  );
  if (!html.includes("<svg")) {
    throw new Error(`expected svg output, got: ${html.slice(0, 120)}`);
  }
  if (!html.includes('class="tabler-icon')) {
    throw new Error(`expected tabler-icon class: ${html.slice(0, 200)}`);
  }
});
