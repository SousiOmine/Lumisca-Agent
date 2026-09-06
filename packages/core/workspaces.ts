import { CoreError } from "./errors.ts";
import type { SessionInfo } from "./types/session.ts";
import type { Workspace } from "./types/workspace.ts";
import { Sandbox } from "./workspace/sandbox.ts";
import type { WorkspaceRepo } from "./workspace/repo.ts";

/** Collaborators the workspace service needs from the core: session
 * lifecycle (rebuild guards, per-session teardown) around workspace
 * mutations. Injected so the service stays free of pool wiring. */
export interface WorkspaceServiceDeps {
  /** Sessions of a workspace (for rebuild guards / teardown). */
  listSessions(workspaceId: string): SessionInfo[];
  /** Guard + mutate + rebuild, atomically w.r.t. streaming sessions. */
  applyChange(sessions: SessionInfo[], mutate: () => void): void;
  /** Forget a session's live agent (workspace deletion). */
  deleteSession(id: string): void;
}

/** Workspace CRUD plus folder resolution. Extracted from LumiscaCore so
 * the validation rules (non-empty folders, chat-workspace protection)
 * and the folder-less chat singleton live in one testable unit; the core
 * keeps only a delegating facade. */
export class WorkspaceService {
  constructor(
    private readonly repo: WorkspaceRepo,
    private readonly deps: WorkspaceServiceDeps,
  ) {}

  async create(name: string, folders: string[]): Promise<Workspace> {
    const resolved = await WorkspaceService.resolveFolders(folders);
    if (resolved.length === 0) {
      throw new CoreError(
        "Workspace must contain at least one folder",
        "invalid",
      );
    }
    return this.repo.create(name, resolved);
  }

  /** The user-facing workspace list. The folder-less chat workspace is an
   * internal singleton: it is excluded so every client only sees
   * workspaces they can actually manage. */
  list(): Workspace[] {
    return this.repo.list().filter((w) => !w.chat);
  }

  get(id: string): Workspace | undefined {
    return this.repo.get(id);
  }

  require(id: string): Workspace {
    const workspace = this.repo.get(id);
    if (!workspace) {
      throw new CoreError(`Workspace not found: ${id}`, "not_found");
    }
    return workspace;
  }

  /** Update a workspace (name and/or folders); running sessions get rebuilt
   * tools when the folders change. Throws `conflict` while a session in
   * the workspace is streaming. */
  async update(
    id: string,
    input: { name?: string; folders?: string[] },
  ): Promise<Workspace> {
    const current = this.require(id);
    if (current.chat) {
      throw new CoreError("The chat workspace cannot be edited", "forbidden");
    }
    const name = input.name ?? current.name;
    const folders = input.folders !== undefined
      ? await WorkspaceService.resolveFolders(input.folders)
      : current.folders;
    if (folders.length === 0) {
      throw new CoreError(
        "Workspace must contain at least one folder",
        "invalid",
      );
    }
    const sessions = this.deps.listSessions(id);
    this.deps.applyChange(sessions, () => {
      this.repo.update(id, name, folders);
    });
    return this.repo.get(id)!;
  }

  delete(id: string): void {
    const current = this.require(id);
    if (current.chat) {
      throw new CoreError("The chat workspace cannot be deleted", "forbidden");
    }
    for (const session of this.deps.listSessions(id)) {
      this.deps.deleteSession(session.id);
    }
    this.repo.delete(id);
  }

  /** The folder-less chat workspace ("simple chat" without a workspace),
   * created on first use. Not user-manageable (update/delete refuse it). */
  getOrCreateChatWorkspace(): Workspace {
    const existing = this.repo.list().find((w) => w.chat);
    if (existing) return existing;
    return this.repo.create("チャット", [], { chat: true });
  }

  /** Resolve workspace folders to real paths; rejects missing ones. */
  static async resolveFolders(folders: string[]): Promise<string[]> {
    const resolved: string[] = [];
    for (const folder of folders) {
      const r = await Sandbox.resolveFolder(folder);
      if (!r.ok) throw new CoreError(r.reason, "invalid");
      resolved.push(r.path);
    }
    return [...new Set(resolved)];
  }
}
