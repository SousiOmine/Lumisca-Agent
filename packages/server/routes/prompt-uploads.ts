/**
 * The files a prompt attaches, before they become part of a prompt.
 *
 * A file no longer rides in the prompt's JSON body. The browser asks for a
 * transfer, sends it in 8 MiB chunks, and the server appends each chunk to a
 * file beside the database. When the last chunk lands, the server copies the
 * file into the stella machine through the machine's stdin and deletes the
 * host copy. The prompt then names the transfer ids, and the store answers
 * with the paths inside the machine.
 *
 * Two consequences are deliberate. The body of no request holds a whole file,
 * so a 2 GiB attachment costs the server one chunk of memory. And a file is
 * copied before its prompt is sent, so an id the store cannot resolve is
 * refused while the reader is still looking at the composer rather than after
 * the run has started.
 */

import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import type { PromptFileRef, SessionInfo } from "@lumisca/core";
import {
  attachmentDisplayName,
  MAX_PROMPT_FILE_BYTES,
  MAX_PROMPT_FILES,
  MAX_PROMPT_FILES_TOTAL_BYTES,
  PROMPT_UPLOAD_CHUNK_BYTES,
  PROMPT_UPLOAD_CHUNK_HEADER,
  paths,
  routePath,
} from "@lumisca/core/shared";
import { Hono } from "hono";
import { AppError, parseBody } from "./util.ts";

/** The slice of the core the store needs. */
export interface PromptUploadApi {
  /** The agent a transfer belongs to, or undefined. An id nobody owns must
   * not create files on this host. */
  getStellaAgent(id: string): { disabledAt: number | null } | undefined;
  ensureStellaReady(agentId: string): Promise<void>;
  getOrCreateStellaSession(agentId: string): Promise<SessionInfo>;
  savePromptFile(
    sessionId: string,
    file: { name: string; path: string; size: number },
    signal?: AbortSignal,
  ): Promise<PromptFileRef>;
}

/** What the prompt route asks of the store: the paths of the uploads it was
 * given, and the release that forgets them once the prompt is accepted. */
export interface PromptUploadSink {
  resolve(agentId: string, ids: readonly string[]): PromptFileRef[];
  release(ids: readonly string[]): void;
}

type Status = "uploading" | "copying" | "completed" | "failed";

interface Entry {
  id: string;
  agentId: string;
  name: string;
  size: number;
  path: string;
  bytes: number;
  status: Status;
  expiresAt: number;
  saved?: PromptFileRef;
  error?: string;
  controller?: AbortController;
  /** One append at a time: two requests that both read the same offset would
   * otherwise both write and leave the file longer than its byte count. */
  appending?: boolean;
}

export interface PromptUploadsOptions {
  /** Directory on this host that holds the partial files. */
  dir: string;
  core: PromptUploadApi;
  /** Clock for retention and tests. */
  now?: () => number;
  /** How long an unfinished or unused transfer is kept. */
  retentionMs?: number;
  /** How often expired transfers are swept. */
  cleanupIntervalMs?: number;
}

/** The largest sum one agent may have in the store at once: exactly the
 * files one prompt may carry. A second prompt's files wait until the first
 * prompt consumes its own, which keeps one abandoned tab from filling the
 * disk with files no message will ever name. */
const MAX_PENDING_BYTES_PER_AGENT = MAX_PROMPT_FILES_TOTAL_BYTES;

/** The same bound across every agent on this server. */
const MAX_PENDING_BYTES_TOTAL = 16 * 1024 * 1024 * 1024;

/** Free space kept clear on the host beyond the file being received. */
const HOST_SPACE_MARGIN_BYTES = 512 * 1024 * 1024;

