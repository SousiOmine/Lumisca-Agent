import { test } from "bun:test";
import * as fsp from "node:fs/promises";
import { conversationVerbs, paths, routePath } from "@lumisca/core/shared";
import { assert, assertEquals } from "@std/assert";
import { Hono } from "hono";
import { attachmentRoutes } from "../routes/attachments.ts";
import { promptUploadRoutes } from "../routes/prompt-uploads.ts";
import { routineRoutes } from "../routes/routines.ts";
import { sessionRoutes } from "../routes/sessions.ts";
import { stellaRoutes } from "../routes/stella.ts";
import { stellaAssetRoutes } from "../routes/stella-assets.ts";
import { visualRoutes } from "../routes/visuals.ts";

/**
 * The API's paths are written once (core/shared/api-paths.ts): the server
 * registers a template's route form, the web client fills the same template
 * with ids. Nothing else makes the two halves agree, so this test does:
 *
 *  1. every path the API registers is a template from that module (a route
 *     written by hand would not match), and
 *  2. no route module still writes a literal path for a family the module
 *     covers — a second registration of the same endpoint is invisible at
 *     runtime (Hono answers the first one), which is exactly how rewind
 *     ended up with two handlers.
 *
 * A path renamed in api-paths.ts changes what the server registers, so the
 * client's requests (api-local_test, api-stella_test) break with it.
 */

/** A stand-in core: recording every call is not the point here, only that
 * building the app reads nothing before it answers. */
function inert(overrides: Record<string, unknown> = {}): never {
  return new Proxy(overrides, {
    get(object, property) {
      if (property in object) return object[property as string];
      if (typeof property !== "string" || property === "then") return undefined;
      return () => {
        throw new Error(`unexpected call: ${property}`);
      };
    },
  }) as never;
}

/** The apps that mount the templates, under the `/api` prefix app.ts uses. */
function apiApp(): Hono {
  const app = new Hono();
  app.route("/api", sessionRoutes(inert() as never));
  app.route("/api", stellaRoutes(inert() as never));
  app.route("/api", routineRoutes(inert() as never, inert() as never));
  // The asset and upload routes only need their handlers' signatures.
  app.route("/api", promptUploadRoutes(inert() as never));
  app.route("/api", stellaAssetRoutes(inert() as never));
  app.route("/api", visualRoutes(inert() as never));
  app.route("/api", attachmentRoutes(inert() as never));
  return app;
}

/** Every path the modules above register, as `METHOD /path`. */
function registered(app: Hono): Set<string> {
  return new Set(
    app.routes
      .filter((route) => route.method !== "ALL")
      .map((route) => `${route.method} ${route.path}`),
  );
}

/** The same paths, built from the templates: the list this test keeps in
 * step with api-paths.ts. Each entry names the shared template the route
 * must be registered from. */
const EXPECTED: Array<[method: string, template: string]> = [
  ["GET", paths.sessions],
  ["GET", paths.sessionDefaultModel],
  ["GET", paths.session],
  ["GET", paths.sessionMessages],
  ["GET", paths.sessionRevision],
  ["GET", paths.sessionTodo],
  ["GET", paths.sessionTasks],
  ["GET", paths.sessionBackground],
  ["POST", paths.sessions],
  ["POST", paths.sessionOpen],
  ["POST", paths.sessionClose],
  ["DELETE", paths.session],
  ["POST", paths.sessionPrompt],
  ["POST", paths.sessionAbort],
  ["POST", paths.sessionAnswer],
  ["POST", paths.sessionRewind],
  ["POST", paths.sessionModel],
  ["POST", paths.sessionCompact],
  ["GET", paths.sessionVisual],
  ["GET", paths.sessionAttachment],
  ["GET", paths.stellaStatus],
  ["GET", paths.stellaAgents],
  ["POST", paths.stellaAgents],
  ["PATCH", paths.stellaAgent],
  ["DELETE", paths.stellaAgent],
  ["GET", paths.stellaAgentMachine],
  ["POST", paths.stellaAgentWake],
  ["POST", paths.stellaAgentTouch],
  ["GET", paths.stellaAgentIcon],
  ["GET", paths.stellaAgentRoutines],
  ["PATCH", paths.routine],
  ["DELETE", paths.routine],
  ["POST", paths.routineRun],
  ["POST", paths.routineStop],
  ["GET", paths.conversation],
  ["GET", paths.conversationMessages],
  ["GET", paths.conversationRevision],
  ["POST", paths.conversationPrompt],
  ["POST", paths.conversationAbort],
  ["POST", paths.conversationAnswer],
  ["POST", paths.conversationRewind],
  ["POST", paths.conversationHandover],
  ["POST", paths.conversationEnv],
  ["POST", paths.conversationEnvDecline],
  ["POST", paths.conversationShareLend],
  ["POST", paths.conversationShareDecline],
  ["POST", paths.conversationShareDisconnect],
  ["GET", paths.conversationClipboard],
  ["POST", paths.conversationClipboard],
  ["GET", paths.conversationEvents],
  ["GET", paths.conversationUpload],
  ["POST", paths.conversationUploads],
  ["PUT", paths.upload],
  ["GET", paths.upload],
  ["POST", paths.uploadComplete],
  ["DELETE", paths.upload],
];

