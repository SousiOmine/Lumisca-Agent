/**
 * Applying a staged package: put the new files next to the running binary,
 * and hand over to a successor process when asked to.
 *
 * Replacing a running server's own files is platform-specific work:
 *
 * - Windows lets a running executable be *renamed* but neither deleted nor
 *   overwritten (measured: the rename succeeds, the delete fails until the
 *   process exits). So the old binary is moved aside to
 *   `<binary>.old-<version>` and the new one is moved into its place; the
 *   leftovers are removed on the next startup, when nothing holds them.
 * - Everything else is a plain replace, but a replace can still fail (an
 *   unwritable directory, a file held open by another process), so every
 *   moved file is kept as a backup until the whole swap succeeded: a failure
 *   rolls the installation back to its previous version instead of leaving a
 *   half-updated server behind.
 *
 * The swap never touches the running process: its code is already loaded and
 * its assets are read once (packages/server/assets.ts memoizes the manifest),
 * so a running agent session keeps working until the restart.
 *
 * Because the files are replaced in place, the install directory's *name*
 * must never carry a version: it would keep advertising the release the
 * directory was first unpacked from while the files inside move on (the
 * release workflow's packaging step keeps it version-free, and
 * packages/core/repo_hygiene_test.ts holds that line). Which version an
 * installation runs is answered by the binary itself (`--version`), by the
 * applied-update record next to it (stage.ts) and by the release manifest.
 */
import { basename, join } from "node:path";
import { extractArchive } from "./archive.ts";
import {
  EXTRACT_DIR_NAME,
  STAGED_METADATA_FILE,
  type StagedUpdate,
  stagingDir,
  writeAppliedUpdate,
} from "./stage.ts";
import { PORT_WAIT_ENV_KEY } from "../startup.ts";
import { errorMessage, VM_CONTAINER_DIR_NAME } from "@lumisca/core";

/** Where the running server lives. */
export interface InstallEnvironment {
  /** Directory holding the server binary and its assets. */
  installDir: string;
  /** Path of the running server binary (`Deno.execPath()`). */
  execPath: string;
}

/** An update that could not be put in place. */
export class InstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallError";
  }
}

/** Files a package installs next to the binary (the package layout, see
 * scripts/build-server.ts): the binary, the assets it serves, and the
 * stella machine's container directory. A directory is listed (and
 * installed) as a whole, under its own name. */
export function installedFileNames(execPath: string): string[] {
  return [
    basename(execPath),
    "assets.json",
    "icudtl.dat",
    VM_CONTAINER_DIR_NAME,
  ];
}

/** Run `<binary> --version` and return its output. Used to prove a staged
 * binary is runnable and really is the version the manifest promised. */
