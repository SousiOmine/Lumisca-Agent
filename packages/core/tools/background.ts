import {
  integer,
  object,
  optional,
  string,
  stringMap,
  type Tool,
} from "./schema.ts";
import {
  TOOL_ASYNC_BASH,
  TOOL_ASYNC_BASH_KILL,
  TOOL_ASYNC_BASH_STATUS,
} from "../shared.ts";
import type { Sandbox } from "../workspace/sandbox.ts";
import { decodeOutput, detectOemLabel } from "./decode.ts";
import { getShell } from "./shell.ts";
import { MAX_TOOL_OUTPUT } from "./truncate.ts";
import type {
  NotificationPayload,
  NotificationStatus,
} from "../types/notification.ts";
import type { ClientEvent } from "../types/event.ts";

/** Concurrent background commands per session. Bounds resource usage; the
 * agent is told to wait or kill when the limit is reached. Only running
 * commands occupy a slot — finished ones move to the completed history and
 * free theirs. */
export const MAX_BACKGROUND_COMMANDS = 8;
/** How many completed commands stay queryable (status/list/tail) per
 * session; older entries are dropped. */
const MAX_COMPLETED_COMMANDS = 50;
/** Raw output retained per command (bytes). */
const MAX_OUTPUT_BUFFER = MAX_TOOL_OUTPUT;
/** Decoded output shown by status and completion notifications. */
export const BACKGROUND_TAIL_LIMIT = 8 * 1024;
/** How long a finished process's pipe readers get to flush the last output
 * before the completion notification is built. Descendants that keep the
 * pipe open must not block completion, so this never waits longer. */
const FINAL_FLUSH_GRACE_MS = 250;
/** Upper bound for kill() to wait for the process to actually die. */
const KILL_WAIT_MS = 3000;

export type BackgroundCommandState = "running" | "finished" | "killed";
export type BackgroundCommandReason = "exited" | "killed" | "timeout";

/** Snapshot of one background command (state + metadata; `tail` is decoded
 * on demand — see `tail()` — and also frozen into the info at completion). */
export interface BackgroundCommandInfo {
  commandId: string;
  pid: number;
  command: string;
  cwd: string;
  state: BackgroundCommandState;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number;
  /** Output tail at the time the command finished (empty while running). */
  tail: string;
}

/** Payload delivered to onExit listeners when a command completes. */
export interface BackgroundCommandDone {
  commandId: string;
  exitCode?: number;
  reason: BackgroundCommandReason;
  durationSec: number;
  tail: string;
}

interface RunningRecord {
  info: BackgroundCommandInfo;
  child: Deno.ChildProcess;
  buffer: Uint8Array;
  /** Resolves when the process exits (child.status); kill() awaits it to
   * confirm the death. */
  exit: Promise<Deno.CommandStatus>;
  finalized: boolean;
  killedByUser: boolean;
  killedByTimeout: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/** Kill a spawned process and its whole tree. Windows: taskkill /T /F
 * (killing the shell alone would orphan everything it spawned); POSIX:
 * SIGKILL (without a process group the shell's children may survive on
 * POSIX — best available without setsid). */
export function killProcessTree(
  child: { pid: number; kill(signal: "SIGKILL"): void },
): void {
  try {
    if (Deno.build.os === "windows") {
      new Deno.Command("taskkill", {
        args: ["/PID", String(child.pid), "/T", "/F"],
        stdout: "null",
        stderr: "null",
      }).output().catch(() => {});
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    // already exited
  }
}

/** Drop trailing bytes that begin an incomplete UTF-8 sequence, so slicing
 * a byte buffer mid-character cannot garble the last glyph of a tail. */
export function trimIncompleteUtf8(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 0) return bytes;
  let start = bytes.length;
  // Walk back over continuation bytes to the lead byte of the last sequence.
  while (start > 0 && (bytes[start - 1]! & 0b1100_0000) === 0b1000_0000) {
    start--;
  }
  if (start === 0) return bytes; // leading continuations: let the decoder cope
  const lead = bytes[start - 1]!;
  let len: number;
  if ((lead & 0b1110_0000) === 0b1100_0000) len = 2;
  else if ((lead & 0b1111_0000) === 0b1110_0000) len = 3;
  else if ((lead & 0b1111_1000) === 0b1111_0000) len = 4;
  else return bytes; // ASCII tail: clean cut
  return start - 1 + len <= bytes.length ? bytes : bytes.slice(0, start - 1);
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}h ${String(m).padStart(2, "0")}m ${
      String(s).padStart(2, "0")
    }s`;
  }
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

/** The notification injected into the agent loop when a background command
 * completes. The title starts with "[Background command ...]" so the system
 * prompt can teach the agent to recognize it as a system notification. */
export function formatBackgroundNotification(
  done: BackgroundCommandDone,
): NotificationPayload {
  const id = done.commandId;
  const duration = formatDuration(done.durationSec * 1000);
  let title: string;
  if (done.reason === "exited") {
    title = `[Background command #${id} finished after ${duration} (exit code ${
      done.exitCode ?? "?"
    })]`;
  } else if (done.reason === "timeout") {
    title =
      `[Background command #${id} was killed after ${duration} (timeout)]`;
  } else {
    title = `[Background command #${id} was killed]`;
  }
  const status: NotificationStatus = done.reason === "exited" &&
      done.exitCode === 0
    ? "success"
    : "error";
  return {
    kind: "background",
    title,
    body: done.tail.trim(),
    status,
  };
}

