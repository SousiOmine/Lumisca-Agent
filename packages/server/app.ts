import { join } from "node:path";
import type { LumiscaCore } from "@lumisca/core";
import { hostForUrl } from "@lumisca/core/shared";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import { compress } from "hono/compress";
import { Assets } from "./assets.ts";
import { FederationClient } from "./federation.ts";
import { initialDataFor, languageForRequest, registerPages } from "./pages.ts";
import { createPushNotifier } from "./push.ts";
import { DEV_RELOAD_SCRIPT } from "./render.ts";
import { attachmentRoutes } from "./routes/attachments.ts";
import { federationRoutes } from "./routes/federation.ts";
import { fsRoutes } from "./routes/fs.ts";
import { mcpRoutes } from "./routes/mcp.ts";
import { notifyRoutes } from "./routes/notify.ts";
import { PromptUploads, promptUploadRoutes } from "./routes/prompt-uploads.ts";
import { providerRoutes } from "./routes/providers.ts";
import { routineRoutes } from "./routes/routines.ts";
import { sessionRoutes } from "./routes/sessions.ts";
import { settingRoutes } from "./routes/settings.ts";
import { setupRoutes } from "./routes/setup.ts";
import { shareHostRoutes } from "./routes/share.ts";
import { skillRoutes } from "./routes/skills.ts";
import { stellaRoutes } from "./routes/stella.ts";
import { stellaAssetRoutes } from "./routes/stella-assets.ts";
import { type UpdateApi, updateRoutes } from "./routes/update.ts";
import { jsonError } from "./routes/util.ts";
import { visualRoutes } from "./routes/visuals.ts";
import { webSearchRoutes } from "./routes/web-search.ts";
import { workspaceRoutes } from "./routes/workspaces.ts";
import { createEventStream } from "./routes/ws-stream.ts";
import { installSecurityMiddleware } from "./security.ts";
import { stellaScreenRoute } from "./stella-screen.ts";
import { upgradeWebSocket } from "./websocket.ts";

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
  /** Identity this server answers in `/api/health` (defaults to a fresh
   * uuid per app). It is what lets a hub tell its own name from a peer's:
   * the same server is reachable as its tailnet name, its LAN address or
   * through a proxy, and the URL alone cannot say so (see
   * federation.ts's identityOf). */
  instanceId?: string;
  /** Heartbeat cadence of the event stream (defaults to
   * `WS_HEARTBEAT_INTERVAL_MS`). Tests shorten it so a heartbeat frame
   * arrives within the test's lifetime; production never sets it. */
  heartbeatMs?: number;
  /** How long a streamed delta waits for company before it is sent as one
   * frame (defaults to `WS_DELTA_FLUSH_MS`). Tests shorten it so a run's
   * whole reply arrives in a frame or two without waiting out the display
   * interval; production never sets it. */
  deltaFlushMs?: number;
  /** Transport of the PWA notifications (Web Push). Tests inject a fake push
   * service; production leaves it unset, which uses the process's `fetch`. */
  pushFetch?: typeof fetch;
  /** Directory for files the browser is still uploading (defaults to
   * `.lumisca-uploads` under the repository root). */
  uploadDir?: string;
  /** Development only: serve the reload script and accept rebuild requests
   * from scripts/dev.ts. */
  devReload?: boolean;
}

/** The HTTP + WebSocket application and the one way to release what it
 * owns (the federation client, the push notifier, the upload store, and the
 * login sessions the provider routes own). The two are one value so a caller
 * cannot hold the app without also holding its teardown. */
export interface ServerApp {
  readonly app: Hono;
  /** Release everything the app started. Runs its hooks once. */
  dispose(): void;
}

/** A started server: the address it bound and the way to stop it. It owns the
 * ServerApp it serves, so a stop releases the app's resources (and then the
 * listener) — there is no separate teardown to remember. */
export interface LumiscaServer {
  readonly addr: { readonly hostname: string; readonly port: number };
  /** Release the app's resources, then stop the listener. */
  shutdown(): void;
}

