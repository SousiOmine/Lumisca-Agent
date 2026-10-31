/**
 * Frontend-safe shared helpers (see shared/mod.ts): the avatar of a stella
 * agent.
 *
 * An agent is a name and a role, and the sidebar shows it as a row of names.
 * The avatar is the one thing that tells two rows apart at a glance — so an
 * agent that has no picture yet still gets one: its name's first character,
 * white, on a colour derived from the agent's own id.
 *
 * The colour is DERIVED, not stored: the same agent keeps the same colour
 * across restarts, reorders, machines and a reinstall of the app, because the
 * id is the only input. Nothing has to remember it, and no column can go
 * stale.
 *
 * The rules live here because three surfaces draw it (the sidebar, the
 * conversation's header, the icon dialog) and the server checks the same
 * limits when a picture is uploaded: a limit one side accepts and the other
 * refuses would be a picture the user could choose and never see.
 */
import { fnv1a } from "./digest.ts";
import { RASTER_IMAGE_MIME_BY_EXTENSION } from "./mime.ts";

/** Largest icon a user may upload (bytes). Small on purpose: an avatar is
 * drawn at 20–40 px, and a phone screenshot is already far more pixels than
 * that. The cap keeps one conversation's sidebar from holding megabytes. */
export const MAX_AGENT_ICON_BYTES = 512 * 1024;

/** Image formats an icon may be. Raster only: an SVG is a document that can
 * carry script, and an avatar is served to a browser as an `<img>` — the same
 * rule the attachment store follows (see INLINE_IMAGE_MIME_BY_EXTENSION). */
export const AGENT_ICON_MIME_BY_EXTENSION: Readonly<Record<string, string>> =
  RASTER_IMAGE_MIME_BY_EXTENSION;

/** The content type of an icon whose name ends in `extension` (with its
 * dot, any case), or undefined when icons do not support that format. */
export function agentIconMimeType(extension: string): string | undefined {
  return AGENT_ICON_MIME_BY_EXTENSION[extension.toLowerCase()];
}

/** The formats an icon may be, as an error message lists them. Shared so the
 * upload route and the store cannot name different sets. */
export const AGENT_ICON_FORMATS = "PNG, JPEG, GIF, WebP or BMP";

/** The extension (with its dot) an uploaded `mimeType` is stored under, or
 * undefined when it is not an icon format. PNG is the first match, so the
 * two extensions that name one content type pick one of them. */
export function agentIconExtensionOfMimeType(
  mimeType: string,
): string | undefined {
  const wanted = mimeType.trim().toLowerCase();
  for (
    const [extension, type] of Object.entries(AGENT_ICON_MIME_BY_EXTENSION)
  ) {
    if (type === wanted) return extension;
  }
  return undefined;
}

/** The character an agent without a picture shows: the first code point of
 * its name, uppercased when it is a Latin letter.
 *
 * One code point, not one UTF-16 unit: half of a surrogate pair (an emoji
 * name) would be drawn as a replacement box. A Latin letter is uppercased
 * because a lowercase initial reads as a truncated word rather than as a
 * monogram; other scripts are left alone (uppercasing kana or CJK does
 * nothing, and case-folding them by hand would be wrong).
 *
 * An empty name yields "?" — names cannot be empty (normalizeAgentInput
 * refuses them), so this is the shape a row falls back to, not a state a
 * user can reach. */
export function agentInitial(name: string): string {
  const first = [...name.trim()][0];
  if (first === undefined) return "?";
  return /^[a-z]$/.test(first) ? first.toUpperCase() : first;
}

/** The avatar's hue (0–359) for an agent id: a deterministic spread over the
 * colour wheel.
 *
 * The id is hashed (fnv1a, shared/digest.ts) and the whole 64-bit hash picks
 * the hue. A hash rather than a counter because agents are also created by an
 * agent (agent_create) and by a client, and neither knows how many exist; a
 * hash needs no coordination, and it keeps the colour fixed for the life of
 * the agent — across restarts, reorders and reinstalls.
 *
 * All 64 bits, not a prefix: FNV-1a's low bits barely move between two ids
 * that differ in one character, so `agent-1` and `agent-2` would land in the
 * same corner of the wheel — which is exactly the pair a list grows to have
 * next to each other.
 *
 * The exact value carries no meaning — only that it is the same every time
 * and that neighbouring rows differ. */
export function agentAvatarHue(id: string): number {
  return Number(BigInt(`0x${fnv1a(id)}`) % 360n);
}
