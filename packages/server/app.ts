import { join } from "node:path";
import { Hono } from "hono";
import { upgradeWebSocket } from "hono/deno";
import { type LumiscaCore, nextRunAt } from "@lumisca/core";
import {
  hostForUrl,
  WS_HEARTBEAT_INTERVAL_MS,
  WS_HEARTBEAT_TYPE,
} from "@lumisca/core/shared";
import { Assets } from "./assets.ts";
import { languageForRequest, registerPages } from "./pages.ts";
import { installSecurityMiddleware } from "./security.ts";
import { fsRoutes } from "./routes/fs.ts";
import { workspaceRoutes } from "./routes/workspaces.ts";
import { skillRoutes } from "./routes/skills.ts";
import { sessionRoutes } from "./routes/sessions.ts";
import { stellaRoutes } from "./routes/stella.ts";
import { routineRoutes } from "./routes/routines.ts";
import { stellaScreenRoute } from "./stella-screen.ts";
import { visualRoutes } from "./routes/visuals.ts";
import { attachmentRoutes } from "./routes/attachments.ts";
import { providerRoutes } from "./routes/providers.ts";
import { settingRoutes } from "./routes/settings.ts";
import { mcpRoutes } from "./routes/mcp.ts";
import { webSearchRoutes } from "./routes/web-search.ts";
import { connectionRoutes } from "./routes/connections.ts";
import { federationRoutes } from "./routes/federation.ts";
import { type UpdateApi, updateRoutes } from "./routes/update.ts";
import { FederationClient } from "./federation.ts";
import { jsonError } from "./routes/util.ts";

export interface AppOptions {
  /** Repository root (defaults to the current working directory). */
  repoRoot?: string;
  /** Prebuilt frontend asset manifest used by packaged server builds. */
  assetsFile?: string;
  /** Address to bind (defaults to 127.0.0.1 — loopback only). Remote
   * hosting sets LUMISCA_HOST. Binding a non-loopback address without a
   * token is refused at startup (see validateHostConfig). */
  hostname?: string;
  /** Extra hostnames (without port) accepted by the Host guard, e.g. a
   * Tailscale hostname or LAN IP when hosting remotely. Loopback
   * hostnames are always accepted; DNS-rebinding protection stays intact
   * because the Host check still applies. */
  allowedHosts?: string[];
  /** When set, requests require this token: the X-Lumisca-Token header,
   * the `token` query parameter (browser WebSockets and `?token=` page
   * URLs), or the cookie a browser keeps after the first such visit (see
   * auth-cookie.ts). In production mode the page itself is also
   * guarded, so the token is a real capability, not just a barrier for
   * casual local processes. Used by the desktop shell so only its own
   * spawned server instance answers. */
  token?: string;
  /** Auto-update controller of this installation, or `undefined` when this
   * instance must not update itself. The composition root (mod.ts) passes
   * it only for a packaged server outside the desktop shell (see
   * startup.updateSupport); with `undefined` the `/api/update/*` routes are
   * not registered at all, so a development server answers 404 and the UI
   * shows no update controls. */
  update?: UpdateApi;
  /** Mutable holder for this server's origin (http://host:port), filled
   * by startServer's onListen — the real port is only known after the
   * listener binds (port 0 = ephemeral). The federation client reads it
   * lazily for its self-guard. */
  selfOrigin?: { current: string };
  /** The federation client, injected by startServer so it can start the
   * peer event streams once the origin is known. */
  fed?: FederationClient;
  /** Heartbeat cadence of the event stream (defaults to
   * `WS_HEARTBEAT_INTERVAL_MS`). Tests shorten it so a heartbeat frame
   * arrives within the test's lifetime; production never sets it. */
  heartbeatMs?: number;
}

/** Cleanup hooks per app instance, reached via disposeServer. */
const appDisposers = new WeakMap<Hono, () => void>();
const serverDisposers = new WeakMap<
  Deno.HttpServer<Deno.NetAddr>,
  () => void
>();

function disposeApp(app: Hono): void {
  appDisposers.get(app)?.();
}

