import { join } from "node:path";
import { Hono } from "npm:hono@4";
import { cors } from "npm:hono@4/cors";
import { upgradeWebSocket } from "npm:hono@4/deno";
import type { LumiscaCore } from "@lumisca/core";
import { bundleClient } from "./bundle.ts";
import { renderAppMarkup, renderHtmlDocument } from "./render.tsx";
import { SourceWatcher } from "./watch.ts";
import { fsRoutes } from "./routes/fs.ts";
import { workspaceRoutes } from "./routes/workspaces.ts";
import { sessionRoutes } from "./routes/sessions.ts";
import { providerRoutes } from "./routes/providers.ts";
import { settingRoutes } from "./routes/settings.ts";
import type { InitialData } from "../web/src/types.ts";

export interface AppOptions {
  /** Repository root (defaults to the current working directory). */
  repoRoot?: string;
  /** Watch frontend sources; rebundle and notify clients on change. */
  watch?: boolean;
}

/** Lazily built/loaded frontend assets (client bundle, css, favicon). */
class Assets {
  private appJs: string | null = null;
  private css: string | null = null;
  private favicon: Uint8Array | null = null;

  constructor(
    private readonly repoRoot: string,
    private readonly cacheDir: string,
  ) {}

  /** Drop cached artifacts so the next request rebuilds them. */
  invalidate(): void {
    this.appJs = null;
    this.css = null;
  }

  async getAppJs(): Promise<string> {
    if (this.appJs === null) {
      await Deno.mkdir(this.cacheDir, { recursive: true });
      const outfile = join(this.cacheDir, "app.js");
      await bundleClient({
        cwd: this.repoRoot,
        entry: join(this.repoRoot, "packages", "web", "src", "client.tsx"),
        outfile,
      });
      this.appJs = await Deno.readTextFile(outfile);
    }
    return this.appJs;
  }

  async getCss(): Promise<string> {
    if (this.css === null) {
      this.css = await Deno.readTextFile(
        join(this.repoRoot, "packages", "web", "src", "styles.css"),
      );
    }
    return this.css;
  }

  async getFavicon(): Promise<Uint8Array> {
    if (this.favicon === null) {
      this.favicon = await Deno.readFile(
        join(this.repoRoot, "packages", "web", "public", "favicon.svg"),
      );
    }
    return this.favicon;
  }
}

/** Create the HTTP + WebSocket application. */
export function createApp(core: LumiscaCore, options: AppOptions = {}): Hono {
  const app = new Hono();
  const repoRoot = options.repoRoot ?? Deno.cwd();
  const assets = new Assets(repoRoot, join(repoRoot, ".lumisca-cache"));
  const watch = options.watch ?? Deno.env.get("LUMISCA_DEV") === "1";

  // Connected websocket clients; used to broadcast reloads in dev mode.
  const wsClients = new Set<WebSocket>();
  const reloadClients = () => {
    const message = JSON.stringify({ type: "reload" });
    for (const client of wsClients) {
      try {
        client.send(message);
      } catch {
        wsClients.delete(client);
      }
    }
  };

  // Dev mode: watch frontend sources, invalidate the asset cache, and
  // tell connected clients to reload so they pick up the new bundle.
  let watcher: SourceWatcher | null = null;
  if (watch) {
    watcher = new SourceWatcher(
      join(repoRoot, "packages", "web", "src"),
    );
    watcher.start(() => {
      assets.invalidate();
      reloadClients();
    });
  }

  // The desktop shell (Tauri WebView) calls the API from another origin.
  app.use("/api/*", cors());
  app.use("/ws", cors());

  app.get("/api/health", (c) => c.json({ ok: true }));

  // --- SSR page -------------------------------------------------------------

  const renderPage = async () => {
    const data: InitialData = {
      workspaces: core.listWorkspaces(),
      theme: core.getSetting("theme") === "light" ? "light" : "dark",
    };
    const [markup, css] = await Promise.all([
      renderAppMarkup(data),
      assets.getCss(),
    ]);
    return new Response(renderHtmlDocument(markup, data, css), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  };

  app.get("/", renderPage);

  app.get("/assets/app.js", async (c) => {
    try {
      const js = await assets.getAppJs();
      return c.body(js, 200, {
        "content-type": "application/javascript; charset=utf-8",
      });
    } catch (error) {
      return c.text(
        `Client bundle build failed: ${error instanceof Error ? error.message : String(error)}`,
        500,
      );
    }
  });

  app.get("/styles.css", async (c) => {
    try {
      const css = await assets.getCss();
      return c.body(css, 200, { "content-type": "text/css; charset=utf-8" });
    } catch (error) {
      return c.text(String(error), 500);
    }
  });

  app.get("/favicon.svg", async (c) => {
    try {
      const svg = await assets.getFavicon();
      return c.newResponse(svg.buffer as ArrayBuffer, 200, {
        "content-type": "image/svg+xml",
      });
    } catch {
      return c.text("not found", 404);
    }
  });

  // SPA fallback: any other page renders the app shell.
  app.get("*", async (c, next) => {
    if (c.req.path.startsWith("/api") || c.req.path === "/ws") {
      return next();
    }
    return renderPage();
  });

  // --- API routes (mounted after the SPA fallback so /api passes through) ----

  app.route("/api", fsRoutes());
  app.route("/api", workspaceRoutes(core));
  app.route("/api", sessionRoutes(core));
  app.route("/api", providerRoutes(core));
  app.route("/api", settingRoutes(core));

  // --- websocket event stream ------------------------------------------------

  const ws = upgradeWebSocket(() => {
    let unsubscribe: (() => void) | undefined;
    return {
      onOpen(evt, ws) {
        if (ws.raw) wsClients.add(ws.raw);
        unsubscribe = core.subscribe((event) => {
          ws.send(JSON.stringify(event));
        });
      },
      onClose(evt, ws) {
        unsubscribe?.();
        if (ws.raw) wsClients.delete(ws.raw);
      },
    };
  });

  app.get("/ws", ws);

  return app;
}

/** Start the server on 127.0.0.1:port. */
export function startServer(core: LumiscaCore, port = 8000, options?: AppOptions) {
  const app = createApp(core, options);
  return Deno.serve({ hostname: "127.0.0.1", port }, app.fetch);
}
