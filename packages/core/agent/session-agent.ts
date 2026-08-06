import { Agent } from "@earendil-works/pi-agent-core";
import type {
  AgentEvent,
  AgentMessage,
  AgentTool,
  StreamFn,
} from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ClientEvent } from "../types/event.ts";
import type { MessageRepo } from "../session/messages.ts";

export interface SessionAgentOptions {
  sessionId: string;
  systemPrompt: string;
  model: Model<Api>;
  tools: AgentTool[];
  messages?: AgentMessage[];
  streamFn: StreamFn;
  messageRepo: MessageRepo;
  onEvent: (event: ClientEvent) => void;
}

/**
 * One live agent session: wraps pi's Agent, forwards UI events,
 * and persists new messages to the database as they complete.
 */
export class SessionAgent {
  readonly sessionId: string;
  readonly agent: Agent;
  private readonly messageRepo: MessageRepo;
  private readonly onEvent: (event: ClientEvent) => void;
  private savedCount: number;

  constructor(options: SessionAgentOptions) {
    this.sessionId = options.sessionId;
    this.messageRepo = options.messageRepo;
    this.onEvent = options.onEvent;
    this.savedCount = options.messages?.length ?? 0;

    this.agent = new Agent({
      initialState: {
        systemPrompt: options.systemPrompt,
        model: options.model,
        tools: options.tools,
        messages: options.messages ?? [],
      },
      streamFn: options.streamFn,
      sessionId: options.sessionId,
    });
    this.agent.subscribe((event) => this.handleEvent(event));
  }

  get isStreaming(): boolean {
    return this.agent.state.isStreaming;
  }

  get messages(): AgentMessage[] {
    return this.agent.state.messages;
  }

  async prompt(text: string): Promise<void> {
    try {
      await this.agent.prompt(text);
    } catch (error) {
      this.emit({
        type: "session_error",
        sessionId: this.sessionId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  steer(text: string): void {
    this.agent.steer({
      role: "user",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    });
  }

  followUp(text: string): void {
    this.agent.followUp({
      role: "user",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    });
  }

  abort(): void {
    this.agent.abort();
  }

  async waitForIdle(): Promise<void> {
    await this.agent.waitForIdle();
  }

  private emit(event: ClientEvent): void {
    try {
      this.onEvent(event);
    } catch {
      // Event sink failures must not break the agent loop.
    }
  }

  private handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case "agent_start":
        this.emit({ type: "agent_start", sessionId: this.sessionId });
        break;
      case "message_start":
        this.emit({
          type: "message_start",
          sessionId: this.sessionId,
          message: event.message,
        });
        break;
      case "message_update": {
        const ev = event.assistantMessageEvent;
        if (ev.type === "text_delta") {
          this.emit({
            type: "message_delta",
            sessionId: this.sessionId,
            delta: ev.delta,
          });
        }
        break;
      }
      case "message_end":
        this.emit({
          type: "message_end",
          sessionId: this.sessionId,
          message: event.message,
        });
        this.persistMessages();
        break;
      case "tool_execution_start":
        this.emit({
          type: "tool_start",
          sessionId: this.sessionId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        });
        break;
      case "tool_execution_end":
        this.emit({
          type: "tool_end",
          sessionId: this.sessionId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: event.result,
          isError: event.isError,
        });
        break;
      case "agent_end":
        this.emit({ type: "agent_end", sessionId: this.sessionId });
        break;
      default:
        break;
    }
  }

  /** Append only the messages added since the last save. */
  private persistMessages(): void {
    const messages = this.agent.state.messages;
    for (let i = this.savedCount; i < messages.length; i++) {
      this.messageRepo.append(this.sessionId, messages[i]!);
    }
    this.savedCount = messages.length;
  }
}