/** Create the HTTP + WebSocket application. */
export function createApp(
  core: LumiscaCore,
  options: AppOptions = {},
): ServerApp {
  const app = new Hono();
  const repoRoot = options.repoRoot ?? process.cwd();
  const assets = new Assets(
    repoRoot,
    join(repoRoot, ".lumisca-cache"),
    options.assetsFile,
  );
  const promptUploads = new PromptUploads({
    dir: options.uploadDir ?? join(repoRoot, ".lumisca-uploads"),
    core: {
      getStellaAgent: (id) => core.services.stellaAgents.getStellaAgent(id),
      ensureStellaReady: (agentId) =>
        core.services.stellaMachines.ensureStellaReady(agentId),
      getOrCreateStellaSession: (agentId) =>
        core.internals.getOrCreateStellaSession(agentId),
      savePromptFile: (sessionId, file, signal) =>
        core.services.sessions.savePromptFile(sessionId, file, signal),
    },
  });
  // The first agent is created with the app's own picture, not an initial.
  // Read through the server's asset manifest, so a packaged server carries
  // the same image the PWA installs with.
  core.services.stellaAgents.setStarterAgentIcon(() =>
    assets.getPwaIcon("icon-192.png"),
  );

  // Federated peers (the server-side connection registry): the hub proxies
  // their workspaces/sessions and relays their events, tagged with the
  // peer id so the UI can route them to the right tabs. startServer injects
  // its own client (started once the real origin is known); direct
  // createApp usage gets a client with no self-guard.
  const instanceId = options.instanceId ?? crypto.randomUUID();
  const fed =
    options.fed ??
    new FederationClient(
      () => core.settings.connections(),
      () => options.selfOrigin?.current ?? "",
      { selfId: () => instanceId },
    );
  if (!options.fed) fed.start();

  // PWA notifications: the notifier subscribes to the core's events as soon
  // as it exists, so it is created here (beside the federation client) and
  // released by this app's disposer. The routes below only add and remove
  // subscriptions; what reaches a device is decided in push.ts.
  const push = createPushNotifier({
    core: {
      subscribe: (listener) => core.subscribe(listener),
      getSession: (id) => core.services.sessions.getSession(id),
      getStellaAgent: (id) => core.services.stellaAgents.getStellaAgent(id),
      listPushSubscriptions: () => core.services.push.list(),
      pushVapidKeys: () => core.services.push.vapidKeys(),
      forgetPushSubscriptions: (endpoints) =>
        core.services.push.removeEndpoints(endpoints),
    },
    language: () => core.settings.language(),
    ...(options.pushFetch === undefined ? {} : { fetch: options.pushFetch }),
  });

  const sessions = core.services.sessions;

  // Host guard, token, CORS, and the WS Origin check.
  installSecurityMiddleware(app, options, (c) => languageForRequest(core, c));

  // Compress the bodies a client actually pays for. The app is opened over a
  // tailnet or a WAN as often as on loopback, and everything it serves is
  // text: a 600 KB client bundle, a 140 KB stylesheet inlined into the page,
  // and JSON snapshots of a transcript. Uncompressed, each is several times
  // its size on a link where that is the difference between a second and
  // several. The threshold keeps small answers (a health probe, a panel
  // snapshot with one row) from paying for a compressor that would not win;
  // images and fonts are not compressible and are skipped by content type.
  app.use("*", compress());

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

  // A shutdown may be reached from two places (the updater's restart and a
  // signal); releasing twice would close the peer streams and the upload
  // store twice over, so the first call owns the teardown.
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    fed.close();
    push.dispose();
    promptUploads.dispose();
    providers.dispose();
  };

  // `now` proves the event loop itself is alive (not just the listener
  // accepting connections): the desktop UI uses it to tell a hung server
  // apart from a healthy one. `instanceId` identifies this running server:
  // the federation client probes it to recognise this hub registered under
  // another of its URLs (see federation.ts).
  //
  // Nothing here is awaited, and in particular the client build is NOT
  // reported here. Its first read after a start runs esbuild — measured
  // 740ms on an idle machine, several seconds on a loaded CI runner — while
  // every caller of this route allows it a few seconds (a federation peer
  // probe gives up at 3s, the desktop shell's startup check at 3s). Waiting
  // for the bundle made liveness cost as much as a full frontend build, and
  // a live peer was reported as down when the machine was busy. The build id
  // has its own route (`/api/build`), asked for by the one client that
  // compares it.
  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      now: Date.now(),
      instanceId,
    }),
  );

  /** The client build this process serves (see Assets.buildId). Split from
   * `/api/health` because the two questions have different budgets: "is this
   * machine up" is asked with seconds to spare and must not wait for a
   * frontend build; "has the bundle been replaced" is asked once a minute by
   * an open page, which can afford to wait for the first build. */
  app.get("/api/build", async (c) =>
    c.json({
      buildId: await assets.buildId().catch(() => undefined),
    }),
  );

  /** The initial data of a client that is not served by this server: the
   * desktop shell bundles the UI and boots it against this API, so the same
   * object the page's bootstrap script carries (see pages.ts) is answered
   * here as JSON. Guarded like every other API route. */
  app.get("/api/initial-data", async (c) =>
    c.json(await initialDataFor(core, assets, c)),
  );

  // --- page and static assets ----------------------------------------------

  if (options.devReload === true) {
    app.get("/assets/dev-reload.js", (c) =>
      c.body(DEV_RELOAD_SCRIPT, 200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
      }),
    );
    app.post("/api/dev/rebuild", (c) => {
      assets.invalidate();
      return c.json({ ok: true });
    });
  }
  const pages = registerPages(app, core, assets, {
    token: options.token,
    ...(options.devReload === true ? { devReload: true } : {}),
  });

  // --- API routes (before the SPA fallback; unmatched /api paths fall
  // through to notFound, which answers JSON like every other error) --------

  app.route("/api", fsRoutes());
  app.route("/api", workspaceRoutes(core.services.workspaces));
  app.route("/api", skillRoutes(core.services.sessions));
  app.route(
    "/api",
    mcpRoutes(core.services.mcp, (c) => languageForRequest(core, c)),
  );
  // Web search: its own surface because the setting holds API keys (the
  // generic /settings surface filters it out).
  app.route("/api", webSearchRoutes(core.services.webSearch));
  app.route(
    "/api",
    sessionRoutes({
      sessions: core.services.sessions,
      getSessionRevision: (id) => core.getSessionRevision(id),
    }),
  );
  // stella mode's own surface. It takes no delta-flush option: a
  // conversation has no streaming text (a message arrives when its turn
  // ends), so there is no batch to time.
  app.route(
    "/api",
    stellaRoutes(
      {
        listStellaAgentSummaries: () =>
          core.services.stellaAgents.listStellaAgentSummaries(),
        ensureStellaAgent: () => core.services.stellaAgents.ensureStellaAgent(),
        createStellaAgent: (input) =>
          core.services.stellaAgents.createStellaAgent(input),
        updateStellaAgent: (id, patch) =>
          core.services.stellaAgents.updateStellaAgent(id, patch),
        deleteStellaAgent: (id) =>
          core.services.stellaAgents.deleteStellaAgent(id),
        getStellaStatus: () => core.services.stellaMachines.getStellaStatus(),
        getStellaAgentStatus: (agentId) =>
          core.services.stellaMachines.stellaAgentStatus(agentId),
        wakeStellaAgent: (agentId) =>
          core.services.stellaMachines.wakeStellaAgent(agentId),
        touchStellaAgent: (agentId) =>
          core.services.stellaMachines.touchStellaAgent(agentId),
        getOrCreateStellaSession: (agentId) =>
          core.internals.getOrCreateStellaSession(agentId),
        startStellaOnboarding: (agentId) =>
          core.services.stellaAgents.startOnboarding(agentId),
        ensureStellaReady: (agentId) =>
          core.services.stellaMachines.ensureStellaReady(agentId),
        ensureStellaSkills: (agentId) =>
          core.services.stellaMachines.ensureStellaSkills(agentId),
        findStellaSession: (agentId) => sessions.findStellaSession(agentId),
        readStellaConversation: (sessionId, query) =>
          sessions.readStellaConversation(sessionId, query),
        readStellaConversationFromStore: (sessionId, query) =>
          sessions.readStellaConversationFromStore(sessionId, query),
        searchStellaConversation: (sessionId, query, limit) =>
          sessions.searchStellaConversation(sessionId, query, limit),
        getPendingQuestions: (sessionId) =>
          sessions.getPendingQuestions(sessionId),
        getPendingHandover: (sessionId) =>
          core.services.interruptions.getPendingHandover(sessionId),
        getPendingEnvRequest: (sessionId) =>
          core.services.interruptions.getPendingEnvRequest(sessionId),
        getPendingShareRequest: (sessionId) =>
          core.services.interruptions.getPendingShareRequest(sessionId),
        finishShareLend: (sessionId, toolCallId) =>
          core.services.interruptions.finishShareLend(sessionId, toolCallId),
        declineShareRequest: (sessionId, toolCallId) =>
          core.services.interruptions.declineShareRequest(
            sessionId,
            toolCallId,
          ),
        finishShareDisconnect: (sessionId, toolCallId) =>
          core.services.interruptions.finishShareDisconnect(
            sessionId,
            toolCallId,
          ),
        failShareDisconnect: (sessionId, toolCallId, error) =>
          core.services.interruptions.failShareDisconnect(
            sessionId,
            toolCallId,
            error,
          ),
        getShares: (sessionId) => core.shares.sharesFor(sessionId),
        getSessionLastError: (sessionId) =>
          sessions.getSessionLastError(sessionId),
        getSession: (sessionId) => sessions.getSession(sessionId),
        getThinkingState: (sessionId) => sessions.getThinkingState(sessionId),
        getAgent: (sessionId) => sessions.getAgent(sessionId),
        getStellaAgent: (id) => core.services.stellaAgents.getStellaAgent(id),
        openSession: (sessionId) => sessions.openSession(sessionId),
        startPrompt: (sessionId, text, images, mode, files) =>
          sessions.startPrompt(sessionId, text, images, mode, files),
        savePromptImages: (sessionId, uploads) =>
          sessions.savePromptImages(sessionId, uploads),
        abort: (sessionId) => sessions.abort(sessionId),
        rewind: (sessionId, timestamp) => sessions.rewind(sessionId, timestamp),
        setSessionModel: (sessionId, provider, modelId) =>
          sessions.setSessionModel(sessionId, provider, modelId),
        answerQuestion: (sessionId, toolCallId, answers) =>
          sessions.answerQuestion(sessionId, toolCallId, answers),
        finishHandover: (sessionId, note, toolCallId) =>
          core.services.interruptions.finishHandover(
            sessionId,
            note,
            toolCallId,
          ),
        provideStellaEnv: (sessionId, value, toolCallId) =>
          core.services.stellaMachines.provideEnv(sessionId, value, toolCallId),
        declineStellaEnv: (sessionId, toolCallId) =>
          core.services.stellaMachines.declineEnv(sessionId, toolCallId),
        readStellaClipboard: (sessionId) =>
          core.services.stellaMachines.readClipboard(
            sessions.requireSession(sessionId),
          ),
        writeStellaClipboard: (sessionId, text) =>
          core.services.stellaMachines.writeClipboard(
            sessions.requireSession(sessionId),
            text,
          ),
        subscribe: (listener) => core.subscribe(listener),
        getSessionRevision: (sessionId) => core.getSessionRevision(sessionId),
      },
      promptUploads,
    ),
  );
  // The chunks of a file the browser is attaching to a prompt: their own
  // routes because the body is raw bytes, not the API's JSON.
  app.route("/api", promptUploadRoutes(promptUploads));
  // An agent's picture and a prompt's uploaded file: raw bytes, same prefix.
  app.route(
    "/api",
    stellaAssetRoutes({
      getStellaAgent: (id) => core.services.stellaAgents.getStellaAgent(id),
      resolveStellaAgentIcon: (agentId, name) =>
        core.services.stellaAgents.resolveStellaAgentIcon(agentId, name),
      resolvePromptUpload: (agentId, ref) =>
        core.services.sessions.resolvePromptUpload(agentId, ref),
    }),
  );
  // Routines: the scheduled requests of a stella conversation. Addressed by
  // agent, because a routine belongs to one conversation.
  app.route("/api", routineRoutes(core.routines, core.services.stellaAgents));
  // The images a session published for its replies. Mounted after the
  // session routes (its path is its own `/sessions/:id/visual/:name`).
  app.route(
    "/api",
    visualRoutes({
      getSession: (id) => sessions.getSession(id),
      resolveSessionVisual: (sessionId, name) =>
        sessions.resolveSessionVisual(sessionId, name),
    }),
  );
  // The files an agent handed to the user (`chat_attach` in code mode,
  // `send_chat`'s attachments in stella). Their own path shape, like the
  // visuals above.
  app.route(
    "/api",
    attachmentRoutes({
      getSession: (id) => sessions.getSession(id),
      resolveSessionAttachment: (sessionId, name) =>
        sessions.resolveSessionAttachment(sessionId, name),
    }),
  );
  const providers = providerRoutes(core.services.models);
  app.route("/api", providers.app);
  app.route(
    "/api",
    settingRoutes({
      listSettings: () => core.settings.list(),
      setUserSetting: (key, value) => core.settings.setUser(key, value),
      setComputerUseEnabled: (enabled) =>
        core.capabilities.setComputerUseEnabled(enabled),
      setCodeExecutionEnabled: (enabled) =>
        core.capabilities.setCodeExecutionEnabled(enabled),
      setAskToolEnabled: (enabled) =>
        core.capabilities.setAskToolEnabled(enabled),
      setAppUiInSystemPrompt: (enabled) =>
        core.capabilities.setAppUiInSystemPrompt(enabled),
      getPersonalization: () => core.services.personalization.get(),
      setPersonalization: (content) =>
        core.services.personalization.set(content),
      getCommandApprovals: () => core.settings.commandApprovals(),
      deleteCommandApproval: (hash) =>
        core.settings.deleteCommandApproval(hash),
      clearCommandApprovals: () => core.settings.clearCommandApprovals(),
      getSavedPrompts: () => core.services.savedPrompts.list(),
      addSavedPrompt: (input) => core.services.savedPrompts.add(input),
      updateSavedPrompt: (id, input) =>
        core.services.savedPrompts.update(id, input),
      deleteSavedPrompt: (id) => core.services.savedPrompts.delete(id),
    }),
  );
  // The first-run setup's state: a file beside the settings file, so this
  // server answers for one installation (and every client of it).
  app.route(
    "/api",
    setupRoutes({
      getSetup: () => core.settings.setup(),
      completeSetup: () => core.settings.completeSetup(),
    }),
  );
  app.route(
    "/api",
    notifyRoutes(core.services.push, () => push.sendTest()),
  );
  app.route("/api", federationRoutes(fed));
  // Auto-update of the standalone server (absent in development, where the
  // routes are not registered at all and the UI gets a 404 → no controls).
  if (options.update !== undefined) {
    app.route("/api", updateRoutes(options.update));
  }

  // --- websocket event stream ------------------------------------------------

  // One socket carries every session of this server and the events relayed
  // from federated peers (tagged with the peer's id). The batching, the
  // heartbeat and the teardown are routes/ws-stream.ts's; only what this
  // stream lets through is stated here.
  const ws = upgradeWebSocket(() =>
    createEventStream({
      ...(options.deltaFlushMs === undefined
        ? {}
        : { flushMs: options.deltaFlushMs }),
      subscribe: (listener) => core.subscribe(listener),
      // Every core event belongs to this stream (the projection below
      // decides its shape).
      accept: () => true,
      revOf: (event) =>
        "sessionId" in event
          ? core.getSessionRevision(event.sessionId)
          : undefined,
      delta: {
        key: (event) => ("sessionId" in event ? event.sessionId : ""),
        frame: ({ key, delta, rev, events }) => ({
          peerId: "",
          sessionId: key,
          rev,
          events,
          type: "message_delta",
          delta,
        }),
      },
      project: (event, rev) => {
        // Every event carries the peer id ("" = this server) so the UI
        // routes it to the right session tab, and — for session events —
        // the emitting session's revision, which lets the client detect a
        // lost frame without another round trip (see
        // core.getSessionRevision).
        return [
          {
            peerId: "",
            ...(rev === undefined ? {} : { rev }),
            ...event,
          },
        ];
      },
      // Federated peers' events, tagged with their id. The peer's own
      // `peerId` marker ("" on its side) is stripped first, so the tag is
      // always the id this hub knows. A relayed delta was already batched
      // by the peer; it goes out through `send`, so this socket's own
      // buffered text cannot overtake it.
      relay: (writer) =>
        fed.subscribe((peerId, event) => {
          const { peerId: _stale, ...rest } = event as Record<string, unknown>;
          writer.send({ peerId, ...rest });
        }),
      ...(options.heartbeatMs === undefined
        ? {}
        : { heartbeatMs: options.heartbeatMs }),
    }),
  );
  app.get("/ws", ws);
  // The lending apps' socket (desktop computers that lend folders to a
  // conversation, see core/share). Under /api so the Host guard, the token
  // and the middleware above apply unchanged; the app sends no Origin, which
  // the Origin rule allows.
  app.get("/api/share/host", shareHostRoutes(core.shares));
  // The stella machine's screen relay. Mounted under /api so the Host guard,
  // the token and the CORS/Origin middleware above all apply — the container's
  // VNC port stays unreachable from the page.
  app.get(
    "/api/stella/screen",
    stellaScreenRoute({
      // One desktop per agent: the pane names the conversation it belongs
      // to, and the port follows that agent's slot.
      vncPort: async (agentId) => {
        if (agentId === null) return null;
        return await core.services.stellaMachines.stellaVncPort(agentId);
      },
      // The pane is the user looking at the desktop: keep the machine warm
      // while it is open. A close restarts the idle clock from that moment.
      watch: (agentId) =>
        core.services.stellaMachines.watchStellaAgent(agentId),
      unwatch: (agentId) =>
        core.services.stellaMachines.unwatchStellaAgent(agentId),
    }),
  );

  // SPA fallback (registered last): any other page renders the app shell.
  // The /api next() guard is defensive only — API routes above already
  // matched — but keeps unknown API paths on the JSON error path.
  app.get("*", async (c, next) => {
    if (c.req.path.startsWith("/api") || c.req.path === "/ws") {
      // `next()` settles after the notFound handler has answered; returning
      // its void result would make the handler's type a union that Hono's
      // overloads reject, so the response is left to the dispatcher.
      await next();
      return;
    }
    // Unknown static assets (e.g. /favicon.ico) get a real 404 instead of
    // the HTML shell, so browsers and CDNs do not cache a wrong document.
    if (/\.\w+$/.test(c.req.path)) {
      return c.text("Not found", 404);
    }
    return pages.renderPage(c);
  });

  return { app, dispose };
}

