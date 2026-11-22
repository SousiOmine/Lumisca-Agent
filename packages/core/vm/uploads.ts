/**
 * Files the user attaches to a prompt, put where the agent can read them.
 *
 * A prompt's files are not sent to the model as bytes: they are written into
 * the machine and the model is told their paths (see
 * `textWithFileNotice` in ../attachments.ts). That is the only shape that
 * works for what people actually attach to a coding agent — a log, a
 * screenshot of a failing test, a tarball — and it costs nothing to explain,
 * because `read` and `bash` are already the tools a stella agent uses.
 *
 * The writer is the CONTAINER's file system, so this lives beside the other
 * machine seams rather than in the session stores: the files have to exist
 * inside the VM, and every route that accepts an upload goes through here.
 * Names are generated (a timestamp and a random segment per batch, the
 * index and the user's own name per file), so a caller cannot address a
 * directory outside the uploads folder.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname } from "node:path";
import { CoreError } from "../errors.ts";
import {
  attachmentDisplayName,
  isInlineImageExtension,
  MAX_PROMPT_FILE_BYTES,
  MAX_PROMPT_FILES,
  MAX_PROMPT_FILES_TOTAL_BYTES,
  type PromptFileRef,
} from "../shared/mod.ts";
import type { VmExec, VmExecBytes } from "./container.ts";
import { VM_WORKDIR, vmAgentDir } from "./contract.ts";

/** Where a prompt's uploads go, inside the agent's own folder: they are the
 * agent's files from the moment it reads them (it may move, edit or keep
 * them), and `ls uploads/` next to its work is where it will look. */
export const VM_UPLOADS_DIR = "uploads";

/** One prompt image the browser sent: the bytes and the name the user knows
 * it by. Pictures still travel in the prompt body (bounded by
 * prepareStoredImage), unlike files, which are uploaded in chunks first. */
export interface PromptImageFile {
  name: string;
  bytes: Uint8Array;
}

/** One prompt file already on this host, waiting to be copied into the
 * machine. The upload route writes it under a temporary name; this module
 * only reads it. */
export interface HostPromptFile {
  name: string;
  path: string;
  size: number;
}

/** One file as it now sits in the machine: exactly what the transcript
 * records (see PromptFileRef), so the store and the conversation agree on
 * what an upload is. */
export type SavedUpload = PromptFileRef;

export interface SaveUploadsOptions {
  /** The session's exec seam (the stella machine). */
  exec: VmExec;
  /** The agent the prompt belongs to: its working folder holds the uploads. */
  agentId: string;
  signal?: AbortSignal;
  /** The clock, for the per-batch folder name (tests pin it). */
  now?: () => number;
  /** The random segment of the per-batch folder name (tests pin it). */
  randomId?: () => string;
}

/**
 * Write the prompt's pictures into the agent's uploads folder.
 *
 * One directory per send (`uploads/<timestamp>-<random>/`), one file per
 * upload named `<index>-<safe name>`: a re-sent file does not overwrite the
 * previous one, and the order the user picked is visible in a listing.
 */
export async function savePromptImages(
  files: readonly PromptImageFile[],
  options: SaveUploadsOptions,
): Promise<SavedUpload[]> {
  if (files.length === 0) return [];
  assertImageLimits(files);
  const exec = options.exec;
  const folder = `${(options.now ?? Date.now)()}-${(options.randomId ?? randomId)()}`;
  const directory = `${vmAgentDir(
    options.agentId,
  )}/${VM_UPLOADS_DIR}/${folder}`;

  const saved: SavedUpload[] = [];
  for (const [index, file] of files.entries()) {
    options.signal?.throwIfAborted();
    const name = attachmentDisplayName(file.name);
    const stored = `${String(index + 1).padStart(2, "0")}-${name}`;
    const path = `${directory}/${stored}`;
    await writeFile(exec, directory, path, file.bytes, options.signal);
    saved.push({
      name,
      path,
      size: file.bytes.length,
      ref: `${VM_UPLOADS_DIR}/${folder}/${stored}`,
      image: isInlineImageExtension(extname(name)),
    });
  }
  return saved;
}