/** Create the HTTP + WebSocket application. */
export function createApp(core: LumiscaCore, options: AppOptions = {}): Hono {
  const app = new Hono();
  const repoRoot = options.repoRoot ?? Deno.cwd();
  const assets = new Assets(
    repoRoot,
    join(repoRoot, ".lumisca-cache"),
    options.assetsFile,
  );

  // Federated peers (the server-side connection registry): the hub proxies
  // their workspaces/sessions and relays their events, tagged with the
  // peer id so the UI can route them to the right tabs. startServer injects
  // its own client (started once the real origin is known); direct
  // createApp usage gets a client with no self-guard.
  const fed = options.fed ??
    new FederationClient(
      () => core.getConnections(),
      () => options.selfOrigin?.current ?? "",
    );
  if (!options.fed) fed.start();

  // Host guard, token, CORS, and the WS Origin check.
  installSecurityMiddleware(app, options, (c) => languageForRequest(core, c));

  // Route handlers throw instead of catching: unify error responses here.
  app.onError((error, c) => {
    return jsonError(c, error);
  });

  // Unknown API paths answer JSON like every other error, not an empty body.
  app.notFound((c) => {
    if (c.req.path.startsWith("/api") || c.req.path === "/ws") {
      return c.json({ error: "Not found" }, 404);
    }
    return c.text("Not found", 404);
  });

  appDisposers.set(app, () => {
    fed.close();
  });

  // `now` proves the event loop itself is alive (not just the listener
  // accepting connections): the desktop UI uses it to tell a hung server
  // apart from a healthy one.
  app.get("/api/health", (c) => c.json({ ok: true, now: Date.now() }));

  // --- page and static assets ----------------------------------------------

  const pages = registerPages(app, core, assets, {
    token: options.token,
  });

  // --- API routes (before the SPA fallback; unmatched /api paths fall
  // through to notFound, which answers JSON like every other error) --------

  app.route("/api", fsRoutes());
  app.route("/api", workspaceRoutes(core));
  app.route("/api", skillRoutes(core));
  app.route("/api", mcpRoutes(core, (c) => languageForRequest(core, c)));
  // Web search: its own surface because the setting holds API keys (the
  // generic /settings surface filters it out).
  app.route("/api", webSearchRoutes(core));
  app.route("/api", sessionRoutes(core));
  app.route("/api", stellaRoutes(core));
  // Routines: the scheduled requests of a stella conversation. Addressed by
  // agent, because a routine belongs to one conversation.
  app.route(
    "/api",
    routineRoutes({
      listRoutinesOf: (agentId) => core.listRoutinesOf(agentId),
      isRoutineRunning: (id) => core.isRoutineRunning(id),
      runRoutineNow: (id) => core.runRoutineNow(id),
      stopRoutine: (id) => core.stopRoutine(id),
      getRoutineRepo: () => core.getRoutineRepo(),
      listStellaAgents: () => core.listStellaAgents(),
      nextRoutineRun: (schedule, from) => nextRunAt(schedule, from),
    }),
  );
  // The images a session published for its replies. Mounted after the
  // session routes (its path is its own `/sessions/:id/visual/:name`).
  app.route("/api", visualRoutes(core));
  // The files an agent attached to its reply (`chat_attach`). Their own
  // path shape, like the visuals above.
  app.route("/api", attachmentRoutes(core));
  app.route("/api", providerRoutes(core));
  app.route("/api", settingRoutes(core));
  app.route("/api", connectionRoutes(core, () => fed.restart()));
  app.route("/api", federationRoutes(fed));
  // Auto-update of the standalone server (absent in development, where the
  // routes are not registered at all and the UI gets a 404 → no controls).
  if (options.update !== undefined) {
    app.route("/api", updateRoutes(options.update));
  }

  // --- websocket event stream ------------------------------------------------

  const ws = upgradeWebSocket(() => {
    let unsubscribe: (() => void) | undefined;
    let unsubscribeFed: (() => void) | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const send = (ws: { send(data: string): void }, payload: unknown) => {
      // The socket may have closed between the event and the send (the
      // unsubscribe below runs on close, but a concurrent event can race
      // it); a throw here would kill the subscribe handler.
      try {
        ws.send(JSON.stringify(payload));
      } catch {
        // connection is gone; nothing to do
      }
    };
    return {
      onOpen(_evt, ws) {
        unsubscribe = core.subscribe((event) => {
          // Every event carries the peer id ("" = this server) so the UI
          // routes it to the right session tab, and — for session events —
          // the emitting session's revision, which lets the client detect a
          // lost frame without another round trip (see
          // core.getSessionRevision).
          const rev = "sessionId" in event
            ? { rev: core.getSessionRevision(event.sessionId) }
            : {};
          send(ws, { peerId: "", ...rev, ...event });
        });
        // Federated peers' events, tagged with their id. The peer's own
        // `peerId` marker ("" on its side) is stripped first, so the tag
        // is always the id this hub knows.
        unsubscribeFed = fed.subscribe((peerId, event) => {
          const { peerId: _stale, ...rest } = event as Record<string, unknown>;
          send(ws, { peerId, ...rest });
        });
        // Liveness of an idle stream: silence is indistinguishable from a
        // socket that died without a close event (a NAT/proxy timeout, a
        // suspended page), so the server proves it is still there on a
        // fixed cadence (see core/shared/heartbeat.ts). The frame is
        // transport-level, not a ClientEvent: the client swallows it and
        // only refreshes its watchdog.
        heartbeat = setInterval(() => {
          send(ws, { type: WS_HEARTBEAT_TYPE });
        }, options.heartbeatMs ?? WS_HEARTBEAT_INTERVAL_MS);
      },
      onClose() {
        if (heartbeat !== undefined) clearInterval(heartbeat);
        unsubscribe?.();
        unsubscribeFed?.();
      },
    };
  });

  app.get("/ws", ws);
  // The stella machine's screen relay. Mounted under /api so the Host guard,
  // the token and the CORS/Origin middleware above all apply — the container's
  // VNC port stays unreachable from the page.
  app.get(
    "/api/stella/screen",
    stellaScreenRoute({
      vncPort: async () => {
        const vm = core.getStellaVm();
        return vm === undefined ? null : await vm.vncPort();
      },
    }),
  );

  // SPA fallback (registered last): any other page renders the app shell.
  // The /api next() guard is defensive only — API routes above already
  // matched — but keeps unknown API paths on the JSON error path.
  app.get("*", (c, next) => {
    if (c.req.path.startsWith("/api") || c.req.path === "/ws") {
      return next();
    }
    // Unknown static assets (e.g. /favicon.ico) get a real 404 instead of
    // the HTML shell, so browsers and CDNs do not cache a wrong document.
    if (/\.\w+$/.test(c.req.path)) {
      return c.text("Not found", 404);
    }
    return pages.renderPage(c);
  });

  return app;
}

