export interface Workspace {
  id: string;
  name: string;
  folders: string[];
  createdAt: number;
}

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

export interface ProviderInfo {
  id: string;
  name: string;
  configured?: boolean;
  source?: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  contextWindow?: number;
  reasoning?: boolean;
  input?: string[];
  enabled?: boolean;
}

export type TextBlock = { type: "text"; text: string };
export type ImageBlock = { type: "image"; data: string; mimeType: string };
export type ToolCallBlock = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export interface AssistantMessage {
  role: "assistant";
  content: Array<TextBlock | ImageBlock | ToolCallBlock>;
  timestamp: number;
  stopReason?: string;
}

export interface UserMessage {
  role: "user";
  content: Array<TextBlock | ImageBlock>;
  timestamp: number;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: Array<TextBlock | ImageBlock>;
  isError: boolean;
  timestamp: number;
}

export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage;

export type ClientEvent =
  | { type: "session_created"; session: SessionInfo }
  | { type: "agent_start"; sessionId: string }
  | { type: "message_start"; sessionId: string; message: AgentMessage }
  | { type: "message_delta"; sessionId: string; delta: string }
  | { type: "message_end"; sessionId: string; message: AgentMessage }
  | {
    type: "tool_start";
    sessionId: string;
    toolCallId: string;
    toolName: string;
    args: unknown;
  }
  | {
    type: "tool_end";
    sessionId: string;
    toolCallId: string;
    toolName: string;
    result: unknown;
    isError: boolean;
  }
  | { type: "agent_end"; sessionId: string }
  | { type: "session_error"; sessionId: string; message: string }
  | { type: "reload" };

/** Initial data rendered into the SSR HTML and hydrated on the client. */
export interface InitialData {
  workspaces: Workspace[];
  theme: "light" | "dark";
}

/** Live state of one open session tab. */
export interface SessionView {
  info: SessionInfo;
  messages: AgentMessage[];
  streamingText: string;
  runningTools: Map<string, string>; // toolCallId -> toolName
  error?: string;
}

export function isViewRunning(view: SessionView): boolean {
  return view.streamingText.length > 0 || view.runningTools.size > 0;
}
