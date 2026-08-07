import { memo, useEffect, useRef, useState } from "react";
import { contentText } from "@lumisca/core/shared";
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

/** Memoized markdown rendering: message text is static once a message is
 * complete, so a text delta must not re-parse every historical message. */
const MarkdownBlock = memo(function MarkdownBlock({ text }: { text: string }) {
  return <div dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
});

export function ChatView(
  { view, onPrompt, onAbort, onModelChange }: ChatViewProps,
) {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const isRunning = isViewRunning(view);

  // Follow the stream when the user is at the bottom; never yank the scroll
  // position out from under someone reading earlier messages.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) el.scrollTop = el.scrollHeight;
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

  // Pair each assistant message with the tool results that follow it, in a
  // single forward pass (message rows no longer slice the tail per row).
  const toolResultsByIndex = new Map<number, Map<string, ToolResultMessage>>();
  for (let i = 0; i < view.messages.length; i++) {
    const m = view.messages[i]!;
    if (m.role !== "assistant") continue;
    const results = new Map<string, ToolResultMessage>();
    for (let j = i + 1; j < view.messages.length; j++) {
      const next = view.messages[j]!;
      if (next.role !== "toolResult") break;
      results.set(next.toolCallId, next);
    }
    toolResultsByIndex.set(i, results);
  }

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
              toolResults={toolResultsByIndex.get(i) ?? EMPTY_RESULTS}
              runningTools={view.runningTools}
            />
          ))}
          {view.streamingText.length > 0 && (
            <div className="msg">
              <div className="msg-body markdown">
                <MarkdownBlock text={view.streamingText} />
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
          model={{
            provider: view.info.modelProvider,
            modelId: view.info.modelId,
          }}
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

/** Shared empty map for messages without tool results. */
const EMPTY_RESULTS = new Map<string, ToolResultMessage>();

function MessageRow({
  message,
  toolResults,
  runningTools,
}: {
  message: AgentMessage;
  toolResults: Map<string, ToolResultMessage>;
  runningTools: Map<string, string>;
}) {
  if (message.role === "toolResult") return null;

  if (message.role === "user") {
    const text = contentText(message.content);
    return (
      <div className="msg user">
        <div className="msg-body">
          <p>{text}</p>
        </div>
      </div>
    );
  }

  const assistant = message as AssistantMessage;
  const text = contentText(assistant.content);
  const toolCalls = assistant.content.filter(
    (b): b is ToolCallBlock => b.type === "toolCall",
  );

  return (
    <div className="msg">
      <div className="msg-body markdown">
        {text && <MarkdownBlock text={text} />}
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