/**
 * Copy files the browser uploaded onto this host's temporary files into the
 * agent's uploads folder, one at a time, through the machine's stdin.
 *
 * The bytes are never held whole in this process: a 2 GiB file is a read
 * stream into the command's stdin. The destination is written under its final
 * path inside a folder that is new for this call, so an agent listing the
 * folder cannot see a half-written file under a name it might open.
 */
export async function savePromptFiles(
  files: readonly HostPromptFile[],
  options: SaveUploadsOptions,
): Promise<SavedUpload[]> {
  if (files.length === 0) return [];
  await assertPromptFileLimits(files, options.exec, options.signal);
  const exec = options.exec;
  const folder = `${(options.now ?? Date.now)()}-${(options.randomId ?? randomId)()}`;
  const agentDir = vmAgentDir(options.agentId);
  const directory = `${agentDir}/${VM_UPLOADS_DIR}/${folder}`;
  // The bytes land here first, outside the folder the agent reads, and are
  // moved into their final name only after the size check. A listing of
  // uploads/ therefore never shows a name that is still growing.
  const staging = `${agentDir}/.lumisca-upload-staging`;

  const saved: SavedUpload[] = [];
  for (const [index, file] of files.entries()) {
    options.signal?.throwIfAborted();
    const name = attachmentDisplayName(file.name);
    const stored = `${String(index + 1).padStart(2, "0")}-${name}`;
    const path = `${directory}/${stored}`;
    const temporary = `${staging}/${folder}-${index}`;
    await writeFileFromHost(exec, staging, temporary, file, options.signal);
    await ensureDirectory(exec, directory, options.signal);
    const moved = await exec(["mv", "--", temporary, path], {
      timeoutMs: 60_000,
      workdir: VM_WORKDIR,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    if (moved.exitCode !== 0) {
      throw new CoreError(
        `Could not move the file into the uploads folder: ${
          moved.stderr.trim() || `exit code ${moved.exitCode}`
        }`,
        "unavailable",
      );
    }
    saved.push({
      name,
      path,
      size: file.size,
      ref: `${VM_UPLOADS_DIR}/${folder}/${stored}`,
      image: isInlineImageExtension(extname(name)),
    });
  }
  return saved;
}

/** Write the bytes through the machine's stdin, then report a failure in a
 * sentence a user can act on. */
async function writeFile(
  exec: VmExec,
  directory: string,
  path: string,
  bytes: Uint8Array,
  signal: AbortSignal | undefined,
): Promise<void> {
  await ensureDirectory(exec, directory, signal);
  const result = await exec(["sh", "-c", 'cat > "$1"', "sh", path], {
    timeoutMs: 60_000,
    workdir: VM_WORKDIR,
    stdin: bytes,
    ...(signal !== undefined ? { signal } : {}),
  });
  if (result.exitCode !== 0) {
    throw new CoreError(
      `Could not put the file in the machine: ${
        result.stderr.trim() || `exit code ${result.exitCode}`
      }`,
      "unavailable",
    );
  }
}

/** Copy one host file into the machine without reading it into memory. */
async function writeFileFromHost(
  exec: VmExec,
  directory: string,
  path: string,
  file: HostPromptFile,
  signal: AbortSignal | undefined,
): Promise<void> {
  await ensureDirectory(exec, directory, signal);
  const result = await exec(["sh", "-c", 'cat > "$1"', "sh", path], {
    // Five megabytes per second is far below the machine's disk: the bound
    // only has to be above "a large file on a slow disk", not a guess at the
    // speed. The 30 minute ceiling matches the client's poll deadline.
    timeoutMs: Math.min(
      30 * 60_000,
      60_000 + Math.ceil(file.size / (1024 * 1024)) * 200,
    ),
    workdir: VM_WORKDIR,
    stdin: createReadStream(file.path),
    ...(signal !== undefined ? { signal } : {}),
  });
  if (result.exitCode !== 0) {
    throw new CoreError(
      `Could not put the file in the machine: ${
        result.stderr.trim() || `exit code ${result.exitCode}`
      }`,
      "unavailable",
    );
  }
  // The write is a pipe: a read error on the host's side, a killed command or
  // a swallowed short write would all leave a smaller file under the final
  // name. The size is the one fact the host knows that the machine can check.
  const size = await exec(
    [
      "sh",
      "-c",
      'test "$(wc -c < "$1")" = "$2"',
      "sh",
      path,
      String(file.size),
    ],
    {
      timeoutMs: 30_000,
      workdir: VM_WORKDIR,
      ...(signal !== undefined ? { signal } : {}),
    },
  );
  if (size.exitCode !== 0) {
    throw new CoreError(
      `The machine did not receive the whole of ${attachmentDisplayName(file.name)}`,
      "unavailable",
    );
  }
}

async function ensureDirectory(
  exec: VmExec,
  directory: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  await exec(["mkdir", "-p", "--", directory], {
    timeoutMs: 30_000,
    workdir: VM_WORKDIR,
    ...(signal !== undefined ? { signal } : {}),
  });
}

/** Pictures the prompt carries in its body: bounded before they get here
 * (prepareStoredImage), and still bounded again at the seam. */
function assertImageLimits(files: readonly PromptImageFile[]): void {
  if (files.length > MAX_PROMPT_FILES) {
    throw new CoreError(
      `You can attach up to ${MAX_PROMPT_FILES} files`,
      "invalid",
    );
  }
  let total = 0;
  for (const file of files) {
    if (file.bytes.length > MAX_PROMPT_IMAGE_BYTES) {
      throw new CoreError(
        `${attachmentDisplayName(file.name)} is larger than ${
          MAX_PROMPT_IMAGE_BYTES / (1024 * 1024)
        } MiB`,
        "invalid",
      );
    }
    total += file.bytes.length;
    if (total > MAX_PROMPT_IMAGE_BYTES) {
      throw new CoreError(
        `The pictures total more than ${
          MAX_PROMPT_IMAGE_BYTES / (1024 * 1024)
        } MiB`,
        "invalid",
      );
    }
  }
}

/** The prompt's own file bounds, plus the machine's free space. A file that
 * changed on its way to the machine is refused rather than truncated: the
 * bytes the browser sent are the bytes the agent must read. */
async function assertPromptFileLimits(
  files: readonly HostPromptFile[],
  exec: VmExec,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (files.length > MAX_PROMPT_FILES) {
    throw new CoreError(
      `You can attach up to ${MAX_PROMPT_FILES} files`,
      "invalid",
    );
  }
  let total = 0;
  for (const file of files) {
    if (file.size > MAX_PROMPT_FILE_BYTES) {
      throw new CoreError(
        `${attachmentDisplayName(file.name)} is larger than ${
          MAX_PROMPT_FILE_BYTES / (1024 * 1024 * 1024)
        } GiB`,
        "invalid",
      );
    }
    const onDisk = await stat(file.path);
    if (onDisk.size !== file.size) {
      throw new CoreError(
        `${attachmentDisplayName(file.name)} changed while it was uploaded`,
        "invalid",
      );
    }
    total += file.size;
    if (total > MAX_PROMPT_FILES_TOTAL_BYTES) {
      throw new CoreError(
        `The files total more than ${
          MAX_PROMPT_FILES_TOTAL_BYTES / (1024 * 1024 * 1024)
        } GiB`,
        "invalid",
      );
    }
  }
  // The agents' folders sit on the machine's home volume, so the free space
  // there is the space these files will use.
  const freeBytes = await vmFreeBytes(exec, VM_WORKDIR, signal);
  if (freeBytes < total + 256 * 1024 * 1024) {
    throw new CoreError(
      `The machine does not have enough free space for these files: ${Math.ceil(
        total / (1024 * 1024),
      )} MiB needed`,
      "invalid",
    );
  }
}

/** Free bytes of the filesystem holding `path` inside the machine. */
async function vmFreeBytes(
  exec: VmExec,
  path: string,
  signal: AbortSignal | undefined,
): Promise<number> {
  const result = await exec(["df", "-Pk", path], {
    timeoutMs: 30_000,
    workdir: VM_WORKDIR,
    ...(signal !== undefined ? { signal } : {}),
  });
  if (result.exitCode !== 0) {
    throw new CoreError(
      `Could not read the machine's free space: ${
        result.stderr.trim() || `exit code ${result.exitCode}`
      }`,
      "unavailable",
    );
  }
  const line = result.stdout.trim().split("\n").at(-1) ?? "";
  const columns = line.trim().split(/\s+/);
  const availableKb = Number(columns[3]);
  if (!Number.isFinite(availableKb)) {
    throw new CoreError(
      "Could not read the machine's free space: unexpected df output",
      "unavailable",
    );
  }
  return availableKb * 1024;
}

/** The largest upload the conversation will draw back: an image, not an
 * archive. A file over this is still readable inside the machine; the
 * conversation just cannot show it. */
export const MAX_PROMPT_IMAGE_BYTES = 20 * 1024 * 1024;

function randomId(): string {
  return crypto.randomUUID().slice(0, 8);
}

/**
 * The shape of a stored upload reference, relative to the agent's folder:
 * `uploads/<batch>/<index>-<name>`. Validated before it becomes a path, so a
 * caller cannot address anything outside the uploads folder (the same
 * property the asset stores keep: only names this module generated are
 * reachable).
 */
const UPLOAD_REF = /^uploads\/[0-9]+-[0-9a-f]{8}\/[0-9]{2}-[^/\\]+$/;

/** Whether `ref` is a reference this module can have generated. */
export function isUploadRef(ref: string): boolean {
  return UPLOAD_REF.test(ref);
}

/**
 * Read one upload back out of the machine, or undefined when the file is no
 * longer there.
 *
 * The machine is the truth: a file the agent (or the user, through it)
 * deleted is gone, and the conversation says so rather than showing an image
 * that no longer exists anywhere (see the prompt-upload route). An
 * unreadable machine (podman failing) throws — that is a different sentence
 * from "the file is gone".
 */
export async function readUpload(
  exec: VmExec,
  execBytes: VmExecBytes,
  options: {
    agentId: string;
    ref: string;
    /** Refuse anything larger (a conversation shows images; a 100 MB file
     * is not one). */
    maxBytes: number;
    signal?: AbortSignal;
  },
): Promise<{ bytes: Uint8Array; name: string } | undefined> {
  if (!isUploadRef(options.ref)) return undefined;
  const path = `${vmAgentDir(options.agentId)}/${options.ref}`;
  // `test -f` first: it separates "gone" (an answer) from "read failed" (an
  // error), and a missing file is the ordinary case once the machine's
  // contents changed.
  const exists = await exec(["sh", "-c", 'test -f "$1"', "sh", path], {
    timeoutMs: 30_000,
    workdir: VM_WORKDIR,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  if (exists.exitCode !== 0) return undefined;
  // The byte seam: an image must not be decoded as text on its way out.
  const result = await execBytes(["cat", "--", path], {
    timeoutMs: 60_000,
    workdir: VM_WORKDIR,
    maxOutput: options.maxBytes,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  if (result.exitCode !== 0) {
    throw new CoreError(
      `Could not read the file from the machine: ${
        result.stderr.trim() || `exit code ${result.exitCode}`
      }`,
      "unavailable",
    );
  }
  if (result.truncated) {
    // Not an error and not "gone": the file is there but is not something a
    // conversation draws. Said plainly so a caller does not report it as
    // deleted.
    throw new CoreError(
      `The file is larger than ${options.maxBytes} bytes and was not read`,
      "invalid",
    );
  }
  const name = options.ref.split("/").pop() ?? options.ref;
  return { bytes: result.stdout, name };
}