const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export class PromptUploads implements PromptUploadSink {
  private readonly entries = new Map<string, Entry>();
  private readonly dir: string;
  private readonly core: PromptUploadApi;
  private readonly now: () => number;
  private readonly retentionMs: number;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly ready: Promise<void>;

  constructor(options: PromptUploadsOptions) {
    this.dir = options.dir;
    this.core = options.core;
    this.now = options.now ?? Date.now;
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.ready = fsp
      .mkdir(this.dir, { recursive: true })
      .then(() => this.removeOrphans());
    this.timer = setInterval(
      () => void this.sweep(),
      options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS,
    );
    this.timer.unref?.();
  }

  /** Begin a transfer and return its id. The file is created empty now, so a
   * failure to create it is reported while the reader is still picking. */
  async create(
    agentId: string,
    name: unknown,
    size: unknown,
  ): Promise<{
    id: string;
    offset: number;
  }> {
    await this.ready;
    const agent = this.core.getStellaAgent(agentId);
    if (agent === undefined) {
      throw new AppError("Agent not found", 404);
    }
    if (agent.disabledAt !== null) {
      throw new AppError("The agent is switched off", 409);
    }
    if (typeof name !== "string" || name.trim() === "") {
      throw new AppError("name (string) is required", 400);
    }
    if (
      typeof size !== "number" ||
      !Number.isInteger(size) ||
      size < 0 ||
      size > MAX_PROMPT_FILE_BYTES
    ) {
      throw new AppError(
        `size must be an integer between 0 and ${MAX_PROMPT_FILE_BYTES}`,
        400,
      );
    }
    const used = [...this.entries.values()]
      .filter((entry) => entry.agentId === agentId)
      .reduce((total, entry) => total + entry.size, 0);
    if (used + size > MAX_PENDING_BYTES_PER_AGENT) {
      throw new AppError(
        `This agent already has ${Math.ceil(used / (1024 * 1024))} MiB of files waiting; ${Math.ceil(
          MAX_PENDING_BYTES_PER_AGENT / (1024 * 1024),
        )} MiB is the limit`,
        409,
      );
    }
    const all = [...this.entries.values()].reduce(
      (total, entry) => total + entry.size,
      0,
    );
    if (all + size > MAX_PENDING_BYTES_TOTAL) {
      throw new AppError("The server has too many files waiting", 409);
    }
    const free = await this.freeBytes();
    // The transfers already waiting have not written all their bytes yet, so
    // their declared sizes are reserved here too.
    if (free < size + all + HOST_SPACE_MARGIN_BYTES) {
      throw new AppError(
        `The server does not have enough free space for this file: ${Math.ceil(
          size / (1024 * 1024),
        )} MiB needed`,
        507,
      );
    }

    const id = crypto.randomUUID().replaceAll("-", "");
    const path = join(this.dir, `${id}.part`);
    await fsp.writeFile(path, new Uint8Array(0), { flag: "wx" });
    const createdAt = this.now();
    this.entries.set(id, {
      id,
      agentId,
      name: attachmentDisplayName(name),
      size,
      path,
      bytes: 0,
      status: "uploading",
      expiresAt: createdAt + this.retentionMs,
    });
    return { id, offset: 0 };
  }

  /** Append one chunk. The offset is the client's claim about what the server
   * already has; a mismatch is a resend, never a silent overlap. */
  async append(
    agentId: string,
    id: string,
    offset: unknown,
    bytes: Uint8Array,
    chunkHash: string | undefined,
  ): Promise<{ offset: number }> {
    const entry = this.require(agentId, id);
    if (entry.status !== "uploading") {
      throw new AppError(`Upload is ${entry.status}`, 409);
    }
    if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) {
      throw new AppError("offset must be a non-negative integer", 400);
    }
    if (offset !== entry.bytes) {
      throw new AppError(
        `offset mismatch: the server has ${entry.bytes} bytes`,
        409,
      );
    }
    if (bytes.length === 0) {
      throw new AppError("chunk must not be empty", 400);
    }
    if (bytes.length > PROMPT_UPLOAD_CHUNK_BYTES) {
      throw new AppError(
        `chunk exceeds ${PROMPT_UPLOAD_CHUNK_BYTES} bytes`,
        413,
      );
    }
    if (entry.bytes + bytes.length > entry.size) {
      throw new AppError("chunk exceeds the declared file size", 413);
    }
    if (chunkHash === undefined || !/^[0-9a-f]{64}$/.test(chunkHash)) {
      throw new AppError(
        `${PROMPT_UPLOAD_CHUNK_HEADER} must be a lowercase hex digest`,
        400,
      );
    }
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== chunkHash) {
      throw new AppError("chunk hash does not match its bytes", 400);
    }
    if (entry.appending === true) {
      throw new AppError("another chunk is being written; retry this one", 409);
    }
    entry.appending = true;
    try {
      const onDisk = await fsp.stat(entry.path);
      if (onDisk.size !== entry.bytes) {
        throw new AppError("upload state does not match the file on disk", 409);
      }
      await fsp.appendFile(entry.path, bytes);
      entry.bytes += bytes.length;
      entry.expiresAt = this.now() + this.retentionMs;
      return { offset: entry.bytes };
    } finally {
      entry.appending = false;
    }
  }

  /** Finish a transfer: verify it, copy it into the machine, and keep the
   * path the machine returned. The copy runs in the background; the client
   * polls {@link status} because a 2 GiB copy is not a request. */
  complete(agentId: string, id: string): { status: Status } {
    const entry = this.require(agentId, id);
    if (entry.status === "completed") return { status: "completed" };
    if (entry.status === "copying") return { status: "copying" };
    if (entry.bytes !== entry.size) {
      throw new AppError(
        `upload has ${entry.bytes} of ${entry.size} bytes`,
        409,
      );
    }
    entry.status = "copying";
    entry.error = undefined;
    entry.controller = new AbortController();
    void this.copy(entry);
    return { status: "copying" };
  }

  status(
    agentId: string,
    id: string,
  ): {
    status: Status;
    size: number;
    bytes: number;
    saved?: PromptFileRef;
    error?: string;
  } {
    const entry = this.require(agentId, id);
    return {
      status: entry.status,
      size: entry.size,
      bytes: entry.bytes,
      ...(entry.saved === undefined ? {} : { saved: entry.saved }),
      ...(entry.error === undefined ? {} : { error: entry.error }),
    };
  }

  resolve(agentId: string, ids: readonly string[]): PromptFileRef[] {
    if (ids.length > MAX_PROMPT_FILES) {
      throw new AppError(
        `a prompt can name at most ${MAX_PROMPT_FILES} uploads`,
        400,
      );
    }
    if (new Set(ids).size !== ids.length) {
      throw new AppError("an upload id appears twice", 400);
    }
    const files: PromptFileRef[] = [];
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (
        entry === undefined ||
        entry.agentId !== agentId ||
        entry.saved === undefined
      ) {
        throw new AppError(
          "An uploaded file is no longer available; attach it again",
          409,
        );
      }
      files.push(entry.saved);
    }
    return files;
  }

  release(ids: readonly string[]): void {
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (entry === undefined) continue;
      this.entries.delete(id);
      if (entry.status !== "copying") void fsp.rm(entry.path, { force: true });
    }
  }

  async cancel(agentId: string, id: string): Promise<void> {
    const entry = this.require(agentId, id);
    if (entry.status === "copying") {
      entry.controller?.abort();
    }
    this.entries.delete(id);
    await fsp.rm(entry.path, { force: true });
  }

  dispose(): void {
    clearInterval(this.timer);
  }

  private require(agentId: string, id: string): Entry {
    const entry = this.entries.get(id);
    if (entry === undefined || entry.agentId !== agentId) {
      throw new AppError("Upload not found", 404);
    }
    return entry;
  }

  private async copy(entry: Entry): Promise<void> {
    try {
      await this.core.ensureStellaReady(entry.agentId);
      const session = await this.core.getOrCreateStellaSession(entry.agentId);
      const saved = await this.core.savePromptFile(
        session.id,
        { name: entry.name, path: entry.path, size: entry.size },
        entry.controller?.signal,
      );
      if (this.entries.get(entry.id) !== entry) return;
      entry.saved = saved;
      entry.status = "completed";
      entry.expiresAt = this.now() + this.retentionMs;
      entry.controller = undefined;
      await fsp.rm(entry.path, { force: true });
    } catch (error) {
      if (this.entries.get(entry.id) !== entry) return;
      entry.status = "failed";
      entry.error = error instanceof Error ? error.message : String(error);
      entry.controller = undefined;
    }
  }

  /** A file here with no entry in memory belongs to a previous process: the
   * transfer it was part of cannot be resumed, so it is removed now. */
  private async removeOrphans(): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(this.dir, { withFileTypes: true });
    } catch (error) {
      // A test (or a shutdown) removed the directory before this ran. There
      // is nothing left to sweep, and no transfer could name a file in it.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".part")) {
        await fsp.rm(join(this.dir, entry.name), { force: true });
      }
    }
  }

  private async sweep(): Promise<void> {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (entry.status === "copying" || entry.expiresAt > now) continue;
      this.entries.delete(id);
      await fsp.rm(entry.path, { force: true });
    }
  }

  private async freeBytes(): Promise<number> {
    const stats = await fsp.statfs(this.dir);
    return Number(stats.bavail) * Number(stats.bsize);
  }
}

