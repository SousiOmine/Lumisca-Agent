import { DatabaseSync } from "node:sqlite";
import { Agent } from "@earendil-works/pi-agent-core";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  Type,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { IconMoon, IconPlus, IconSun } from "@tabler/icons-react";
import { createElement } from "react";
import { assertEquals } from "@std/assert";

/**
 * Stack smoke tests: verify that the external building blocks this project
 * relies on (node:sqlite, pi-ai, pi-agent-core, tabler icons) work under
 * Deno. These guard against silent incompatibilities when the stack is
 * upgraded.
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

Deno.test("pi-ai loads builtin models in Deno", () => {
  const models = builtinModels();
  const providers = models.getProviders();
  assertEquals(providers.length > 0, true, "at least one provider registered");
  const all = models.getModels();
  assertEquals(all.length > 0, true, "at least one model");
});

function createFauxModels() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models };
}

Deno.test("pi-agent-core runs a simple prompt", async () => {
  const { faux, models } = createFauxModels();
  faux.setResponses([fauxAssistantMessage("Hello from faux!")]);
  const model = faux.getModel();

  const agent = new Agent({
    initialState: { systemPrompt: "You are a helpful assistant.", model },
    streamFn: models.streamSimple.bind(models),
  });

  const events: string[] = [];
  agent.subscribe((event) => {
    events.push(event.type);
  });

  await agent.prompt("Hi");
  const last = agent.state.messages.at(-1);
  assertEquals(last?.role, "assistant");
  assertEquals(events.includes("agent_start"), true);
  assertEquals(events.includes("agent_end"), true);
  assertEquals(events.includes("message_update"), true);
});

Deno.test("pi-agent-core executes tools", async () => {
  const { faux, models } = createFauxModels();
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
      tools: [{
        name: "get_time",
        label: "Get Time",
        description: "Get the current time",
        parameters: Type.Object({
          timezone: Type.String(),
        }),
        execute: () =>
          Promise.resolve({
            content: [{ type: "text", text: "12:00 UTC" }],
            details: {},
          }),
      }],
    },
    streamFn: models.streamSimple.bind(models),
  });

  const events: string[] = [];
  agent.subscribe((event) => {
    events.push(event.type);
  });

  await agent.prompt("What time is it?");
  assertEquals(events.includes("tool_execution_start"), true);
  assertEquals(events.includes("tool_execution_end"), true);
  const toolResults = agent.state.messages.filter((m) =>
    m.role === "toolResult"
  );
  assertEquals(toolResults.length, 1);
});

Deno.test("tabler icons render in Deno (SSR)", async () => {
  const { renderToReadableStream } = await import("react-dom/server");
  const stream = await renderToReadableStream(
    createElement(
      "div",
      null,
      createElement(IconPlus, { size: 16 }),
      createElement(IconMoon, { size: 16 }),
      createElement(IconSun, { size: 16 }),
    ),
  );
  const reader = stream.getReader();
  let html = "";
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    html += decoder.decode(value);
  }
  if (!html.includes("<svg")) {
    throw new Error(`expected svg output, got: ${html.slice(0, 120)}`);
  }
  if (!html.includes('class="tabler-icon')) {
    throw new Error(`expected tabler-icon class: ${html.slice(0, 200)}`);
  }
});
