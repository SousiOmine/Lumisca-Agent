/**
 * Asking a Lumisca server whether it is alive, and whether it is *this*
 * server.
 *
 * The same request was written three times — the federation client's
 * identity check, the `/api/fed/peers` reachability probe, and the systemd
 * installer's "did it come up?" poll — each with its own timeout (3000,
 * 3000, 2000) and its own spelling of the credential header. A change to how
 * a server answers `/api/health` (a new field, a stricter credential rule)
 * had to be repeated in all three, and a timeout that drifted apart is why
 * one of them could report a live peer as dead.
 *
 * One function, and the timeout is the caller's (a session list must not wait
 * on an unreachable peer for as long as an installer may poll a machine that
 * is still starting).
 */

/** The header a request carries a server's credential in. Named once so the
 * probe and the guard cannot spell it differently. */
export const TOKEN_HEADER = "x-lumisca-token";

/** What `/api/health` answers. */
export interface HealthBody {
  ok: boolean;
  /** When the answering process looked at the clock. */
  now: number;
  /** A uuid chosen when the process started: the same server reached through
   * another address answers with the same id. */
  instanceId: string;
}

export interface HealthProbeOptions {
  /** The server's base URL (a trailing slash is ignored). */
  url: string;
  /** The credential, when the server needs one. */
  token?: string;
  /** How long to wait. A peer list uses a short one; an installer polling a
   * starting process a longer one. */
  timeoutMs: number;
  /** A caller's own cancellation (a shutdown, a superseded refresh). */
  signal?: AbortSignal;
}

/**
 * Read `/api/health`. Resolves with the body, or undefined when the server
 * did not answer, answered with a failure status, or answered something that
 * is not the health shape.
 *
 * Undefined rather than a throw: every caller treats "did not answer" as a
 * normal answer (a peer that is down, a process that has not bound yet), and
 * none of them has a use for the exception.
 */
export async function probeHealth(
  options: HealthProbeOptions,
): Promise<HealthBody | undefined> {
  const signal = options.signal === undefined
    ? AbortSignal.timeout(options.timeoutMs)
    : AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]);
  try {
    const response = await fetch(
      `${options.url.replace(/\/+$/, "")}/api/health`,
      {
        ...(options.token === undefined
          ? {}
          : { headers: { [TOKEN_HEADER]: options.token } }),
        signal,
      },
    );
    if (!response.ok) return undefined;
    const body = await response.json() as Partial<HealthBody>;
    if (typeof body.instanceId !== "string") return undefined;
    return {
      ok: body.ok === true,
      now: typeof body.now === "number" ? body.now : 0,
      instanceId: body.instanceId,
    };
  } catch {
    // Not listening, refused, timed out, or not JSON: all the same answer.
    return undefined;
  }
}

/** Whether `url` is the server identified by `selfId` (the federation
 * self-guard). A server that cannot be reached is not this one. */
export async function isSelf(
  options: HealthProbeOptions & { selfId: string },
): Promise<boolean> {
  if (options.selfId === "") return false;
  const body = await probeHealth(options);
  return body !== undefined && body.instanceId === options.selfId;
}
