import { Hono } from "hono";
import type { Context } from "hono";
import type { McpInfo } from "@lumisca/core";
import { AppError } from "./util.ts";

/** The slice of the core these routes need (interface segregation). */
export interface McpApi {
  /** App-level (global) MCP config; applies to every workspace. */
  getAppMcpInfo(): McpInfo;
  setAppMcpConfig(text: string): Promise<McpInfo>;
  /** A workspace's own `.mcp.json` (merged into sessions alongside the
   * app-level config). */
  getMcpInfo(workspaceId: string): McpInfo;
  setMcpConfig(workspaceId: string, text: string): Promise<McpInfo>;
}

async function putConfig(
  c: Context,
  apply: (text: string) => Promise<McpInfo>,
) {
  const text = await c.req.text();
  if (text.trim().length === 0) {
    throw new AppError("JSON body is required", 400);
  }
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