export async function runVersionCommand(binary: string): Promise<string> {
  const output = await new Deno.Command(binary, {
    args: ["--version"],
    // The staged binary must not inherit this process's launch configuration
    // (it is not supposed to start a server, but a startup value slipping in
    // could otherwise make the check bind a port or touch a database).
    clearEnv: true,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new InstallError(
      `新しいバイナリを実行できませんでした (終了コード ${output.code})${
        messageFromStderr(output.stderr)
      }`,
    );
  }
  return new TextDecoder().decode(output.stdout);
}

function messageFromStderr(stderr: Uint8Array): string {
  const text = new TextDecoder().decode(stderr).trim();
  return text === "" ? "" : `: ${text.split("\n").slice(0, 3).join(" / ")}`;
}

async function removeQuietly(
  path: string,
  options?: { recursive?: boolean },
): Promise<void> {
  try {
    await Deno.remove(path, { recursive: options?.recursive ?? false });
  } catch {
    // Missing, not empty (a leftover directory this call may not remove
    // recursively), or still held by a process that has not exited yet.
  }
}

/** A top-level entry of an installed package: a file of the package root, or
 * the one directory the layout defines (the stella machine's container
 * files), which is installed and replaced as a whole. */
interface PackageEntry {
  name: string;
  isDirectory: boolean;
}

/** The top-level entries a package's extracted files make up. A directory's
 * files follow it in archive order, so it is listed once. */
function packageEntries(files: readonly string[]): PackageEntry[] {
  const entries: PackageEntry[] = [];
  for (const file of files) {
    const separator = file.indexOf("/");
    const name = separator === -1 ? file : file.slice(0, separator);
    if (!entries.some((entry) => entry.name === name)) {
      entries.push({ name, isDirectory: separator !== -1 });
    }
  }
  return entries;
}

export interface ApplyOptions {
  environment: InstallEnvironment;
  staged: StagedUpdate;
  /** Version the running process reports; names the backup files. */
  currentVersion: string;
  /** Injected in tests (the default runs the real binary). */
  versionCheck?: (binary: string) => Promise<string>;
}

export interface ApplyResult {
  version: string;
  /** Files replaced in the install directory, in the order they landed. */
  replaced: string[];
  /** Backup of the previous binary, kept for the next startup to remove. */
  backup: string;
}

/**
 * Put the staged package's files in place. Returns once every file landed;
 * on any failure the previous files are restored and an {@link InstallError}
 * is thrown (the staged package is kept, so a retry is possible).
 */
export async function applyStagedUpdate(
  options: ApplyOptions,
): Promise<ApplyResult> {
  const { installDir, execPath } = options.environment;
  const binaryName = basename(execPath);
  const versionCheck = options.versionCheck ?? runVersionCommand;
  const extractDir = join(stagingDir(installDir), EXTRACT_DIR_NAME);

  // 1. Unpack into the staging area and prove the new binary runs and
  //    reports the version the manifest promised.
  await Deno.remove(extractDir, { recursive: true }).catch(() => {});
  await Deno.mkdir(extractDir, { recursive: true });
  let files: string[];
  try {
    files = await extractArchive(
      options.staged.archivePath,
      options.staged.format,
      extractDir,
    );
    if (!files.includes(binaryName)) {
      throw new InstallError(
        `更新パッケージに ${binaryName} が含まれていません`,
      );
    }
    const extractedBinary = join(extractDir, binaryName);
    // The execute bit must survive the move into the install directory
    // (tar entries usually carry it, but the mode is not part of the
    // contract this updater relies on).
    await Deno.chmod(extractedBinary, 0o755).catch(() => {});
    const reported = (await versionCheck(extractedBinary)).trim();
    if (reported !== options.staged.version) {
      throw new InstallError(
        `更新パッケージのバージョンが一致しません ` +
          `(バイナリ: "${reported}", マニフェスト: "${options.staged.version}")`,
      );
    }
  } catch (error) {
    await Deno.remove(extractDir, { recursive: true }).catch(() => {});
    throw error;
  }

  // 2. Move the new entries into the install directory under `.new` names
  //    (same volume, so this is a rename and cannot partially copy). An
  //    entry is a top-level item of the package: a file, or the stella
  //    machine's container directory — which moves as one unit, so the
  //    install never mixes two releases' files inside it.
  const entries = packageEntries(files);
  const prepared: string[] = [];
  try {
    for (const entry of entries) {
      const target = join(installDir, `${entry.name}.new`);
      await removeQuietly(target);
      await Deno.rename(join(extractDir, entry.name), target);
      prepared.push(entry.name);
    }
  } catch (error) {
    for (const name of prepared) {
      await removeQuietly(join(installDir, `${name}.new`));
    }
    await Deno.remove(extractDir, { recursive: true }).catch(() => {});
    throw new InstallError(
      `更新ファイルを配置できませんでした (${installDir}): ` +
        `${errorMessage(error)}`,
    );
  }

  // 3. Swap, keeping every previous file as a backup until the last one
  //    landed. The binary goes first: a new binary with old assets is
  //    recoverable on its own, the reverse would serve a new UI from an old
  //    server.
  const order: PackageEntry[] = [
    entries.find((entry) => entry.name === binaryName)!,
    ...entries.filter((entry) => entry.name !== binaryName),
  ];
  const backupSuffix = `.old-${options.currentVersion}`;
  const backups: Array<
    { backup: string; target: string; isDirectory: boolean }
  > = [];
  /** Targets this apply created (nothing was there before): rolling back
   * means deleting them, not restoring a backup. */
  const added: Array<{ target: string; isDirectory: boolean }> = [];
  const failures: string[] = [];

  for (const entry of order) {
    const { name, isDirectory } = entry;
    const target = join(installDir, name);
    const newPath = join(installDir, `${name}.new`);
    const backupPath = join(installDir, `${name}${backupSuffix}`);
    try {
      await removeQuietly(backupPath, { recursive: isDirectory });
      const existing = await Deno.stat(target).then(() => true).catch(() =>
        false
      );
      if (existing) {
        await Deno.rename(target, backupPath);
        backups.push({ backup: backupPath, target, isDirectory });
      }
      await Deno.rename(newPath, target);
      if (!existing) added.push({ target, isDirectory });
    } catch (error) {
      failures.push(
        `${name}: ${errorMessage(error)}`,
      );
      break;
    }
  }

  if (failures.length > 0) {
    // Roll back to the previous version: restore every backup, drop the
    // files this apply created, and remove the staged `.new` names. A file
    // the package ADDED (not part of the running version) must go too, or
    // the installation would be a mixture of two versions.
    for (const entry of backups.reverse()) {
      await removeQuietly(entry.target, { recursive: entry.isDirectory });
      await Deno.rename(entry.backup, entry.target).catch(() => {});
    }
    for (const entry of added) {
      await removeQuietly(entry.target, { recursive: entry.isDirectory });
    }
    for (const entry of order) {
      await removeQuietly(join(installDir, `${entry.name}.new`), {
        recursive: entry.isDirectory,
      });
    }
    await Deno.remove(extractDir, { recursive: true }).catch(() => {});
    throw new InstallError(
      `更新の適用に失敗しました (以前のファイルに戻しました): ${
        failures.join(" / ")
      }`,
    );
  }

  // 4. The swap completed: the package is no longer needed, and the backups
  //    are the next startup's cleanup job (a file may still be held open by
  //    the running process — measured on Windows for the binary itself).
  await Deno.remove(extractDir, { recursive: true }).catch(() => {});
  await removeQuietly(options.staged.archivePath);
  await removeQuietly(join(stagingDir(installDir), STAGED_METADATA_FILE));
  await writeAppliedUpdate(installDir, options.staged.version);

  return {
    version: options.staged.version,
    replaced: order.map((entry) => entry.name),
    backup: join(installDir, `${binaryName}${backupSuffix}`),
  };
}

export interface SuccessorOptions {
  /** Binary to start (the just-installed one). */
  execPath: string;
  /** Working directory to restore (a packaged server resolves its database
   * relative to it). */
  cwd: string;
  /** Environment built by {@link successorEnvironment}: the launch
   * configuration to replay, so the successor starts exactly like its
   * predecessor did. */
  env: Record<string, string>;
}

/**
 * The environment a successor process is started with: the launch
 * configuration this process captured, re-applied on top of the inherited
 * environment (the successor still needs PATH, HOME, … — only this server's
 * own launch values were removed from the environment at startup).
 */
export function successorEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  portWaitMs: number | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value;
  }
  if (portWaitMs !== undefined) result[PORT_WAIT_ENV_KEY] = String(portWaitMs);
  return result;
}

