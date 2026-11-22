/**
 * What the stella routes ask of a request before the core sees it: the agent
 * patch's fields (name, picture, model, thinking strength, on/off), the
 * pictures a prompt carries, and the lookups a path's ids resolve through (the
 * agent, its conversation).
 *
 * Kept apart from the routes so the route file reads as the surface it
 * defines, and apart from `util.ts` because these checks know about stella's
 * shapes: an icon is a base64 + content-type pair, a model patch names the
 * model its thinking level belongs to, and a prompt's picture becomes a file
 * in the machine rather than a block in the message. Only shapes are checked
 * here — whether a name is free, a model is selectable or a level is offered
 * is the core's question, answered before anything is written.
 */
import type {
  ImageContent,
  PromptFileRef,
  SessionInfo,
  StellaAgent,
} from "@lumisca/core";
import { base64ToBytes } from "@lumisca/core";
import {
  AGENT_ICON_FORMATS,
  agentIconExtensionOfMimeType,
  MAX_AGENT_ICON_BYTES,
  rasterExtensionOfMimeType,
} from "@lumisca/core/shared";
import type { StellaApi } from "../contracts/stella.ts";
import { preparePromptImages } from "./session-requests.ts";
import { AppError, notFound, requireNonEmptyString } from "./util.ts";

/** The lookups a path's ids resolve through: the agent a request names, and
 * the conversation it already has. */
export type StellaRequestApi = Pick<
  StellaApi,
  "findStellaSession" | "getStellaAgent"
>;

/** The agent, or 404. */
export function requireAgent(
  core: StellaRequestApi,
  agentId: string,
): StellaAgent {
  const agent = core.getStellaAgent(agentId);
  if (agent === undefined) {
    throw notFound("Agent", agentId);
  }
  return agent;
}

/** The agent, or 404 when it is gone, or 409 when it is switched off.
 *
 * Only the routes that would make the agent DO something call this: a
 * prompt, and the clipboard, which is read through the machine. Reading
 * the conversation does not, because a disabled agent's history is exactly
 * what the user may still look at. */
export function requireEnabledAgent(
  core: StellaRequestApi,
  agentId: string,
): StellaAgent {
  const agent = requireAgent(core, agentId);
  if (agent.disabledAt !== null) {
    throw new AppError(`Agent ${agentId} is disabled`, 409);
  }
  return agent;
}

/** The agent's conversation, or 404. The conversation is created by the
 * open endpoint; every other call addresses one that exists.
 *
 * The agent must exist (a deleted agent's conversation is gone with it),
 * and it must have been opened at least once. `findStellaSession` is the
 * only lookup that needs no session id — a client never learns one. */
export function requireConversation(
  core: StellaRequestApi,
  agentId: string,
): SessionInfo {
  const agent = core.getStellaAgent(agentId);
  if (agent === undefined) {
    throw notFound("Agent", agentId);
  }
  const session = core.findStellaSession(agentId);
  if (session === undefined) {
    throw new AppError(
      `No conversation for agent ${agentId}: open it first`,
      404,
    );
  }
  return session;
}

/**
 * The upload body an icon route takes: the base64 bytes and the content type
 * the browser reported. Validated here so the core only ever sees an
 * admissible pair — an empty or oversized payload is refused with its own
 * sentence instead of reaching the store as a broken image.
 */
function parseIconBody(
  body: { data?: unknown; mimeType?: unknown } | undefined,
): { data: string; mimeType: string } {
  const data = body?.data;
  const mimeType = body?.mimeType;
  if (typeof data !== "string" || data.length === 0) {
    throw new AppError("data (base64 image) is required", 400);
  }
  if (typeof mimeType !== "string" || mimeType.length === 0) {
    throw new AppError("mimeType is required", 400);
  }
  // Measured on the encoded text first: a payload far past the limit is
  // rejected without being decoded, and base64 is 4/3 of the bytes it
  // carries (plus the data-URL header some clients leave on).
  if (data.length > Math.ceil((MAX_AGENT_ICON_BYTES * 4) / 3) + 1024) {
    throw new AppError(
      `The icon is too large (limit ${MAX_AGENT_ICON_BYTES} bytes)`,
      400,
    );
  }
  return { data, mimeType };
}

/** Decode base64, with the data-URL header stripped (a client may send what
 * `FileReader` produced). A malformed payload is a 400 rather than a
 * store-level failure: it describes the request, not the server. */
function decodeBase64(data: string): Uint8Array {
  const payload = data.startsWith("data:")
    ? data.slice(data.indexOf(",") + 1)
    : data;
  try {
    return base64ToBytes(payload);
  } catch {
    throw new AppError("data is not valid base64", 400);
  }
}

/** One patch's picture: the new bytes to store, `null` for "back to the
 * initial", or undefined for "leave it alone" (the field was not sent).
 *
 * A malformed value is a 400 rather than a silent no-op: a client that sent
 * something shaped like a picture but could not be read has a bug, and
 * treating it as "unchanged" would report success for a picture that was
 * never stored. */
