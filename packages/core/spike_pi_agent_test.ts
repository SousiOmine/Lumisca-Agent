import { Agent } from "@earendil-works/pi-agent-core";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import { assertEquals } from "@std/assert";

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