/**
 * Start the successor process that takes over after this one exits, and
 * return its pid.
 *
 * Launching it naively (`Deno.Command(...).spawn()` + `unref`) is **not**
 * enough on Windows: measured on this project's machine, a child spawned
 * that way dies with its parent (Deno tracks spawned children in a Job
 * Object), so the restart would silently leave the user with no server. The
 * hand-over therefore goes through the shell's `start /b`, which asks the OS
 * for a process of its own:
 *
 *   cmd /c start "" /b <binary>   (Windows)
 *   <binary>                      (POSIX: an orphan is reparented to init)
 *
 * `start /b` inherits this process's console (no window pops up) and the
 * environment handed to `cmd`, so the successor gets exactly the launch
 * configuration replayed by {@link successorEnvironment}, its stdout/stderr
 * still attached to ours, and the working directory of `cwd`.
 */
export function startSuccessor(options: SuccessorOptions): number {
  const env = options.env;
  if (Deno.build.os !== "windows") {
    const child = new Deno.Command(options.execPath, {
      cwd: options.cwd,
      env,
      stdin: "null",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
    child.unref();
    return child.pid;
  }

  // cmd.exe parses its own command line, so the binary path (which may
  // contain spaces) is quoted here rather than left to Deno's per-argument
  // quoting of the cmd invocation.
  const commandLine = quoteWindowsArgument(options.execPath);
  const child = new Deno.Command("cmd", {
    // The empty argument is `start`'s window-title slot: without it, a quoted
    // path would be taken as the title instead of the program.
    args: ["/c", "start", '""', "/b", commandLine],
    cwd: options.cwd,
    env,
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  child.unref();
  return child.pid;
}

/** Quote one argument for a `cmd.exe` command line (used for the successor
 * path, which is all `start` needs to see). */
function quoteWindowsArgument(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Remove the leftovers of an update: `<file>.old-<version>` backups and
 * `<file>.new` staging names from an interrupted apply. Called at startup,
 * when no other process holds those files; failures are ignored (a file can
 * still be locked by a process that has not exited yet, and the next startup
 * tries again).
 */
export async function cleanupStaleFiles(
  environment: InstallEnvironment,
): Promise<string[]> {
  const names = new Set(installedFileNames(environment.execPath));
  const removed: string[] = [];
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(environment.installDir)];
  } catch {
    return removed;
  }
  for (const entry of entries) {
    // A backup of a directory entry (the stella machine's container files)
    // is a directory too, so this looks at files and directories alike.
    const isBackup = [...names].some((name) =>
      entry.name.startsWith(`${name}.old-`)
    );
    const isStaged = entry.name.endsWith(".new") &&
      names.has(entry.name.slice(0, -".new".length));
    if (!isBackup && !isStaged) continue;
    try {
      await Deno.remove(join(environment.installDir, entry.name), {
        recursive: true,
      });
      removed.push(entry.name);
    } catch {
      // Still locked: the next startup will collect it.
    }
  }
  return removed;
}
