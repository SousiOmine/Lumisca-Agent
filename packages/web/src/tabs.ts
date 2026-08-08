/** Composite tab key: sessions are identified by (peerId, sessionId).
 * Sessions on this server (peerId "") use the bare session id. */
export function tabKey(peerId: string, sessionId: string): string {
  return peerId === "" ? sessionId : `${peerId}:${sessionId}`;
}

/** Split a tab key back into (peerId, sessionId). */
export function splitTabKey(
  key: string,
): { peerId: string; sessionId: string } {
  const i = key.indexOf(":");
  if (i === -1) return { peerId: "", sessionId: key };
  return { peerId: key.slice(0, i), sessionId: key.slice(i + 1) };
}