/** Start the server, bound to `options.hostname` (loopback by default). */
export function startServer(
  core: LumiscaCore,
  port = 8000,
  options?: AppOptions,
): Deno.HttpServer<Deno.NetAddr> {
  const hostname = options?.hostname ?? "127.0.0.1";
  // The hub's real origin is only known after binding (port 0 =
  // ephemeral); the federation self-guard reads it through this holder,
  // and the peer event streams start once it is known.
  const selfOrigin: { current: string } = { current: "" };
  const fed = new FederationClient(
    () => core.getConnections(),
    () => selfOrigin.current,
  );
  const app = createApp(core, { ...options, selfOrigin, fed });
  const server = Deno.serve(
    {
      hostname,
      port,
      onListen(addr) {
        // `hostForUrl` brackets IPv6 literals and maps a wildcard bind to
        // loopback: `http://::1:8000` is not a URL, so a bare concatenation
        // used to leave the hub unable to recognise its own origin (every
        // peer looked remote, including the hub itself).
        selfOrigin.current = `http://${hostForUrl(addr.hostname)}:${addr.port}`;
        fed.start();
      },
    },
    app.fetch,
  );
  serverDisposers.set(server, () => disposeApp(app));
  return server;
}

/** Release resources tied to a running server (e.g. the dev watcher).
 * Call before server.shutdown() when shutting down gracefully. */
export function disposeServer(server: Deno.HttpServer<Deno.NetAddr>): void {
  serverDisposers.get(server)?.();
}
