/**
 * The portal's request convention. Every method that needs the user
 * (a screenshot permission, sharing the screen) answers immediately with a
 * REQUEST object path and reports the outcome as a `Response` signal on it:
 * 0 = the user allowed it, 1 = the user cancelled, 2 = anything else. The
 * method call itself never waits, so nothing here has to hold a bus call
 * open while a dialog is up.
 *
 * Subscribing BEFORE calling is what makes a fast response impossible to
 * miss (`permission_store_checked` screenshots answer immediately). The
 * portal names the request object after the handle_token the caller passed,
 * which the spec defines precisely enough to predict:
 *
 *   /org/freedesktop/portal/desktop/request/<sender>/<token>
 *
 * where <sender> is this connection's unique name without the leading colon
 * and with dots replaced by underscores.
 */
import { CoreError } from "../../errors.ts";
import type { MethodCall, PortalConnection } from "./connection.ts";

/** How long a request may wait for the user. Generous on purpose: it covers
 * a consent dialog the user has not looked at yet, and the portal offers no
 * way to cancel a request from this side (Close cancels the request, which
 * is the same outcome as a decline). */
export const REQUEST_TIMEOUT_MS = 180_000;

/** What a finished request reported. */
export interface RequestOutcome {
  /** 0 = success, 1 = cancelled by the user, 2 = failure (portal spec). */
  response: number;
  /** The result dictionary, e.g. `uri` for a screenshot or `streams` for a
   * screen-cast session. */
  results: Record<string, unknown>;
}

/** Handle tokens only ever need to be unique within one connection. */
let tokenCounter = 0;

/** A fresh handle token: alphanumeric, which is what the portal accepts. */
export function newRequestToken(): string {
  tokenCounter++;
  return `lumisca${tokenCounter}`;
}

/** The object path a request with this token lives at. */
export function requestPath(handleToken: string, uniqueName: string): string {
  const sender = uniqueName.replace(/^:/, "").replace(/\./g, "_");
  return `/org/freedesktop/portal/desktop/request/${sender}/${handleToken}`;
}

/**
 * Call a portal method, wait for its Response, and report the outcome.
 * `handleToken` must be the token the caller put in the method's options.
 */
export async function callPortalRequest(
  connection: PortalConnection,
  call: MethodCall,
  handleToken: string,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<RequestOutcome> {
  const predicted = requestPath(handleToken, connection.uniqueName);
  let settle: (outcome: RequestOutcome | undefined) => void = () => {};
  const answered = new Promise<RequestOutcome | undefined>((resolve) => {
    settle = resolve;
  });
  const onResponse = (response: unknown, results: unknown) => {
    settle({
      response: typeof response === "number" ? response : 2,
      results: isResultDict(results) ? results : {},
    });
  };
  let unsubscribe = await connection.subscribe(
    predicted,
    "org.freedesktop.portal.Request",
    "Response",
    onResponse,
  );

  try {
    const reply = await connection.call(call);
    const handle = reply[0];
    if (typeof handle !== "string") {
      throw new CoreError(
        `${call.interface}.${call.member} did not return a request handle`,
        "unavailable",
      );
    }
    if (handle !== predicted) {
      // The portal is allowed to choose another path (it documents the
      // prediction as a convenience, not a guarantee). Re-subscribing here
      // still catches the response unless it arrived in the microseconds
      // between the reply and this point, which the timeout turns into a
      // clear error rather than a hang.
      const previous = unsubscribe;
      unsubscribe = await connection.subscribe(
        handle,
        "org.freedesktop.portal.Request",
        "Response",
        onResponse,
      );
      await previous();
    }
  } catch (error) {
    await unsubscribe();
    throw error;
  }

  const timer = setTimeout(() => settle(undefined), timeoutMs);
  try {
    const outcome = await answered;
    if (outcome === undefined) {
      throw new CoreError(
        `${call.interface}.${call.member} did not report a result within ` +
          `${Math.round(timeoutMs / 1000)}s (the request was left as it was)`,
        "unavailable",
      );
    }
    return outcome;
  } finally {
    clearTimeout(timer);
    await unsubscribe();
  }
}

/** The `a{sv}` a Response carries, as a plain record. */
function isResultDict(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
