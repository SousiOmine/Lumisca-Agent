import { Hono } from "hono";
import type { Context } from "hono";
import type { McpInfo, McpTestResult } from "@lumisca/core";
import { requireNonEmptyString } from "./util.ts";

/** The slice of the core these routes need (interface segregation). */
export interface McpApi {
  /** App-level (global) MCP config; applies to every workspace. */
  getAppMcpInfo(): McpInfo;
  setAppMcpConfig(text: string): McpInfo;
  /** A workspace's own `.mcp.json` (merged into sessions alongside the
   * app-level config). */
  getMcpInfo(workspaceId: string): McpInfo;
  setMcpConfig(workspaceId: string, text: string): McpInfo;
  /** One-shot connection test of a single server config: connect, list the
   * tools, disconnect. Runs here because the server owns the child
   * processes a stdio server needs. Reaching the server is reported as a
   * result (`ok:false`), an invalid body still throws. */
  testMcpServer(text: string): Promise<McpTestResult>;
}

async function putConfig(
  c: Context,
  apply: (text: string) => McpInfo | Promise<McpInfo>,
) {
  const text = await c.req.text();
  // Blank (or whitespace-only) bodies are rejected like an absent body:
  // there is no config to validate or store.
  requireNonEmptyString(text.trim(), "JSON body");
  return c.json(await apply(text));
}

/** MCP server configuration. The settings UI manages the app-level config
 * (`/api/mcp`, stored in the DB); each workspace's `.mcp.json` is merged in
 * automatically and can also be edited directly on disk. */
export function mcpRoutes(core: McpApi): Hono {
  const app = new Hono();

  app.get("/mcp", (c) => {
    return c.json(core.getAppMcpInfo());
  });

  app.put("/mcp", async (c) => {
    return await putConfig(c, (text) => core.setAppMcpConfig(text));
  });

  // The settings UI's "test" button: the body is the same single-server
  // JSON a PUT would store, so the probe sees exactly what would be saved.
  app.post("/mcp/test", async (c) => {
    const text = await c.req.text();
    requireNonEmptyString(text.trim(), "JSON body");
    return c.json(await core.testMcpServer(text));
  });

  app.get("/workspaces/:id/mcp", (c) => {
    return c.json(core.getMcpInfo(c.req.param("id")));
  });

  app.put("/workspaces/:id/mcp", async (c) => {
    return await putConfig(
      c,
      (text) => core.setMcpConfig(c.req.param("id"), text),
    );
  });

  return app;
}
