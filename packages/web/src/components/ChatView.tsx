import { memo, useEffect, useRef, useState } from "react";
import {
  IconArrowBackUp,
  IconCheck,
  IconClipboard,
  IconSend,
} from "@tabler/icons-react";
import { contentImages, contentText } from "@lumisca/core/shared";
import { isViewRunning, type SessionView } from "../types.ts";
import type {
  AgentMessage,
  AskAnswer,
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
import { QuestionPanel } from "./QuestionPanel.tsx";
import { TodoPanel } from "./TodoPanel.tsx";
import { TaskPanel } from "./TaskPanel.tsx";
import { NotificationRow } from "./NotificationRow.tsx";
import { renderMarkdown } from "../markdown.ts";

interface ChatViewProps {
  view: SessionView;
  /** Peer owning the session ("" = this server); forwarded to the model
   * picker so remote sessions list the peer's models. */
  peerId?: string;
  onPrompt: (text: string, images: PendingImage[]) => void;
  onAbort: () => void;
  /** Rewind the transcript from a user message onward (the message and
   * everything after it are deleted; an active run is aborted first).
   * Resolves once the deletion is complete; rejects when nothing was
   * deleted. */
  onRewind: (timestamp: number) => Promise<void>;
  /** Answer a pending ask (the ask tool) with the user's selections.
   * Resolves when the answer was accepted; rejects when the question is
   * gone or the answers are invalid. */
  onAnswer: (toolCallId: string, answers: AskAnswer[]) => Promise<void>;
  onModelChange: (provider: string, modelId: string) => void;
  onThinkingLevelChange: (level: ThinkingLevel) => void;
  onOpenSettings?: () => void;
}

/** An image content block of a user message (`data` is base64 without the
 * `data:<mime>;base64,` header; see ContentImages). */
type UserMessageImage = { type: "image"; data: string; mimeType: string };

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
    onRewind,
    onAnswer,
    onModelChange,
    onThinkingLevelChange,
    onOpenSettings,
  }: ChatViewProps,
) {
  const [input, setInput] = useState("");
  const [images, setImages] = useState<PendingImage[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Set on submit: the sent message must become visible even if the user was
  // scrolled up reading earlier messages. The user message arrives
  // asynchronously via the event stream, so the intent is remembered until
  // the next transcript change forces the scroll.
  const pendingSubmitScroll = useRef(false);
  const isRunning = isViewRunning(view);

  // Follow the stream when the user is at the bottom; never yank the scroll
  // position out from under someone reading earlier messages. A submitted
  // message is the exception: the user asked to send it, so it is shown
  // regardless of the previous scroll position.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (pendingSubmitScroll.current) {
      pendingSubmitScroll.current = false;
      el.scrollTop = el.scrollHeight;
      return;
    }
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [view.messages.length, view.streamingText.length]);

  const submit = () => {
    if (!input.trim() && images.length === 0) return;
    // While the agent is running the prompt is steered into the running
    // loop (the server accepts it, no need to block the send button).
    onPrompt(input, images);
    setInput("");
    setImages([]);
    // Bring the scroll to the bottom right away and force it again when the
    // sent message arrives (see the effect above) so it is never left hidden
    // below the fold.
    pendingSubmitScroll.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape" && isRunning) {
      e.preventDefault();
      onAbort();
    }
  };

  /** Rewind the transcript from a user message onward, then restore the
   * message text and images to the composer so the user can re-send a
   * corrected prompt. The composer is only filled once the deletion
   * succeeded (a failure is shown as a session error); the rewound
   * message's images replace any current attachments. */
  const handleRewind = async (
    timestamp: number,
    text: string,
    images: UserMessageImage[],
  ) => {
    await onRewind(timestamp);
    setInput(text);
    setImages(images.map(({ data, mimeType }) => ({
      data: `data:${mimeType};base64,${data}`,
      mimeType,
    })));
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
      <div className="chat-panels">
        <TodoPanel todos={view.todos} />
        <TaskPanel tasks={view.tasks} />
      </div>
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
              onRewind={handleRewind}
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
        <QuestionPanel pending={view.pendingQuestions} onAnswer={onAnswer} />
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

/** Group the flat agent history by the message that started each run: a
 * user prompt or a system notification (background command completions and
 * sub-agent messages also start a run so the agent can react to them). */
export function buildTurns(messages: AgentMessage[]): ConversationTurnData[] {
  const turns: ConversationTurnData[] = [];
  for (const message of messages) {
    if (message.role === "user" || message.role === "notification") {
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
  onRewind,
}: {
  turn: ConversationTurnData;
  toolResults: Map<string, ToolResultMessage>;
  runningTools: Map<string, string>;
  running: boolean;
  endedAt?: number;
  onRewind: (
    timestamp: number,
    text: string,
    images: UserMessageImage[],
  ) => void;
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
        onRewind={onRewind}
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

function CopyableUserMessage({
  text,
  images,
  timestamp,
  onRewind,
}: {
  text: string;
  images: UserMessageImage[];
  timestamp: number;
  onRewind: (
    timestamp: number,
    text: string,
    images: UserMessageImage[],
  ) => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // fallback: select text
    }
  };

  return (
    <div className="msg-user-wrap">
      <div className="msg user">
        <div className="msg-body">
          {images.length > 0 && <ContentImages images={images} />}
          {text && <p>{text}</p>}
        </div>
      </div>
      <div className="msg-user-actions">
        <button
          type="button"
          className="msg-action-btn"
          onClick={() => onRewind(timestamp, text, images)}
        >
          <IconArrowBackUp size={16} stroke={1.5} />
        </button>
        {text && (
          <button
            type="button"
            className="msg-action-btn"
            onClick={handleCopy}
          >
            {copied
              ? <IconCheck size={16} stroke={2} />
              : <IconClipboard size={16} stroke={1.5} />}
          </button>
        )}
      </div>
    </div>
  );
}

function MessageRow({
  message,
  toolResults,
  runningTools,
  onRewind,
}: {
  message: AgentMessage;
  toolResults: Map<string, ToolResultMessage>;
  runningTools: Map<string, string>;
  onRewind?: (
    timestamp: number,
    text: string,
    images: UserMessageImage[],
  ) => void;
}) {
  if (message.role === "toolResult") return null;

  // System notifications are compact one-line rows, not user messages.
  if (message.role === "notification") {
    return <NotificationRow message={message} />;
  }

  if (message.role === "user") {
    const text = contentText(message.content);
    const imageBlocks = contentImages(message.content);
    return (
      <CopyableUserMessage
        text={text}
        images={imageBlocks}
        timestamp={message.timestamp}
        onRewind={onRewind ?? (() => {})}
      />
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