export interface BackgroundProcessManagerOptions {
  /** Extra env vars to expose to spawned commands. */
  env?: Record<string, string>;
  /** Session id stamped onto the lifecycle events emitted for the panel. */
  sessionId?: string;
  /** Event sink: forwards background lifecycle events (start / delta / end)
   * to clients. Owned by the session pool, which connects it to the core's
   * event bus. Absent in tests and standalone use — nothing is emitted. */
  emit?: (event: ClientEvent) => void;
}

/**
 * Session-scoped registry of background commands: spawns processes, buffers
 * their output (capped ring), and reports completion to subscribers. Owned
 * by the caller (the session pool) and shared with the session agent so it
 * can turn completions into notifications. Commands run independently of
 * the agent run — aborting a run never stops them; only kill()/killAll()
 * do.
 */
export class BackgroundProcessManager {
  /** Running commands only (each occupies one of MAX_BACKGROUND_COMMANDS
   * slots; finished commands move to `completed` and free their slot). */
  private readonly records = new Map<string, RunningRecord>();
  /** Completed commands, newest first, bounded at MAX_COMPLETED_COMMANDS.
   * Kept so status/list/tail still answer for finished commands; the
   * heavy output buffer is dropped with the record itself. */
  private readonly completed: BackgroundCommandInfo[] = [];
  private readonly listeners = new Set<
    (done: BackgroundCommandDone) => void
  >();
  private nextId = 1;
  private oemLabel: Promise<string | null> | null = null;

  constructor(private readonly options: BackgroundProcessManagerOptions = {}) {}

