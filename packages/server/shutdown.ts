/**
 * The shutdown contract of a supervised server.
 *
 * A service manager stops a process with `SIGTERM` and expects it to go away;
 * an operator's Ctrl+C is `SIGINT`. The two mean different things, and the
 * exit code is the only part of the answer the supervisor sees, so they are
 * kept distinct:
 *
 * - `SIGTERM` — a supervisor's ordinary stop request — exits 0 on every
 *   surface (systemd reports a clean stop, and `Restart=always` brings the
 *   server straight back after an applied update; see update/service.ts).
 * - `SIGINT` — an interactive interrupt — exits 130, the shell's convention,
 *   so a script that ran this server can tell the two apart.
 * - The drain gets a bounded budget: a child that refuses to exit (a tool
 *   process holding the database, an MCP server ignoring its signal) must not
 *   keep the process alive past it, and a second signal skips the rest of the
 *   drain.
 *
 * The decision is a pure function of the signal, and the drain is injected, so
 * the contract is testable without a real process to kill.
 */

/** How long the graceful drain may take before the process forces its exit.
 * The unit's `TimeoutStopSec=10` is the outer bound (deploy/systemd). */
export const SHUTDOWN_GRACE_MS = 5_000;

export type ShutdownSignal = "SIGINT" | "SIGTERM";

/** Exit code a signal asks for. */
export function exitCodeForSignal(signal: ShutdownSignal): number {
  return signal === "SIGINT" ? 130 : 0;
}

export interface ShutdownOptions {
  /** Release everything this process owns (server, core, children). */
  dispose: () => Promise<void>;
  /** Terminate the process. */
  exit: (code: number) => void;
  /** Overridden in tests to keep the suite quick. */
  graceMs?: number;
  /** Called once, when the first signal arrives. */
  onSignal?: (signal: ShutdownSignal) => void;
  /** Called when the drain failed or overran (the process still exits). */
  onError?: (message: string) => void;
}

/**
 * Build the signal handler. The first signal starts the drain and decides the
 * exit code; a second one exits with that same code immediately.
 */
export function createShutdown(
  options: ShutdownOptions,
): (signal: ShutdownSignal) => void {
  const graceMs = options.graceMs ?? SHUTDOWN_GRACE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Exit code of the signal that started the drain; undefined before that. */
  let draining: number | undefined;
  let settled = false;

  const finish = (code: number) => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    options.exit(code);
  };

  return (signal) => {
    if (draining !== undefined) {
      // The operator insisting: stop waiting for the drain.
      finish(draining);
      return;
    }
    const code = exitCodeForSignal(signal);
    draining = code;
    options.onSignal?.(signal);
    timer = setTimeout(() => {
      options.onError?.(
        `終了処理が ${graceMs}ms 以内に完了しませんでした (強制終了します)`,
      );
      finish(code);
    }, graceMs);
    options.dispose().then(
      () => finish(code),
      (error) => {
        // The stop request is honoured either way: a failure is reported in
        // the log, not turned into an exit code the supervisor would read as
        // a crash.
        options.onError?.(
          `終了処理に失敗しました: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        finish(code);
      },
    );
  };
}
