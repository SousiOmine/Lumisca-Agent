export interface Workspace {
  id: string;
  name: string;
  folders: string[];
  createdAt: number;
  /** True for the folder-less "simple chat" workspace: sessions created
   * without a workspace live here (see LumiscaCore.createSession). Chat
   * sessions get no file/shell tools and a chat system prompt. */
  chat: boolean;
}
