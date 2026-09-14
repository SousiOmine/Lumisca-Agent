import { useState } from "preact/compat";
import { errorMessage as errorText } from "@lumisca/core/shared";
import { api, fed } from "../api.ts";
import { peerRouted } from "../api-client.ts";
import type { SkillInfo } from "../types.ts";
import { useAsyncEffect } from "./useAsync.ts";

/** Load the skills the `/skill` palette offers for one session context: the
 * skills of `workspaceId`, or of a chat session when it is undefined —
 * fetched from the peer that owns the workspace (the machine that would run
 * the session's agent). Re-fetches when the workspace or the peer changes.
 *
 * A failure yields an empty list plus the reason: an empty palette is
 * better than a stale one (it would offer skills the agent cannot load —
 * the catalog is discovered per machine), and the caller may explain the
 * missing entries. */
export function useSkills(
  peerId: string,
  workspaceId: string | undefined,
): { skills: SkillInfo[]; error: string | null } {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  useAsyncEffect(async (isStale) => {
    try {
      const result = await peerRouted(peerId, api.getSkills, fed.getSkills)(
        workspaceId,
      );
      if (isStale()) return;
      setSkills(result.skills);
      setError(null);
    } catch (failure) {
      if (!isStale()) {
        setSkills([]);
        setError(errorText(failure));
      }
    }
  }, [peerId, workspaceId]);

  return { skills, error };
}