export function parseIconPatch(
  value: unknown,
): { bytes: Uint8Array; extension: string } | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const { data, mimeType } = parseIconBody(
    value as { data?: unknown; mimeType?: unknown },
  );
  const extension = agentIconExtensionOfMimeType(mimeType);
  if (extension === undefined) {
    throw new AppError(
      `Icons must be ${AGENT_ICON_FORMATS} (got "${mimeType}")`,
      400,
    );
  }
  return { bytes: decodeBase64(data), extension };
}

/**
 * `{provider, modelId}` of a body field, checked as a pair. Shared by the
 * model patch and the thinking-level patch: both name a model, so both must
 * fail the same way when one half is missing or blank.
 */
function parseModelRef(
  value: unknown,
  field: string,
): { provider: string; modelId: string } {
  if (typeof value !== "object" || value === null) {
    throw new AppError(`${field} must be an object`, 400);
  }
  const body = value as { provider?: unknown; modelId?: unknown };
  // Trimmed before the emptiness check: a body of {"provider": "  "}
  // describes the request, so it is a 400 here rather than an id no catalog
  // has, which the core would refuse with a confusing 404.
  const provider = requireNonEmptyString(
    body.provider,
    `${field}.provider`,
  ).trim();
  const modelId = requireNonEmptyString(
    body.modelId,
    `${field}.modelId`,
  ).trim();
  if (provider === "" || modelId === "") {
    throw new AppError(
      `${field}.provider and ${field}.modelId must not be blank`,
      400,
    );
  }
  return { provider, modelId };
}

/**
 * The model patch of an agent edit: `{provider, modelId}` sets the choice,
 * `null` returns the agent to the app's default model, and an absent key
 * means "leave it alone" (the dialog saves only what changed).
 *
 * Only the shape is checked here. Whether the pair names a model this
 * installation can select is the core's question — it is the one that can
 * read the catalog, and it must answer before the row changes.
 */
export function parseModelPatch(
  value: unknown,
): { provider: string; modelId: string } | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return parseModelRef(value, "model");
}

/**
 * The on/off patch of an agent edit: absent means "leave it alone", and
 * anything but a boolean is a 400. A body that says nothing is not the same
 * request as one that says "on", and a typo in the field name must not read
 * as silence.
 */
export function parseEnabledPatch(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new AppError("enabled (boolean) is required", 400);
  }
  return value;
}

/**
 * The thinking-strength patch of an agent edit: the level, and the model it
 * belongs to.
 *
 * The model is named rather than resolved from the agent because the level is
 * a MODEL setting, and the dialog drew its list of levels from the model in
 * effect at that moment. Naming it keeps the two from disagreeing about which
 * model the user was looking at.
 *
 * Only the shape is checked here: whether the model offers the level (and
 * whether the level exists at all) is the core's question, answered before
 * anything is written.
 */
export function parseThinkingLevelPatch(
  value: unknown,
): { provider: string; modelId: string; level: string } | undefined {
  if (value === undefined) return undefined;
  const { provider, modelId } = parseModelRef(value, "thinkingLevel");
  const level = requireNonEmptyString(
    (value as { level?: unknown }).level,
    "thinkingLevel.level",
  );
  return { provider, modelId, level };
}

/** The file name a pasted picture is stored under: `image-1.png`,
 * `image-2.jpg`. Its extension comes from the type the browser reported, so
 * the conversation can draw it back without sniffing the bytes (a raster
 * format is what a prompt accepts, and anything else is refused when the
 * upload is saved). */
function imageName(index: number, mimeType: string): string {
  const extension = rasterExtensionOfMimeType(mimeType);
  if (extension === undefined) {
    throw new AppError(`Unsupported image type: ${mimeType}`, 400);
  }
  return `image-${index + 1}${extension}`;
}

/** Put a prompt's pasted pictures into the machine, and answer with the
 * references the message records in their place.
 *
 * Bounded first (`preparePromptImages`): a phone photo is 15 MB and one
 * prompt may carry eight of them, and the model cannot use more than its own
 * budget anyway. Each is then written under `image-<n>.<ext>` — a name the
 * conversation can draw back without sniffing the bytes. Undefined when the
 * prompt carried no picture, so "no attachments" is never an empty list.
 */
export async function savePromptPictures(
  core: Pick<StellaApi, "savePromptImages">,
  sessionId: string,
  images: readonly ImageContent[] | undefined,
): Promise<PromptFileRef[] | undefined> {
  const bounded = await preparePromptImages(images);
  if (bounded === undefined) return undefined;
  return core.savePromptImages(
    sessionId,
    bounded.map((image, index) => ({
      name: imageName(index, image.mimeType),
      bytes: base64ToBytes(image.data),
    })),
  );
}
