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
import {
  attachmentDisplayName,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_CALL,
  MAX_ATTACHMENTS_TOTAL_BYTES,
} from "../shared/mod.ts";
import { CoreError } from "../errors.ts";
import { VM_WORKDIR, vmAgentDir } from "./contract.ts";
import type { VmExec } from "./container.ts";

/** Where a prompt's uploads go, inside the agent's own folder: they are the
 * agent's files from the moment it reads them (it may move, edit or keep
 * them), and `ls uploads/` next to its work is where it will look. */
export const VM_UPLOADS_DIR = "uploads";

/** One file the browser sent: the bytes and the name the user knows it by. */
export interface UploadFile {
  name: string;
  bytes: Uint8Array;
}

/** One file as it now sits in the machine. */
export interface SavedUpload {
  /** The name to show (the user's own, cleaned): the card's label and what
   * the model's notice calls the file. */
  name: string;
  /** Absolute path inside the machine. What the model is told. Never shown
   * in the conversation: it is how to reach the file, not who it is. */
  path: string;
  size: number;
}

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
 * Write the files into the agent's uploads folder and report where they are.
 *
 * One directory per send (`uploads/<timestamp>-<random>/`), one file per
 * upload named `<index>-<safe name>`: a re-sent file does not overwrite the
 * previous one, and the order the user picked is visible in a listing.
 * The bounds are the app's existing attachment limits, so "a file I can send
 * to the agent" and "a file the agent can send me" are the same size.
 */
export async function saveUploads(
  files: readonly UploadFile[],
  options: SaveUploadsOptions,
): Promise<SavedUpload[]> {
  if (files.length === 0) return [];
  assertUploadLimits(files);
  const exec = options.exec;
  const folder = `${(options.now ?? Date.now)()}-${
    (options.randomId ?? randomId)()
  }`;
  const directory = `${
    vmAgentDir(options.agentId)
  }/${VM_UPLOADS_DIR}/${folder}`;

  const saved: SavedUpload[] = [];
  for (const [index, file] of files.entries()) {
    options.signal?.throwIfAborted();
    const name = attachmentDisplayName(file.name);
    const stored = `${String(index + 1).padStart(2, "0")}-${name}`;
    const path = `${directory}/${stored}`;
    await writeFile(exec, directory, path, file.bytes, options.signal);
    saved.push({ name, path, size: file.bytes.length });
  }
  return saved;
}

/** `maxdepth 0` keeps the machine from touching anything but the uploads
 * folder itself; the failure is rethrown as a sentence a user can act on. */
async function writeFile(
  exec: VmExec,
  directory: string,
  path: string,
  bytes: Uint8Array,
  signal: AbortSignal | undefined,
): Promise<void> {
  await exec(["mkdir", "-p", "--", directory], {
    timeoutMs: 30_000,
    workdir: VM_WORKDIR,
    ...(signal !== undefined ? { signal } : {}),
  });
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

/** The same bounds the agent's own `chat_attach` obeys (one set of numbers
 * for both directions). Throws a sentence the composer can show. */
function assertUploadLimits(files: readonly UploadFile[]): void {
  if (files.length > MAX_ATTACHMENTS_PER_CALL) {
    throw new CoreError(
      `You can attach up to ${MAX_ATTACHMENTS_PER_CALL} files`,
      "invalid",
    );
  }
  let total = 0;
  for (const file of files) {
    if (file.bytes.length > MAX_ATTACHMENT_BYTES) {
      throw new CoreError(
        `${attachmentDisplayName(file.name)} is larger than ${
          MAX_ATTACHMENT_BYTES / (1024 * 1024)
        } MiB`,
        "invalid",
      );
    }
    total += file.bytes.length;
    if (total > MAX_ATTACHMENTS_TOTAL_BYTES) {
      throw new CoreError(
        `The files total more than ${
          MAX_ATTACHMENTS_TOTAL_BYTES / (1024 * 1024)
        } MiB`,
        "invalid",
      );
    }
  }
}

function randomId(): string {
  return crypto.randomUUID().slice(0, 8);
}
