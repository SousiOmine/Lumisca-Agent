import { Hono } from "hono";
import type {
  CreateSessionInput,
  ImageContent,
  SessionAgent,
  SessionInfo,
} from "@lumisca/core";
import { AppError, parseBody } from "./util.ts";

interface SessionBody {
  workspaceId?: unknown;
  name?: unknown;
  modelProvider?: unknown;
  modelId?: unknown;
}

/** Attachments allowed per prompt, and the base64 length cap per image
 * (~15MB binary). Bounds for what a browser can sensibly send; LLM APIs
 * impose their own smaller limits on top of this. */
const MAX_PROMPT_IMAGES = 8;
const MAX_IMAGE_BASE64_LENGTH = 20 * 1024 * 1024;

interface PromptBody {
  text?: unknown;
  images?: unknown;
}

/** Validate a prompt request body; `images` are base64 data + mimeType,
 * converted into the content blocks the agent expects. `text` may be
 * empty when at least one image is attached (image-only prompts). */
export function parsePromptBody(body: PromptBody): {
  text: string;
  images?: ImageContent[];
} {
  const images: ImageContent[] = [];
  if (body.images !== undefined) {
    if (!Array.isArray(body.images) || body.images.length > MAX_PROMPT_IMAGES) {
      throw new AppError(
        `images must be an array of at most ${MAX_PROMPT_IMAGES} items`,
        400,
      );
    }
    for (const item of body.images as Array<Record<string, unknown>>) {
      const { data, mimeType } = item;
      if (
        typeof data !== "string" ||
        typeof mimeType !== "string" ||
        !mimeType.startsWith("image/")
      ) {
        throw new AppError(
          "each image must have a base64 `data` string and an `image/*` mimeType",
          400,
        );
      }
      if (data.length > MAX_IMAGE_BASE64_LENGTH) {
        throw new AppError(
          "image exceeds the size limit (15MB binary)",
          400,
        );
      }
      images.push({ type: "image", data, mimeType });
    }
  }
  const text = body.text === undefined ? "" : body.text;
  if (typeof text !== "string" || (text.length === 0 && images.length === 0)) {
    throw new AppError("text (string) is required", 400);
  }
  return { text, images: images.length > 0 ? images : undefined };
}

/** The slice of the core these routes need (interface segregation). */
export interface SessionApi {
  getSession(id: string): SessionInfo | undefined;
  getSessionLastError(id: string): string | undefined;
  listSessions(workspaceId?: string): SessionInfo[];
  createSession(input: CreateSessionInput): SessionInfo;
  openSession(id: string): SessionInfo;
  closeSession(id: string): void;
  deleteSession(id: string): void;
  getAgent(id: string): SessionAgent | undefined;
  getDefaultModel(): { provider: string; modelId: string } | null;
  startPrompt(id: string, text: string, images?: ImageContent[]): void;
  abort(id: string): void;
  setSessionModel(id: string, provider: string, modelId: string): void;
}

export function sessionRoutes(core: SessionApi): Hono {
  const app = new Hono();

  /** 404 unless a session with this id exists. */
  const requireSession = (id: string) => {
    const session = core.getSession(id);
    if (!session) throw new AppError(`Session not found: ${id}`, 404);
    return session;
  };

  const sessionJson = (session: SessionInfo) => ({
    ...session,
    lastError: core.getSessionLastError(session.id),
  });

  app.get("/sessions", (c) => {
    const workspaceId = c.req.query("workspaceId");
    return c.json(core.listSessions(workspaceId));
  });

  app.get("/sessions/default-model", (c) => {
    return c.json(core.getDefaultModel());
  });

  app.get("/sessions/:id", (c) => {
    return c.json(sessionJson(requireSession(c.req.param("id"))));
  });

  app.get("/sessions/:id/messages", async (c) => {
    const id = c.req.param("id");
    requireSession(id);
    await core.openSession(id);
    const agent = core.getAgent(id);
    if (!agent) {
      // Unreachable today (openSession just created the agent), but do not
      // crash with a TypeError if that invariant ever changes.
      throw new AppError(`Session is not open: ${id}`, 404);
    }
    return c.json(agent.messages);
  });

  app.post("/sessions", async (c) => {
    const body = await parseBody<SessionBody>(c);
    if (!body || typeof body.workspaceId !== "string") {
      throw new AppError("workspaceId (string) is required", 400);
    }
    const session = core.createSession({
      workspaceId: body.workspaceId,
      name: typeof body.name === "string" ? body.name : undefined,
      modelProvider: typeof body.modelProvider === "string"
        ? body.modelProvider
        : undefined,
      modelId: typeof body.modelId === "string" ? body.modelId : undefined,
    });
    return c.json(session, 201);
  });

  app.post("/sessions/:id/open", async (c) => {
    const id = c.req.param("id");
    requireSession(id);
    return c.json(sessionJson(await core.openSession(id)));
  });

  app.post("/sessions/:id/close", (c) => {
    core.closeSession(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.delete("/sessions/:id", (c) => {
    core.deleteSession(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/sessions/:id/prompt", async (c) => {
    const body = await parseBody<PromptBody>(c);
    const { text, images } = parsePromptBody(body ?? {});
    // Fire-and-forget: the run progresses via the WebSocket event stream,
    // so the request does not stay open for the whole agent execution.
    core.startPrompt(c.req.param("id"), text, images);
    return c.json({ ok: true });
  });

  app.post("/sessions/:id/abort", (c) => {
    core.abort(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/sessions/:id/model", async (c) => {
    const body = await parseBody<{ provider?: unknown; modelId?: unknown }>(c);
    if (
      !body || typeof body.provider !== "string" ||
      typeof body.modelId !== "string"
    ) {
      throw new AppError(
        "provider and modelId (strings) are required",
        400,
      );
    }
    core.setSessionModel(c.req.param("id"), body.provider, body.modelId);
    return c.json(core.getSession(c.req.param("id")));
  });

  return app;
}
