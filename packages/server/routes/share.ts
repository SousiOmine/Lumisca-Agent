/**
 * The lending apps' door: one WebSocket per desktop app, carrying what that
 * app lends and the calls the agent's tools make into those folders.
 *
 * The direction is why this is a socket the app OPENS. The server may be on
 * another machine, so nothing can dial the user's computer; the app dials the
 * server it is showing, with the token it already holds, and stays connected
 * for as long as it lends. A closed socket is therefore not an error to
 * report but the end of every loan it carried (see share/hub.ts), which is
 * exactly what the user means by quitting the app.
 *
 * The path is under `/api`, so the Host guard, the token and the CORS/Origin
 * middleware all apply without restating them here. The socket is the app's,
 * not a browser's: it sends no Origin, which the shared Origin rule allows
 * (it only rejects an Origin that IS present and foreign).
 */
import {
  createLogger,
  type FolderGrant,
  type FolderShare,
  parseGrant,
  parseHostFrame,
  type ShareHub,
  type ShareServerFrame,
  type ShareSink,
} from "@lumisca/core";
import { upgradeWebSocket } from "hono/deno";

const log = createLogger("share");

/**
 * The route. `hub` is the core's (see LumiscaCore.shares): the route owns the
 * socket and the hub owns the loans and the calls in flight.
 */
export function shareHostRoutes(hub: ShareHub) {
  return upgradeWebSocket(() => {
    /** Created with the socket so it can be the hub's identity for this
     * connection before any frame arrives. */
    let sink: ShareSink | undefined;
    /** What the first frame told us. A later announcement cannot change the
     * app run's identity; only a new `hello` can, and that means the app
     * restarted (its client id changes with the process). */
    let hello: { clientId: string; host: FolderShare["host"] } | undefined;

    return {
      onOpen(_event, ws) {
        sink = {
          send: (frame: ShareServerFrame) => ws.send(JSON.stringify(frame)),
          close: (code = 1000, reason = "") => ws.close(code, reason),
        };
      },
      onMessage(event, ws) {
        const current = sink;
        if (current === undefined) return;
        const frame = parseHostFrame(
          typeof event.data === "string" ? event.data : "",
        );
        if (frame === undefined) {
          // A frame we cannot read is a version mismatch between the app and
          // this server, not something to guess at: a loan with fields the
          // tools would then trust is worse than no loan at all.
          log.warn("ignoring an unusable frame from a lending app");
          return;
        }
        if (frame.type === "hello") {
          const grants = readGrants(frame.grants);
          hello = { clientId: frame.clientId, host: frame.host };
          const previous = hub.register(current, {
            clientId: frame.clientId,
            host: frame.host,
            grants,
          });
          // The app reconnected before this server noticed the old socket had
          // died: the old one is not the app any more, and a call must not be
          // answered down both.
          previous?.close?.(1012, "replaced by a newer connection");
          log.debug(
            `lending app ${frame.clientId} connected (${grants.length} folder(s))`,
          );
          return;
        }
        if (frame.type === "grants") {
          if (hello === undefined) {
            log.warn("a lending app announced folders before saying hello");
            return;
          }
          hub.register(current, {
            clientId: hello.clientId,
            host: hello.host,
            grants: readGrants(frame.grants),
          });
          return;
        }
        hub.settle(current, frame);
      },
      onClose() {
        if (sink !== undefined) hub.disconnect(sink);
        sink = undefined;
        hello = undefined;
      },
    };
  });
}

/** The grants of one announcement, with unusable entries dropped and said
 * aloud: the server's log is the only place that can explain a folder the user
 * lent and the agent cannot see (the UI reads the list the server kept). */
function readGrants(value: readonly unknown[]): FolderGrant[] {
  const grants: FolderGrant[] = [];
  for (const entry of value) {
    const grant = parseGrant(entry);
    if (grant === undefined) {
      log.warn("dropping a loan the server cannot read");
      continue;
    }
    grants.push(grant);
  }
  return grants;
}
