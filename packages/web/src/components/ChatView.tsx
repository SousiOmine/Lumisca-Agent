import { memo, useEffect, useRef, useState } from "react";
import { IconSend } from "@tabler/icons-react";
import { contentImages, contentText } from "@lumisca/core/shared";
import { isViewRunning, type SessionView } from "../types.ts";
import type {
  AgentMessage,
  AssistantMessage,
  PendingImage,
  ThinkingLevel,
  ToolCallBlock,
  ToolResultMessage,
} from "../types.ts";
import { ToolCall } from "./ToolCall.tsx";
import { AgentActivity } from "./AgentActivity.tsx";
import { Composer } from "./Composer.tsx";
import { ContentImages } from "./ContentImages.tsx";
import { renderMarkdown } from "../markdown.ts";

interface ChatViewProps {
  view: SessionView;
  /** Peer owning the session ("" = this server); forwarded to the model
   * picker so remote sessions list the peer's models. */
  peerId?: string;
  onPrompt: (text: string, images: PendingImage[]) => void;
  onAbort: () => void;
  onModelChange: (provider: string, modelId: string) => void;
  onThinkingLevelChange: (level: ThinkingLevel) => void;
  onOpenSettings?: () => void;
}

/** Memoized markdown rendering: message text is static once a message is
 * complete, so a text delta must not re-parse every historical message. */
const MarkdownBlock = memo(function MarkdownBlock({ text }: { text: string }) {
  return <div dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
});

export function ChatView(
  {
    view,
    peerId,
    onPrompt,
    onAbort,
    onModelChange,
    onThinkingLevelChange,
    onOpenSettings,
  }: ChatViewProps,
) {
  const [input, setInput] = useState("");
  const [images, setImages] = useState<PendingImage[]>([]);
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
    if ((!input.trim() && images.length === 0) || isRunning) return;
    onPrompt(input, images);
    setInput("");
    setImages([]);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape" && isRunning) {
      e.preventDefault();
      onAbort();
    }
  };

  const turns = buildTurns(view.messages);
  const toolResults = new Map<string, ToolResultMessage>();
  for (const message of view.messages) {
    if (message.role === "toolResult") {
      toolResults.set(message.toolCallId, message);
    }
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
          {turns.map((turn, index) => (
            <ConversationTurn
              key={`${turn.user.timestamp}-${index}`}
              turn={turn}
              toolResults={toolResults}
              runningTools={view.runningTools}
              running={isRunning && index === turns.length - 1}
              endedAt={index === turns.length - 1
                ? view.agentEndedAt
                : undefined}
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
          peerId={peerId}
          onModelSelect={onModelChange}
          thinkingLevel={view.info.thinkingLevel}
          thinkingLevels={view.info.thinkingLevels}
          onThinkingLevelChange={onThinkingLevelChange}
          submitLabel="送信"
          submitIcon={IconSend}
          submitIconOnly
          submitDisabled={!input.trim() && images.length === 0}
          onAbort={isRunning ? onAbort : undefined}
          onSubmit={submit}
          onOpenSettings={onOpenSettings}
          mentionWorkspaceId={view.info.workspaceId}
          mentionPeerId={peerId}
          images={images}
          onImagesChange={setImages}
        />
      </div>
    </div>
  );
}

interface ConversationTurnData {
  user: AgentMessage;
  responses: AgentMessage[];
}

/** Group the flat agent history by the user message that started each run. */
export function buildTurns(messages: AgentMessage[]): ConversationTurnData[] {
  const turns: ConversationTurnData[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      turns.push({ user: message, responses: [] });
      continue;
    }
    const current = turns.at(-1);
    if (current) current.responses.push(message);
  }
  return turns;
}

function ConversationTurn({
  turn,
  toolResults,
  runningTools,
  running,
  endedAt,
}: {
  turn: ConversationTurnData;
  toolResults: Map<string, ToolResultMessage>;
  runningTools: Map<string, string>;
  running: boolean;
  endedAt?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const assistants = turn.responses.filter(
    (message): message is AssistantMessage => message.role === "assistant",
  );
  const finalAssistant = assistants.at(-1);
  const intermediate = finalAssistant ? assistants.slice(0, -1) : assistants;
  const finalToolCalls = finalAssistant?.content.filter(
    (block): block is ToolCallBlock => block.type === "toolCall",
  ) ?? [];
  const expandable = intermediate.length > 0 || finalToolCalls.length > 0;
  const lastTimestamp = turn.responses.reduce(
    (latest, message) => Math.max(latest, message.timestamp),
    turn.user.timestamp,
  );
  const completionTime = endedAt ?? lastTimestamp;

  return (
    <section className="conversation-turn">
      <MessageRow
        message={turn.user}
        toolResults={toolResults}
        runningTools={runningTools}
      />
      {(running || turn.responses.length > 0) && (
        <AgentActivity
          startedAt={turn.user.timestamp}
          endedAt={running ? undefined : completionTime}
          running={running}
          expanded={running || expanded}
          expandable={!running && expandable}
          onToggle={() => {
            if (!running && expandable) setExpanded((open) => !open);
          }}
        />
      )}
      {(running || expanded) && (
        <div className="agent-work-log">
          {intermediate.map((message, index) => (
            <MessageRow
              key={`${message.timestamp}-${index}`}
              message={message}
              toolResults={toolResults}
              runningTools={runningTools}
            />
          ))}
          {finalAssistant && finalToolCalls.length > 0 && (
            <AssistantTools
              assistant={finalAssistant}
              toolResults={toolResults}
              runningTools={runningTools}
            />
          )}
        </div>
      )}
      {finalAssistant && contentText(finalAssistant.content) && (
        <AssistantText message={finalAssistant} />
      )}
    </section>
  );
}

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
    const imageBlocks = contentImages(message.content);
    return (
      <div className="msg user">
        <div className="msg-body">
          {imageBlocks.length > 0 && <ContentImages images={imageBlocks} />}
          {text && <p>{text}</p>}
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

function AssistantText({ message }: { message: AssistantMessage }) {
  return (
    <div className="msg">
      <div className="msg-body markdown">
        <MarkdownBlock text={contentText(message.content)} />
      </div>
    </div>
  );
}

function AssistantTools({
  assistant,
  toolResults,
  runningTools,
}: {
  assistant: AssistantMessage;
  toolResults: Map<string, ToolResultMessage>;
  runningTools: Map<string, string>;
}) {
  const toolCalls = assistant.content.filter(
    (block): block is ToolCallBlock => block.type === "toolCall",
  );
  return (
    <div className="msg">
      <div className="msg-body markdown">
        {toolCalls.map((toolCall) => (
          <ToolCall
            key={toolCall.id}
            toolCall={toolCall}
            result={toolResults.get(toolCall.id)}
            running={runningTools.has(toolCall.id)}
          />
        ))}
      </div>
    </div>
  );
}
