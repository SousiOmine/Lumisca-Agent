export interface SessionInfo {
  id: string;
  workspaceId: string;
  name: string;
  modelProvider: string;
  modelId: string;
  systemPrompt?: string;
  createdAt: number;
  updatedAt: number;
}
