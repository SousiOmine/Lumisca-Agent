import { join } from "node:path";
import { Hono } from "npm:hono@4";

/** Filesystem browser endpoints (workspace folder picker). */
export function fsRoutes(): Hono {
  const app = new Hono();

  app.get("/fs/roots", (c) => {
    if (Deno.build.os === "windows") {
      const roots: string[] = [];
      for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
        try {
          const stat = Deno.statSync(`${letter}:\\`);
          if (stat.isDirectory) roots.push(`${letter}:\\`);
        } catch {
          // skip unavailable drives
        }
      }
      return c.json(roots);
    }
    return c.json(["/"]);
  });

  app.get("/fs/browse", async (c) => {
    const path = c.req.query("path") ?? "";
    if (!path) return c.json({ error: "path is required" }, 400);
    const stat = await Deno.stat(path).catch(() => null);
    if (!stat || !stat.isDirectory) {
      return c.json({ error: `not a directory: ${path}` }, 400);
    }
    const entries: Array<{ name: string; path: string }> = [];
    for await (const entry of Deno.readDir(path)) {
      if (entry.isDirectory) {
        entries.push({ name: entry.name, path: join(path, entry.name) });
      }
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const parent = join(path, "..");
    return c.json({
      path,
      parent: parent === path ? null : parent,
      entries,
    });
  });

  return app;
}