/** The transfer routes. Mounted under /api beside the stella surface. */
export function promptUploadRoutes(uploads: PromptUploads): Hono {
  const app = new Hono();

  app.post(routePath(paths.conversationUploads), async (c) => {
    const agentId = c.req.param("agentId");
    const body = await parseBody<{ name?: unknown; size?: unknown }>(c);
    const created = await uploads.create(agentId, body?.name, body?.size);
    return c.json(created);
  });

  app.put(routePath(paths.upload), async (c) => {
    const agentId = c.req.param("agentId");
    const uploadId = c.req.param("uploadId");
    const length = Number(c.req.header("content-length"));
    if (Number.isFinite(length) && length > PROMPT_UPLOAD_CHUNK_BYTES) {
      throw new AppError(
        `chunk exceeds ${PROMPT_UPLOAD_CHUNK_BYTES} bytes`,
        413,
      );
    }
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const result = await uploads.append(
      agentId,
      uploadId,
      Number(c.req.query("offset")),
      bytes,
      c.req.header(PROMPT_UPLOAD_CHUNK_HEADER),
    );
    return c.json(result);
  });

  app.get(routePath(paths.upload), (c) =>
    c.json(uploads.status(c.req.param("agentId"), c.req.param("uploadId"))),
  );

  app.post(routePath(paths.uploadComplete), (c) =>
    c.json(uploads.complete(c.req.param("agentId"), c.req.param("uploadId"))),
  );

  app.delete(routePath(paths.upload), async (c) => {
    await uploads.cancel(c.req.param("agentId"), c.req.param("uploadId"));
    return c.json({ ok: true });
  });

  return app;
}