/** Start the server, bound to `options.hostname` (loopback by default). */
export function startServer(
  core: LumiscaCore,
  port = 8000,
  options?: AppOptions,
): LumiscaServer {
  const hostname = options?.hostname ?? "127.0.0.1";
  // The hub's real origin is only known after binding (port 0 =
  // ephemeral); the federation self-guard reads it through this holder,
  // and the peer event streams start once it is known.
  const selfOrigin: { current: string } = { current: "" };
  const instanceId = crypto.randomUUID();
  const fed = new FederationClient(
    () => core.settings.connections(),
    () => selfOrigin.current,
    { selfId: () => instanceId },
  );
  const app = createApp(core, { ...options, selfOrigin, fed, instanceId });
  const binding = Bun.serve({
    hostname,
    port,
    fetch: (request, server) => app.app.fetch(request, server),
    websocket,
  });
  // `hostForUrl` brackets IPv6 literals and maps a wildcard bind to
  // loopback: `http://::1:8000` is not a URL, so a bare concatenation used
  // to leave the hub unable to recognise its own origin (every peer looked
  // remote, including the hub itself).
  const addr = { hostname: binding.hostname, port: binding.port };
  selfOrigin.current = `http://${hostForUrl(addr.hostname)}:${addr.port}`;
  fed.start();
  return {
    addr,
    shutdown: () => {
      app.dispose();
      binding.stop(true);
    },
  };
}