  /** Subscribe to command completions (fires once per command). Returns an
   * unsubscribe function. */
  onExit(listener: (done: BackgroundCommandDone) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Start a command in the background; resolves as soon as it is spawned
   * (never waits for output). Throws when the per-session limit is hit. */
  start(input: {
    cwd: string;
    command: string;
    timeoutSec?: number;
    /** Per-command env vars; override the manager-level env. */
    env?: Record<string, string>;
  }): { commandId: string; pid: number } {
    if (this.records.size >= MAX_BACKGROUND_COMMANDS) {
      throw new Error(
        `Too many background commands (max ${MAX_BACKGROUND_COMMANDS}): wait for one to finish or kill it first`,
      );
    }
    const commandId = String(this.nextId++);
    const shell = getShell();
    const child = new Deno.Command(shell.file, {
      args: [...shell.args, input.command],
      cwd: input.cwd,
      env: { ...this.options.env, ...shell.env, ...input.env },
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    const info: BackgroundCommandInfo = {
      commandId,
      pid: child.pid,
      command: input.command,
      cwd: input.cwd,
      state: "running",
      startedAt: Date.now(),
      tail: "",
    };
    const record: RunningRecord = {
      info,
      child,
      buffer: new Uint8Array(0),
      exit: child.status,
      finalized: false,
      killedByUser: false,
      killedByTimeout: false,
    };
    if (input.timeoutSec !== undefined && input.timeoutSec > 0) {
      record.timer = setTimeout(() => {
        record.killedByTimeout = true;
        killProcessTree(child);
      }, input.timeoutSec * 1000);
    }
    this.records.set(commandId, record);
    this.emitStart(record);

    const append = (chunk: Uint8Array) => {
      if (chunk.length === 0) return;
      const joined = new Uint8Array(record.buffer.length + chunk.length);
      joined.set(record.buffer);
      joined.set(chunk, record.buffer.length);
      record.buffer = joined.slice(-MAX_OUTPUT_BUFFER);
      this.emitDelta(record, chunk);
    };
    const read = async (stream: ReadableStream<Uint8Array>) => {
      try {
        for await (const chunk of stream) append(chunk);
      } catch {
        // pipe closed by a kill; nothing to do
      }
    };
    const readers = [read(child.stdout), read(child.stderr)];

    void child.status.then(async (status) => {
      // Give the pipe readers a brief grace to flush the final output before
      // the completion notification is built (a descendant holding the pipe
      // open must not block completion).
      await Promise.race([
        Promise.all(readers.map((r) => r.catch(() => {}))),
        new Promise((resolve) => setTimeout(resolve, FINAL_FLUSH_GRACE_MS)),
      ]);
      this.finalize(record, status);
    });
    return { commandId, pid: child.pid };
  }

  /** All commands, newest first (completed history first, then running). */
  list(): BackgroundCommandInfo[] {
    const running = [...this.records.values()].map((r) => r.info).reverse();
    return [...this.completed, ...running];
  }

  /** One command's info, or undefined when the id is unknown. */
  get(commandId: string): BackgroundCommandInfo | undefined {
    return this.records.get(commandId)?.info ??
      this.completed.find((c) => c.commandId === commandId);
  }

  /** Decode the current output tail of a command (undefined when unknown).
   * Decoding is deferred to call time so status checks see fresh output. */
  async tail(commandId: string): Promise<string | undefined> {
    const record = this.records.get(commandId);
    if (record) return await this.decodeTail(record);
    return this.completed.find((c) => c.commandId === commandId)?.tail;
  }

  /** Stop a command (whole process tree) and wait — bounded — for it to
   * actually die, so the caller's result reflects reality (a status check
   * right after a successful kill must not see a still-running process).
   * Unknown ids throw; killing an already-finished command is a no-op. */
  async kill(
    commandId: string,
  ): Promise<{ ok: true; alreadyExited: boolean; timedOut: boolean }> {
    const record = this.records.get(commandId);
    if (!record) {
      if (this.completed.some((c) => c.commandId === commandId)) {
        return { ok: true, alreadyExited: true, timedOut: false };
      }
      throw new Error(`Unknown background command: ${commandId}`);
    }
    if (record.finalized || record.info.state !== "running") {
      return { ok: true, alreadyExited: true, timedOut: false };
    }
    record.killedByUser = true;
    if (record.timer !== undefined) {
      clearTimeout(record.timer);
      record.timer = undefined;
    }
    killProcessTree(record.child);
    const timedOut = await Promise.race([
      record.exit.then(() => false, () => false),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(true), KILL_WAIT_MS)
      ),
    ]);
    return { ok: true, alreadyExited: false, timedOut };
  }

  /** Stop every running command (session close / app shutdown). */
  killAll(): void {
    for (const record of this.records.values()) {
      if (record.info.state !== "running") continue;
      record.killedByUser = true;
      if (record.timer !== undefined) {
        clearTimeout(record.timer);
        record.timer = undefined;
      }
      killProcessTree(record.child);
    }
  }

  /** Announce a newly spawned command to the panel (background_start).
   * Emits nothing when the manager has no event sink (tests, standalone
   * use). */
  private emitStart(record: RunningRecord): void {
    const { emit, sessionId } = this.options;
    if (emit === undefined || sessionId === undefined) return;
    emit({
      type: "background_start",
      sessionId,
      commandId: record.info.commandId,
      pid: record.info.pid,
      command: record.info.command,
      cwd: record.info.cwd,
      startedAt: record.info.startedAt,
    });
  }

  /** Decode a fresh output chunk and emit it as a background_delta event
   * (the panel's live view). Decoding needs the OEM code page label, which
   * is detected asynchronously on first use; the single cached promise
   * resolves every pending callback in registration order, so deltas stay
   * ordered while the label is still being detected. */
  private emitDelta(record: RunningRecord, chunk: Uint8Array): void {
    const { emit, sessionId } = this.options;
    if (emit === undefined || sessionId === undefined) return;
    const bytes = trimIncompleteUtf8(chunk);
    if (bytes.length === 0) return;
    void this.oem().then((label) => {
      const delta = decodeOutput(bytes, label);
      if (delta.length === 0) return;
      emit({
        type: "background_delta",
        sessionId,
        commandId: record.info.commandId,
        delta,
      });
    });
  }

  /** Announce a settled command to the panel (background_end). `state` is
   * "finished" for natural exits and "killed" for kills and timeouts (the
   * same split the manager's info uses). */
  private emitEnd(
    record: RunningRecord,
    tail: string,
    reason: BackgroundCommandReason,
  ): void {
    const { emit, sessionId } = this.options;
    if (emit === undefined || sessionId === undefined) return;
    emit({
      type: "background_end",
      sessionId,
      commandId: record.info.commandId,
      state: reason === "exited" ? "finished" : "killed",
      exitCode: record.info.exitCode,
      finishedAt: record.info.finishedAt!,
      tail,
    });
  }

  private async decodeTail(record: RunningRecord): Promise<string> {
    const bytes = trimIncompleteUtf8(
      record.buffer.slice(-BACKGROUND_TAIL_LIMIT),
    );
    return decodeOutput(bytes, await this.oem());
  }

  private oem(): Promise<string | null> {
    return (this.oemLabel ??= detectOemLabel());
  }

  private finalize(record: RunningRecord, status: Deno.CommandStatus): void {
    if (record.finalized) return;
    record.finalized = true;
    if (record.timer !== undefined) clearTimeout(record.timer);
    const reason: BackgroundCommandReason = record.killedByTimeout
      ? "timeout"
      : record.killedByUser
      ? "killed"
      : "exited";
    record.info.state = reason === "exited" ? "finished" : "killed";
    record.info.finishedAt = Date.now();
    record.info.exitCode = status.code ?? undefined;
    // The command no longer occupies a concurrency slot; keep only a
    // bounded summary for status/list/tail queries. The output tail is
    // decoded below and stored on the summary.
    this.records.delete(record.info.commandId);
    this.completed.unshift(record.info);
    if (this.completed.length > MAX_COMPLETED_COMMANDS) {
      this.completed.length = MAX_COMPLETED_COMMANDS;
    }
    void this.decodeTail(record).then((tail) => {
      record.info.tail = tail;
      const done: BackgroundCommandDone = {
        commandId: record.info.commandId,
        exitCode: record.info.exitCode,
        reason,
        durationSec: Math.max(
          0,
          Math.round(
            (record.info.finishedAt! - record.info.startedAt) / 1000,
          ),
        ),
        tail,
      };
      this.emitEnd(record, tail, reason);
      for (const listener of this.listeners) {
        try {
          listener(done);
        } catch {
          // listener failures must not break the manager
        }
      }
    });
  }
}

// --- tools ------------------------------------------------------------------

export interface AsyncBashToolOptions {
  manager: BackgroundProcessManager;
  sandbox: Sandbox;
}

const startSchema = object({
  cwd: string(
    "Working directory: a workspace folder name (e.g. `Aaa`) or an absolute path",
  ),
  command: string("The shell command to execute in the background"),
  timeout: optional(
    integer(
      "Timeout in seconds (default: no timeout; the command is killed on expiry)",
    ),
  ),
  env: optional(stringMap("Environment variables to pass to the command")),
});

const statusSchema = object({
  id: optional(
    string("Command id from async_bash (omit to list all commands)"),
  ),
});

const killSchema = object({
  id: string("Command id from async_bash"),
});

function formatStatusText(info: BackgroundCommandInfo, tail: string): string {
  const end = info.finishedAt ?? Date.now();
  const state = info.state === "running"
    ? `running (pid ${info.pid}) for ${formatDuration(end - info.startedAt)}`
    : info.state === "finished"
    ? `finished after ${formatDuration(end - info.startedAt)} (exit code ${
      info.exitCode ?? "?"
    })`
    : "killed";
  const body = `Background command #${info.commandId}: ${state}\n` +
    `command: ${info.command}\ncwd: ${info.cwd}`;
  const trimmed = tail.trim();
  return trimmed.length > 0 ? `${body}\n\n[output tail]\n${trimmed}` : body;
}

function formatListLine(info: BackgroundCommandInfo): string {
  const end = info.finishedAt ?? Date.now();
  const state = info.state === "running"
    ? "running"
    : info.state === "finished"
    ? `finished (exit ${info.exitCode ?? "?"})`
    : "killed";
  return (
    `#${info.commandId}  ${state}  ${formatDuration(end - info.startedAt)}  ` +
    `${info.command} (cwd: ${info.cwd})`
  );
}

/** The async_bash tool family: start a command in the background, check on
 * it, kill it. Completion notifications are injected by the session agent
 * (which subscribes to the manager's onExit), not by the tools. */
export function createAsyncBashTools(
  options: AsyncBashToolOptions,
): Tool[] {
  const { manager, sandbox } = options;

  const startTool: Tool<typeof startSchema> = {
    name: TOOL_ASYNC_BASH,
    label: "Async Bash",
    description:
      "Start a shell command in the background and return immediately; the " +
      "command keeps running after this run ends. Use for long-running " +
      "work: dev servers, watchers, downloads. `cwd` is required and must " +
      "be a workspace folder name or an absolute path. Check progress with " +
      "async_bash_status, stop the command with async_bash_kill. You are " +
      "notified when it finishes (a user message starting with " +
      '"[Background command ...]"). Aborting this run does NOT stop the ' +
      "command. On Windows, commands run in PowerShell (PowerShell 7 if " +
      "installed, else Windows PowerShell; systems without PowerShell fall " +
      "back to Git Bash or cmd.exe): use `$env:VAR` for environment " +
      "variables, `;` to separate commands, `2>&1` to merge stderr into " +
      "stdout; `&&` is only available with PowerShell 7. cmd-style aliases " +
      "(`cd`, `dir`, `type`, `copy`) work. On macOS/Linux, commands run in " +
      "/bin/sh.",
    parameters: startSchema,
    execute: async (_id, params) => {
      const resolved = await sandbox.resolve(params.cwd);
      if (!resolved.ok) throw new Error(resolved.reason);
      const { commandId, pid } = await manager.start({
        cwd: resolved.path,
        command: params.command,
        timeoutSec: params.timeout,
        env: params.env,
      });
      return {
        content: [{
          type: "text",
          text: `Started background command #${commandId} (pid ${pid}) in ` +
            `${resolved.path}: ${params.command}\nIt keeps running after ` +
            "this run; check it with async_bash_status, stop it with " +
            "async_bash_kill.",
        }],
        details: { commandId, pid, cwd: resolved.path },
      };
    },
  };

  const statusTool: Tool<typeof statusSchema> = {
    name: TOOL_ASYNC_BASH_STATUS,
    label: "Async Bash Status",
    description:
      "Check the status of background commands started with async_bash. " +
      "With `id`, returns the command's state (running/finished/killed), " +
      "exit code, duration and the tail of its output. Without `id`, lists " +
      "every background command of this session.",
    parameters: statusSchema,
    execute: async (_id, params) => {
      if (params.id === undefined) {
        const list = manager.list();
        if (list.length === 0) {
          return {
            content: [{ type: "text", text: "No background commands." }],
            details: { commands: [] },
          };
        }
        return {
          content: [{
            type: "text",
            text: `Background commands:\n${
              list.map(formatListLine).join("\n")
            }`,
          }],
          details: { commands: list },
        };
      }
      const info = manager.get(params.id);
      if (!info) throw new Error(`Unknown background command: ${params.id}`);
      const tail = (await manager.tail(params.id)) ?? "";
      return {
        content: [{ type: "text", text: formatStatusText(info, tail) }],
        details: { ...info, tail },
      };
    },
  };

  const killTool: Tool<typeof killSchema> = {
    name: TOOL_ASYNC_BASH_KILL,
    label: "Async Bash Kill",
    description:
      "Force-stop a background command (its whole process tree). Safe to " +
      "call on an already-finished command (no-op). Use the `commandId` " +
      "returned by async_bash.",
    parameters: killSchema,
    execute: async (_id, params) => {
      const { alreadyExited, timedOut } = await manager.kill(params.id);
      const text = alreadyExited
        ? `Background command #${params.id} was already finished; nothing to kill.`
        : timedOut
        ? `Kill requested for background command #${params.id}, but the process did not exit within ${
          KILL_WAIT_MS / 1000
        }s.`
        : `Killed background command #${params.id}.`;
      return {
        content: [{ type: "text", text }],
        details: { commandId: params.id, alreadyExited, timedOut },
      };
    },
  };

  return [startTool, statusTool, killTool];
}
