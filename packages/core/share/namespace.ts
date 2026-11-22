/**
 * The names a session's lent folders answer to.
 *
 * A name is how the model addresses a folder (`/lend/proj`), so two folders
 * answering to one name would make the second unreachable — and the lent
 * computers cannot see each other to avoid it. The server can, so it does: a
 * name already in use by another connection's grant of the same session takes
 * the lowest free suffix, exactly as one app names two folders of its own
 * (`shareNameFrom`).
 *
 * The rule lives here, apart from the registry that holds the connections, so
 * "what may a name be" is one function of (the announcement, what is already
 * taken) rather than a step inside a longer method.
 */

import { type FolderGrant, isShareName, shareNameFrom } from "./grant.ts";
import type { ShareConnection, ShareSink } from "./registry.ts";

export class ShareNamespace {
  /**
   * The announcement with names unique among the live grants of each session.
   *
   * The FIRST announcement of a name keeps it, and a re-announcement keeps it
   * too (the name is not taken by anybody else), so a reconnected app does not
   * move a folder the conversation already knows.
   */
  unique(
    sink: ShareSink,
    grants: readonly FolderGrant[],
    connections: ReadonlyMap<ShareSink, ShareConnection>,
  ): FolderGrant[] {
    const taken = new Map<string, string[]>();
    const namesOf = (sessionId: string): string[] => {
      const names = taken.get(sessionId);
      if (names !== undefined) return names;
      const fresh: string[] = [];
      taken.set(sessionId, fresh);
      return fresh;
    };
    for (const [other, state] of connections) {
      if (other === sink) continue;
      for (const grant of state.grants) {
        namesOf(grant.sessionId).push(grant.name);
      }
    }
    const named: FolderGrant[] = [];
    for (const grant of grants) {
      const used = namesOf(grant.sessionId);
      const name =
        !used.includes(grant.name) && isShareName(grant.name)
          ? grant.name
          : shareNameFrom(grant.path, used);
      used.push(name);
      named.push(name === grant.name ? grant : { ...grant, name });
    }
    return named;
  }
}