test("every registered API path comes from the shared templates", () => {
  const actual = registered(apiApp());
  const expected = new Set(
    EXPECTED.map(
      ([method, template]) => `${method} /api${routePath(template)}`,
    ),
  );
  const missing = [...expected].filter((key) => !actual.has(key));
  assertEquals(
    missing,
    [],
    "the server registers a different path than core/shared/api-paths.ts states",
  );
});

test("no route module writes a literal path for a family the templates cover", async () => {
  const here = import.meta.url;
  const dir = new URL("./", here);
  // The families this change moved onto the templates. A route family that
  // still writes its own literals is a later step, not a regression here.
  const covered = /^(?:\/sessions|\/stella|\/routines)/;
  const offenders: string[] = [];
  for (const entry of await fsp.readdir(dir)) {
    if (!entry.endsWith(".ts") || entry.includes("_test.")) continue;
    const text = await fsp.readFile(new URL(entry, dir), "utf8");
    for (const match of text.matchAll(
      /\bapp\.(?:get|post|put|patch|delete|all)\(\s*["`]([^"`]+)["`]/g,
    )) {
      const path = match[1]!;
      if (!covered.test(path)) continue;
      offenders.push(`${entry}: ${path}`);
    }
  }
  assertEquals(
    offenders,
    [],
    "routes install these paths through routePath(paths.<name>)",
  );
});

test("a template keeps the id parameter each handler reads", () => {
  // The typed form is what makes a mismatch a type error at the call site;
  // this pins the two names handlers read.
  assert(
    routePath(paths.session) === "/sessions/:id",
    routePath(paths.session),
  );
  assertEquals(routePath(paths.conversation), "/stella/conversations/:agentId");
  assertEquals(routePath(paths.stellaAgent), "/stella/agents/:id");
  assertEquals(
    routePath(paths.upload),
    "/stella/conversations/:agentId/uploads/:uploadId",
  );
});

test("the shared verb suffixes are the templates' own tails", () => {
  // conversationRoutes installs `base + verb` on either base (routes/
  // conversation.ts), so the two families' templates must end with the same
  // suffixes the builder adds.
  const tails: Array<[template: string, verb: string]> = [
    [paths.sessionAbort, conversationVerbs.abort],
    [paths.sessionAnswer, conversationVerbs.answer],
    [paths.sessionRewind, conversationVerbs.rewind],
    [paths.sessionModel, conversationVerbs.model],
    [paths.conversationAbort, conversationVerbs.abort],
    [paths.conversationAnswer, conversationVerbs.answer],
    [paths.conversationRewind, conversationVerbs.rewind],
  ];
  for (const [template, verb] of tails) {
    assert(template.endsWith(verb), `${template} must end with ${verb}`);
  }
  const missing = [paths.session, paths.conversation].filter(
    (base) => !tails.some(([template]) => template.startsWith(base + "/")),
  );
  assertEquals(missing, [], "a base has no shared verbs");
});
