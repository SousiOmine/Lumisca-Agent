import type { PeerStatus } from "./types.ts";

/** Display label of a federated peer.
 *
 * The registry's name field is free text and may be left empty; in that
 * case the URL's host is the only part the user recognises (they typed it),
 * so it is shown instead of a blank row. `peerId` is the last resort — an
 * entry that is neither named nor addressed is still selectable by
 * something stable rather than by nothing at all. */
export function peerLabel(
  peer: Pick<PeerStatus, "name" | "url"> | undefined,
  peerId: string,
): string {
  if (peer === undefined) return peerId;
  const name = peer.name.trim();
  if (name !== "") return name;
  const url = peer.url.trim();
  if (url === "") return peerId;
  try {
    // `host` (not `hostname`): two servers on one machine differ by port.
    const { host } = new URL(url);
    // Text that only *looks* like a URL — `homeserver:8000` parses with the
    // scheme "homeserver" and no authority — has no host to show.
    return host === "" ? url : host;
  } catch {
    // Not a URL. Better than hiding the entry behind its opaque id.
    return url;
  }
}
