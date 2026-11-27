/**
 * The API's paths, written once for the two sides that have to agree about
 * them: the server's Hono registrations and the web client's requests.
 *
 * A template is the path with its ids left as `{name}` holes. The server
 * registers `routePath(template)` (Hono's `:id` form) and the client calls
 * `apiPath(template, { session: enc(id) })`; neither side writes the literal
 * text, so a path or an id parameter renamed here changes both at once, and
 * the route test (`packages/server/routes/api_paths_test.ts`) fails when a
 * registered path stops matching a client's.
 *
 * Templates are relative to the `/api` prefix the server mounts every API
 * route under. The web client adds that prefix; the server's own mounts
 * (`app.route("/api", …)`) belong to the composition root (packages/server/
 * app.ts), not here.
 *
 * This module is pure data and two string functions: it is bundled into the
 * browser client (see browser-entries.ts), so it must stay free of imports.
 */

/** What the server registers in place of a template's holes. A hole is
 * named after the parameter the route reads (`c.req.param("id")`), so the
 * server's handlers and the templates cannot drift either: writing a route
 * through `routePath` is what gives `c.req.param` its literal names. */
const PARAM_NAMES: Record<string, string> = {
  id: "id",
  agentId: "agentId",
  uploadId: "uploadId",
  name: "name",
};

/** The same mapping at the type level, so `routes.get(routePath(paths.x))`
 * keeps Hono's typed `c.req.param` names: a route registered through a plain
 * `string` would read every parameter as `string | undefined`. */
type Replaced<T extends string> =
  T extends `${infer Head}{${infer Hole}}${infer Rest}`
    ? `${Head}:${Hole}${Replaced<Rest>}`
    : T;

/** A template as the server registers it (`"/sessions/{id}"` →
 * `"/sessions/:id"`). */
export type RoutePath<T extends string> = Replaced<T>;

/** The one path segment a code-mode session and a stella conversation share
 * (routes/conversation.ts installs the same four handlers on both). Composed
 * into the templates below so the two families cannot spell them apart. */
const verbs = {
  abort: "/abort",
  answer: "/answer",
  rewind: "/rewind",
  model: "/model",
} as const;

/** The suffix each shared verb contributes, for the builder that installs
 * them on a caller-chosen base (`base + verbs.abort` is
 * `paths.sessionAbort`'s template with that base). */
export const conversationVerbs = verbs;

const session = "/sessions/{id}";
const conversation = "/stella/conversations/{agentId}";
const agent = "/stella/agents/{id}";
const routine = "/routines/{id}";
const upload = "/stella/conversations/{agentId}/uploads/{uploadId}";

/** Every API path, as the template both sides build from. */
export const paths = {
  // --- sessions (code mode) ------------------------------------------------
  sessions: "/sessions",
  sessionDefaultModel: "/sessions/default-model",
  session,
  sessionMessages: `${session}/messages`,
  sessionRevision: `${session}/revision`,
  sessionTodo: `${session}/todo`,
  sessionTasks: `${session}/tasks`,
  sessionBackground: `${session}/background`,
  sessionOpen: `${session}/open`,
  sessionClose: `${session}/close`,
  sessionPrompt: `${session}/prompt`,
  sessionCompact: `${session}/compact`,
  sessionAbort: `${session}${verbs.abort}`,
  sessionAnswer: `${session}${verbs.answer}`,
  sessionRewind: `${session}${verbs.rewind}`,
  sessionModel: `${session}${verbs.model}`,
  /** The images a session published; `name` is the store's file name and is
   * followed by nothing, so a reference resolves against the base below. */
  sessionVisual: `${session}/visual/{name}`,
  sessionVisualBase: `${session}/visual/`,
  sessionAttachment: `${session}/attachment/{name}`,
  sessionAttachmentBase: `${session}/attachment/`,

  // --- stella agents -------------------------------------------------------
  stellaStatus: "/stella/status",
  stellaAgents: "/stella/agents",
  stellaAgent: agent,
  stellaAgentMachine: `${agent}/machine`,
  stellaAgentWake: `${agent}/wake`,
  stellaAgentTouch: `${agent}/touch`,
  stellaAgentIcon: `${agent}/icon/{name}`,
  /** One agent's own MCP servers: they run inside its machine. */
  stellaAgentMcp: `${agent}/mcp`,
  stellaAgentMcpTest: `${agent}/mcp/test`,
  /** The routine list is read by agent id, and its handler reads
   * `agentId`, not the `id` the agent routes name. */
  stellaAgentRoutines: "/stella/agents/{agentId}/routines",

  // --- routines ------------------------------------------------------------
  routine,
  routineRun: `${routine}/run`,
  routineStop: `${routine}/stop`,

  // --- one stella conversation (addressed by its agent) --------------------
  conversation,
  conversationMessages: `${conversation}/messages`,
  conversationSearch: `${conversation}/search`,
  conversationRevision: `${conversation}/revision`,
  conversationPrompt: `${conversation}/prompt`,
  conversationAbort: `${conversation}${verbs.abort}`,
  conversationAnswer: `${conversation}${verbs.answer}`,
  conversationRewind: `${conversation}${verbs.rewind}`,
  conversationHandover: `${conversation}/handover`,
  conversationEnv: `${conversation}/env`,
  conversationEnvDecline: `${conversation}/env/decline`,
  conversationShareLend: `${conversation}/share/lend`,
  conversationShareDecline: `${conversation}/share/decline`,
  conversationShareDisconnect: `${conversation}/share/disconnect`,
  conversationClipboard: `${conversation}/clipboard`,
  conversationEvents: `${conversation}/events`,
  /** One file a prompt brought into the machine, read back by `ref`. */
  conversationUpload: `${conversation}/upload`,
  /** The transfers of one conversation's prompt files (routes/prompt-uploads). */
  conversationUploads: `${conversation}/uploads`,
  upload,
  uploadComplete: `${upload}/complete`,
} as const;

/** Percent-encode one id for a path segment. The client encodes; the server
 * never sees a concrete id (it registers the `:param` form). */
export function enc(id: string): string {
  return encodeURIComponent(id);
}

/** Fill a template's holes with `params`, which are taken as written: a
 * client passes `enc(id)`, and the route test passes a literal. A missing
 * parameter is a bug in the call site, so it throws instead of leaving
 * `{name}` in a URL. */
export function apiPath(
  template: string,
  params: Record<string, string>,
): string {
  return template.replace(/\{(\w+)\}/g, (hole, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`${template} has no value for {${name}}`);
    }
    return value;
  });
}

/** The path the server registers for `template`: `{session}` becomes `:id`,
 * `{agent}` `:agentId`, and so on (see PARAM_NAMES). */
export function routePath<T extends string>(template: T): RoutePath<T> {
  return template.replace(/\{(\w+)\}/g, (hole, name: string) => {
    const param = PARAM_NAMES[name];
    if (param === undefined) {
      throw new Error(`${template}: {${name}} is not an id a route names`);
    }
    return `:${param}`;
  }) as RoutePath<T>;
}
