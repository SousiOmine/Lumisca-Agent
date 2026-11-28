import { test } from "bun:test";
import { join } from "node:path";
import { assertEquals } from "@std/assert";
import type { SessionPoolDeps } from "../agent/deps.ts";
import { mergedMcpForSession } from "../agent/session-mcp.ts";
import type { SessionInfo } from "../domain/session.ts";
import type { Workspace } from "../domain/workspace.ts";
import { McpServerClient, probeMcpServer } from "./client.ts";
import { startFakeMcpServer } from "./fake-http.ts";
import {
  type MachineRunner,
  machineStdioCommand,
  startMachineRelay,
} from "./machine.ts";
import { McpManager } from "./manager.ts";

/** A runner that starts the command on this machine: the same shape as
 * podman exec, so the transports are exercised without a container. */
const localRunner: MachineRunner = {
  process: (command) => ({ file: command[0]!, args: command.slice(1) }),
};

const fakeServer = join(
  import.meta.dirname!,
  "..",
  "..",
  "..",
  "scripts",
  "fake-mcp-server.ts",
);

test("machineStdioCommand hands command, env and cwd to the runner", () => {
  const seen: { command: readonly string[]; options: unknown }[] = [];
  const runner: MachineRunner = {
    process: (command, options) => {
      seen.push({ command, options });
      return { file: "podman", args: [] };
    },
  };
  machineStdioCommand(runner, {
    command: "npx",
    args: ["-y", "server"],
    env: { TOKEN: "x" },
    cwd: "/home/agent/agents/a",
  });
  assertEquals(seen.length, 1);
  assertEquals(seen[0]!.command, ["npx", "-y", "server"]);
  assertEquals(seen[0]!.options, {
    env: { TOKEN: "x" },
    cwd: "/home/agent/agents/a",
  });
});

test("a machine stdio server speaks MCP through the runner", async () => {
  const client = await McpServerClient.connect(
    {
      name: "vm",
      type: "stdio",
      command: process.execPath,
      args: ["run", fakeServer],
      env: {},
      headers: {},
      enabled: true,
    },
    process.cwd(),
    10_000,
    { machine: localRunner },
  );
  try {
    const tools = await client.listTools(10_000);
    assertEquals(
      tools.map((tool) => tool.name),
      ["echo", "fail", "slow", "crash", "image"],
    );
    const content = await client.callTool("echo", { text: "こんにちは" });
    assertEquals(content[0]!.text, "echo:こんにちは");
  } finally {
    await client.close();
  }
});

test("a machine HTTP server is reached through the relay", async () => {
  const fake = startFakeMcpServer();
  try {
    const tools = await probeMcpServer(
      {
        name: "vm-http",
        type: "http",
        url: fake.url,
        args: [],
        env: {},
        headers: {},
        enabled: true,
      },
      process.cwd(),
      10_000,
      { machine: localRunner },
    );
    assertEquals(
      tools.map((tool) => tool.name),
      ["echo"],
    );
    // The request really travelled through the relay: the fake saw a
    // request at its own /mcp path.
    assertEquals(fake.requests.length > 0, true);
  } finally {
    await fake.close();
  }
});

test("startMachineRelay keeps the scheme and path, and closes cleanly", async () => {
  const fake = startFakeMcpServer();
  const target = new URL(fake.url);
  const relay = await startMachineRelay(localRunner, target);
  try {
    assertEquals(relay.url.protocol, target.protocol);
    assertEquals(relay.url.pathname, target.pathname);
    assertEquals(relay.url.hostname, "127.0.0.1");
    assertEquals(relay.url.port === new URL(target.href).port, false);
    const response = await fetch(relay.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "t", version: "1" },
        },
      }),
    });
    assertEquals(response.status, 200);
  } finally {
    await relay.close();
    await fake.close();
  }
});

test("the manager starts a machine server through the runner", async () => {
  const seen: string[][] = [];
  const runner: MachineRunner = {
    process: (command) => {
      seen.push([...command]);
      return { file: command[0]!, args: command.slice(1) };
    },
  };
  const manager = new McpManager(
    {
      filePath: "test",
      servers: [
        {
          name: "vm",
          type: "stdio",
          command: process.execPath,
          args: ["run", fakeServer],
          env: {},
          headers: {},
          enabled: true,
        },
      ],
    },
    process.cwd(),
    undefined,
    { servers: new Set(["vm"]), runner },
  );
  try {
    const tools = await manager.listTools();
    assertEquals(tools.map((tool) => tool.name).includes("echo"), true);
    assertEquals(seen.length, 1);
    assertEquals(seen[0], [process.execPath, "run", fakeServer]);
  } finally {
    await manager.close();
  }
});

test("a merged config marks the agent's servers as machine ones", () => {
  const appServer = {
    name: "shared",
    type: "stdio" as const,
    command: "app",
    args: [],
    env: {},
    headers: {},
    enabled: true,
  };
  const agentServer = { ...appServer, command: "vm" };
  const merged = mergedMcpForSession(
    {
      loadMergedMcp: () => ({
        config: { filePath: "app", servers: [appServer] },
        errors: [],
      }),
      loadAgentMcp: () => ({
        config: { filePath: "agent", servers: [agentServer] },
        errors: [],
      }),
    } as unknown as SessionPoolDeps,
    { id: "s", personaId: "agent-1" } as SessionInfo,
    {} as Workspace,
  );
  assertEquals(merged.config.servers.length, 1);
  assertEquals(merged.config.servers[0]!.command, "vm");
  assertEquals([...merged.machineServers!], ["shared"]);
});
