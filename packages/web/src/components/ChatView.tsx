import { useEffect, useRef, useState } from "react";
import { contentText } from "../../../core/content.ts";
import { isViewRunning, type SessionView } from "../types.ts";
import type {
  AgentMessage,
  AssistantMessage,
  ToolCallBlock,
  ToolResultMessage,
} from "../types.ts";
import { ToolCall } from "./ToolCall.tsx";
import { Composer } from "./Composer.tsx";
import { renderMarkdown } from "../markdown.ts";

interface ChatViewProps {
  view: SessionView;
  onPrompt: (text: string) => void;
  onAbort: () => void;
  onModelChange: (provider: string, modelId: string) => void;
}

export function ChatView({ view, onPrompt, onAbort, onModelChange }: ChatViewProps) {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const isRunning = isViewRunning(view);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [view.messages.length, view.streamingText.length]);

  const submit = () => {
    if (!input.trim() || isRunning) return;
    onPrompt(input);
    setInput("");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape" && isRunning) {
      e.preventDefault();
      onAbort();
    }
  };

  return (
    <div className="chat">
      <div className="chat-scroll" ref={scrollRef}>
        <div className="chat-column">
          {view.messages.length === 0 && view.streamingText.length === 0 && (
            <div className="chat-empty" style={{ height: "50vh" }}>
              <div className="chat-empty-inner">
                <p>
                  タスクを入力してください。ファイルの読み書きとシェルコマンドを
                  ワークスペース内で実行します。
                </p>
              </div>
            </div>
          )}
          {view.messages.map((m, i) => (
            <MessageRow
              key={`${m.role}-${m.timestamp}-${i}`}
              message={m}
              following={view.messages.slice(i + 1)}
              runningTools={view.runningTools}
            />
          ))}
          {view.streamingText.length > 0 && (
            <div className="msg">
              <div className="msg-body markdown">
                <div
                  dangerouslySetInnerHTML={{
                    __html: renderMarkdown(view.streamingText),
                  }}
                />
                <span className="cursor" />
              </div>
            </div>
          )}
          {view.error && (
            <div className="msg">
              <div className="msg-body error-text">
                <p>{view.error}</p>
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="input-area">
        <Composer
          value={input}
          onChange={setInput}
          placeholder="タスクを入力..."
          onKeyDown={onKeyDown}
          model={{ provider: view.info.modelProvider, modelId: view.info.modelId }}
          onModelSelect={onModelChange}
          submitLabel="送信"
          submitDisabled={!input.trim()}
          onAbort={isRunning ? onAbort : undefined}
          onSubmit={submit}
        />
      </div>
    </div>
  );
}

function MessageRow({
  message,
  following,
  runningTools,
}: {
  message: AgentMessage;
  following: AgentMessage[];
  runningTools: Map<string, string>;
}) {
  if (message.role === "toolResult") return null;

  if (message.role === "user") {
    const text = contentText(message.content as Array<{ type: string; text?: string }>);
    return (
      <div className="msg user">
        <div className="msg-body">
          <p>{text}</p>
        </div>
      </div>
    );
  }

  const assistant = message as AssistantMessage;
  const text = contentText(assistant.content as Array<{ type: string; text?: string }>);
  const toolCalls = assistant.content.filter(
    (b): b is ToolCallBlock => b.type === "toolCall",
  );

  // Collect the toolResult messages that follow this assistant message.
  const toolResults = new Map<string, ToolResultMessage>();
  for (const m of following) {
    if (m.role !== "toolResult") break;
    toolResults.set(m.toolCallId, m);
  }

  return (
    <div className="msg">
      <div className="msg-body markdown">
        {text && <div dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />}
        {toolCalls.map((tc) => (
          <ToolCall
            key={tc.id}
            toolCall={tc}
            result={toolResults.get(tc.id)}
            running={runningTools.has(tc.id)}
          />
        ))}
      </div>
    </div>
  );
}
