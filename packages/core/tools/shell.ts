import { decodeUtf8 } from "../shared/mod.ts";

/** How a shell is invoked: the program plus fixed leading args (the command
 * string is appended as one final argv element). */
export interface Shell {
  file: string;
  args: string[];
  /** Extra env vars for this shell (e.g. NO_COLOR for PowerShell's ANSI
   * escape codes). Merged below tool-level env, above nothing — per-call
   * env still wins. */
  env: Record<string, string>;
}

let cached: Shell | undefined;

/**
 * The shell used to run bash tool commands. On Windows the priority is:
 * pwsh (PowerShell 7) → powershell.exe (Windows PowerShell, ships with
 * every Windows) → Git Bash → %COMSPEC% (cmd.exe). PowerShell is preferred
 * because its command-line parser unescapes the `\"` sequences Deno emits
 * when building the process command line, so quoted paths survive;
 * cmd.exe's `/s /c` handling mangles them (a quoted path arrives at the
 * child with literal quote characters). On POSIX, /bin/sh -c (args go
 * through execve argv, so nothing is re-quoted).
 *
 * Detected once per process and cached; the probes are fast `where.exe`
 * lookups plus one spawn per candidate.
 */
export function getShell(): Shell {
  if (Deno.build.os !== "windows") {
    return { file: "/bin/sh", args: ["-c"], env: {} };
  }
  cached ??= detectWindowsShell();
  return cached;
}

/** Build the process for one shell invocation: the detected shell with the
 * command string as its final argument, both pipes captured.
 *
 * This is the single place the env merge order lives — tool/manager env
 * (lowest), the shell's own (NO_COLOR), then per-call env (highest) — so
 * `bash` and `async_bash` cannot end up running the same command with
 * different environments. */
export function shellCommand(options: {
  command: string;
  cwd: string;
  /** Env of the tool/manager as a whole; overridden by the shell's own and
   * by `env`. */
  baseEnv?: Record<string, string>;
  /** Per-call env vars; override everything else. */
  env?: Record<string, string>;
}): Deno.Command {
  const shell = getShell();
  return new Deno.Command(shell.file, {
    args: [...shell.args, options.command],
    cwd: options.cwd,
    env: { ...options.baseEnv, ...shell.env, ...options.env },
    stdout: "piped",
    stderr: "piped",
  });
}

function detectWindowsShell(): Shell {
  const ps = {
    args: ["-NoProfile", "-NonInteractive", "-Command"],
    // PowerShell paints tables with ANSI escapes; they are noise in tool
    // output, so plain text is forced (harmless for 5.1, which never
    // colors redirected output).
    env: { NO_COLOR: "1" },
  };
  if (shellAvailable("pwsh")) return { file: "pwsh", ...ps };
  if (shellAvailable("powershell.exe")) {
    return { file: "powershell.exe", ...ps };
  }
  const bash = findGitBash();
  if (bash !== undefined) return { file: bash, args: ["-c"], env: {} };
  // Last resort: the system default shell. Its quote handling is the
  // reason PowerShell is preferred, but something runnable beats nothing
  // on stripped-down systems.
  return {
    file: Deno.env.get("COMSPEC") ?? "cmd.exe",
    args: ["/d", "/s", "/c"],
    env: {},
  };
}

/** Whether `file` resolves on PATH (where.exe exits 0 when found). */
function shellAvailable(file: string): boolean {
  return whereAll(file).length > 0;
}

/** All PATH matches for `file` (where.exe prints one path per line). */
function whereAll(file: string): string[] {
  try {
    const { stdout, success } = new Deno.Command("where.exe", {
      args: [file],
      stdout: "piped",
      stderr: "null",
    }).outputSync();
    if (!success) return [];
    return decodeUtf8(stdout)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

/** Git Bash's bash.exe: the first PATH entry that is a real bash (the
 * System32 / WindowsApps `bash` entries are the WSL launcher stub, not a
 * usable shell), else the standard Git for Windows install locations
 * (Git adds only `cmd/` to PATH, which has no bash.exe). */
function findGitBash(): string | undefined {
  for (const candidate of whereAll("bash")) {
    if (isWslBashStub(candidate)) continue;
    if (canRun(candidate)) return candidate;
  }
  const programFiles = Deno.env.get("ProgramFiles") ?? "C:\\Program Files";
  for (
    const candidate of [
      `${programFiles}\\Git\\bin\\bash.exe`,
      `${programFiles}\\Git\\usr\\bin\\bash.exe`,
    ]
  ) {
    if (canRun(candidate)) return candidate;
  }
  return undefined;
}

/** Windows ships a `bash` stub in System32 (and an app-execution alias in
 * WindowsApps) that launches WSL instead of a real shell. */
function isWslBashStub(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.includes("system32\\bash.exe") ||
    lower.includes("windowsapps\\bash.exe");
}

/** Whether the file exists and starts (probed with `--version`, harmless
 * for every shell). */
function canRun(file: string): boolean {
  try {
    const { success } = new Deno.Command(file, {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    }).outputSync();
    return success;
  } catch {
    return false;
  }
}
