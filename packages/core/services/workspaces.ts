import type { Workspace } from "../types/workspace.ts";
import type { WorkspaceService } from "../workspaces.ts";

/**
 * Workspaces: the folder sets a session works in (create, list, edit,
 * delete).
 */
export class WorkspaceConfigService {
  constructor(private readonly workspaces: WorkspaceService) {}

  async createWorkspace(name: string, folders: string[]): Promise<Workspace> {
    return await this.workspaces.create(name, folders);
  }

  /** The user-facing workspace list. The folder-less chat workspace is an
   * internal singleton (created on first chat session): it is excluded so
   * every client — web UI, API consumers, federated peers — only sees
   * workspaces they can actually manage. Chat sessions are started without
   * a workspaceId instead of by picking this workspace. */
  listWorkspaces(): Workspace[] {
    return this.workspaces.list();
  }

  getWorkspace(id: string): Workspace | undefined {
    return this.workspaces.get(id);
  }

  /** Update a workspace (name and/or folders); running sessions get rebuilt
   * tools when the folders change. Returns the updated workspace. Throws
   * `conflict` while a session in the workspace is streaming. */
  async updateWorkspace(
    id: string,
    input: { name?: string; folders?: string[] },
  ): Promise<Workspace> {
    return await this.workspaces.update(id, input);
  }

  deleteWorkspace(id: string): Promise<void> {
    return this.workspaces.delete(id);
  }
}
