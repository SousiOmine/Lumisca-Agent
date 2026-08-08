// Fake MCP server over stdio, for tests. Spawned by the MCP client tests;
// speaks newline-delimited JSON-RPC 2.0 with a fixed tool set:
//   echo  — echoes its `text` argument
//   fail  — returns an isError result
//   slow  — replies after 2 seconds (abort tests)
//   crash — exits the process (crash/respawn tests)
//   image — returns an image content block
// Run with: deno run scripts/fake-mcp-server.ts  (no permission flags needed)

const encoder = new TextEncoder();

function respond(id: number, result: unknown): void {
  Deno.stdout.writeSync(
    encoder.encode(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"),
  );
}

function respondError(id: number, code: number, message: string): void {
  Deno.stdout.writeSync(
    encoder.encode(
      JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n",
    ),
  );
}

console.error("fake mcp server ready");

const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Deno.stdin.readable) {
  buffer += decoder.decode(chunk, { stream: true });
  let newline: number;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;

    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line);
    } catch {
      continue; // stray line — ignore
    }
    if (message.jsonrpc !== "2.0") continue;
    const method = message.method;
    if (typeof method !== "string") continue; // response — never sent by the client

    if (method === "initialize") {
      respond(message.id as number, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "fake", version: "1.0.0" },
      });
    } else if (method === "tools/list") {
      respond(message.id as number, {
        tools: [
          {
            name: "echo",
            description: "Echo the given text",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
          {
            name: "fail",
            description: "Always fails",
            inputSchema: { type: "object" },
          },
          {
            name: "slow",
            description: "Replies after 2s",
            inputSchema: { type: "object" },
          },
          {
            name: "crash",
            description: "Exits the process",
            inputSchema: { type: "object" },
          },
          {
            name: "image",
            description: "Returns an image block",
            inputSchema: { type: "object" },
          },
        ],
      });
    } else if (method === "tools/call") {
      const params = (message.params ?? {}) as {
        name?: string;
        arguments?: Record<string, unknown>;
      };
      const toolName = params.name ?? "";
      if (toolName === "echo") {
        respond(message.id as number, {
          content: [{
            type: "text",
            text: `echo:${String(params.arguments?.text ?? "")}`,
          }],
        });
      } else if (toolName === "fail") {
        respond(message.id as number, {
          content: [{ type: "text", text: "boom" }],
          isError: true,
        });
      } else if (toolName === "slow") {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        respond(message.id as number, {
          content: [{ type: "text", text: "slow done" }],
        });
      } else if (toolName === "crash") {
        console.error("fake mcp server crashing on purpose");
        Deno.exit(1);
      } else if (toolName === "image") {
        respond(message.id as number, {
          content: [{ type: "image", data: "abc", mimeType: "image/png" }],
        });
      } else {
        respondError(message.id as number, -32602, `Unknown tool: ${toolName}`);
      }
    } else {
      respondError(message.id as number, -32601, `Unknown method: ${method}`);
    }
  }
}
