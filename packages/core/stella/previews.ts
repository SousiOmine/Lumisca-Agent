import type { MessageRepo } from "../session/messages.ts";
import { previewOf, type StellaPreview } from "../shared/stella-preview.ts";
import { stellaEntryOf } from "../agent/stella-stream.ts";

/**
 * What each agent's conversation last said, for the sidebar's second line.
 *
 * The conversation is read from the STORE rather than from an open agent: the
 * sidebar lists every agent, while only the one being looked at has a session
 * open. A conversation that was never opened has no rows and nothing to say.
 *
 * What the row may say is the conversation's own projection
 * ({@link stellaEntryOf}), so the list cannot show something the conversation
 * would not: the agent's working notes, tool traffic and context publications
 * are not entries, and neither is an empty `send_chat` row. The store query
 * returns CANDIDATES ({@link MessageRepo.newestConversationRows}) — because
 * the projection, not SQL, is what decides — so a candidate that projects to
 * nothing is skipped and the next one is read.
 */

/** Candidates one call reads. A row that the projection drops is rare (an
 * empty `send_chat`, a prompt with neither words nor files), so this covers
 * the newest entry with room to spare; a conversation whose every candidate
 * was dropped is asked for again with a larger limit, up to
 * {@link MAX_PREVIEW_CANDIDATES}. */
const PREVIEW_CANDIDATES = 8;

/** Most rows one lookup reads. A bound exists because this runs once per
 * agent per list refresh: a transcript that is entirely dropped candidates
 * (which would mean a broken projection) must cost a fixed number of reads,
 * not the length of the conversation. A null preview is the honest answer
 * for such a conversation — the list says nothing rather than scanning it
 * every 30 seconds. */
const MAX_PREVIEW_CANDIDATES = 64;

/**
 * The newest thing a conversation shows, or null when it has said nothing.
 *
 * `sessionId` is the conversation's session row; a conversation that does not
 * exist yet has no id and no preview.
 */
export function latestPreview(
  messages: MessageRepo,
  sessionId: string | undefined,
): StellaPreview | null {
  if (sessionId === undefined) return null;
  for (
    let limit = PREVIEW_CANDIDATES;
    limit <= MAX_PREVIEW_CANDIDATES;
    limit *= 2
  ) {
    const rows = messages.newestConversationRows(sessionId, limit);
    for (const row of rows) {
      const entry = stellaEntryOf(row.message);
      if (entry === null) continue;
      const preview = previewOf(entry);
      // `previewOf` returns null only for an entry with nothing to show, and
      // `stellaEntryOf` refuses to build one of those — so this is the
      // newest entry, or the search continues past a row the projection
      // accepted but nothing can be drawn from.
      if (preview !== null) return preview;
    }
    // The query answered fewer rows than it was allowed: that is the whole
    // candidate set, so a larger limit would read the same rows again.
    if (rows.length < limit) return null;
  }
  return null;
}
