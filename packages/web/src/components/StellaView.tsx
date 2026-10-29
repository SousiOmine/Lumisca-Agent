import { IconSend } from "@tabler/icons-preact";
import { useEffect, useMemo, useRef, useState } from "preact/compat";
import { sessionVisualBase } from "../api-client.ts";
import { useT } from "../i18n.ts";
import {
  type AppModeStatus,
  emptyView,
  isViewRunning,
  type SessionInfo,
  type SessionView,
} from "../types.ts";
import { Composer } from "./Composer.tsx";
import { MarkdownBlock } from "./chat/MarkdownBlock.tsx";
import { ErrorBanner } from "./chat/ErrorBanner.tsx";
import { buildTurns, ConversationTurn } from "./chat/ConversationTurn.tsx";
import type { UserMessageImage } from "./chat/types.ts";
import { QuestionPanel } from "./QuestionPanel.tsx";
import { TodoPanel } from "./TodoPanel.tsx";
import { TaskPanel } from "./TaskPanel.tsx";
import { BackgroundPanel } from "./BackgroundPanel.tsx";
import { StellaPane } from "./StellaPane.tsx";

/** Shared empties: a fresh array or map on every render would defeat the
 * memoized panels below (they compare by identity). */
const EMPTY_MESSAGES: SessionView["messages"] = [];
const EMPTY_TODOS: SessionView["todos"] = [];
const EMPTY_TASKS: SessionView["tasks"] = [];
const EMPTY_BACKGROUNDS: SessionView["backgrounds"] = [];
const EMPTY_QUESTIONS: SessionView["pendingQuestions"] = [];
const EMPTY_TOOLS: SessionView["runningTools"] = new Map();

interface StellaViewProps {
  /** The agent whose conversation this is (the sidebar picks it). Its name is
   * the conversation's title; its absence (first run, before an agent exists)
   * is why the composer is disabled. */
  agent: { name: string } | null;
  /** The conversation, or null while there is nothing to show yet. */
  view: SessionView | null;
  /** The conversation's session info, when it exists. */
  info?: SessionInfo;
  /** Why the conversation could not be opened (no provider configured, the
   * machine failing to start), or null. Shown in place of the transcript: a
   * disabled composer with no explanation reads as a bug. */
  conversationError: string | null;
  /** The machine's state: `starting` covers the first-run image build (the
   * one wait the user sees); `state` decides whether the screen pane can
   * connect. */
  status: AppModeStatus;
  /** Unsent composer text, owned by the App so it survives a remount. */
  input: string;
  onInputChange: (value: string) => void;
  onPrompt: (text: string) => void;
  onAbort: () => void;
  onAnswer: (
    toolCallId: string,
    answers: { id: string; values: string[] }[],
  ) => Promise<void>;
  /** Rewind from a user message onward (the transcript's undo). */
  onRewind: (timestamp: number) => Promise<void>;
  onOpenSettings: () => void;
}

/**
 * stella mode's conversation: one agent, one running conversation, one
 * machine behind it.
 *
 * What is NOT here is the point. There is no workspace picker, no tab strip,
 * no session history, no model switcher and — since the machine starts itself
 * when a message needs it — no start / stop / reset controls. The machine's
 * state appears only as the one wait that cannot be hidden (a first-run image
 * build) and as errors.
 *
 * The progress panels (todo / tasks / background commands) render only while
 * something is actually in them: an always-present frame of three empty
 * panels is furniture, and furniture the user has to read every time.
 */
export function StellaView(
  {
    agent,
    view,
    info,
    conversationError,
    status,
    input,
    onInputChange,
    onPrompt,
    onAbort,
    onAnswer,
    onRewind,
    onOpenSettings,
  }: StellaViewProps,
) {
  const t = useT();
  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);
  const pendingSubmitScroll = useRef(false);
  // The conversation may not exist yet (first run, or the machine still
  // starting): an empty view stands in so the screen renders regardless.
  const sessionInfo = view?.info ?? info;
  const open = view ??
    (sessionInfo !== undefined ? emptyView(sessionInfo) : undefined);
  const messages = open?.messages ?? EMPTY_MESSAGES;
  const todos = open?.todos ?? EMPTY_TODOS;
  const tasks = open?.tasks ?? EMPTY_TASKS;
  const backgrounds = open?.backgrounds ?? EMPTY_BACKGROUNDS;
  const streamingText = open?.streamingText ?? "";
  const runningTools = open?.runningTools ?? EMPTY_TOOLS;
  const pendingQuestions = open?.pendingQuestions ?? EMPTY_QUESTIONS;
  const isRunning = open !== undefined && isViewRunning(open);
  const visualBase = sessionVisualBase("", sessionInfo?.id ?? "");
  // The screen is not a tab and not a button: while the machine runs it is
  // simply there, beside the conversation, because "the agent works somewhere
  // you can see" is the promise of this mode. Closing it is allowed (a narrow
  // window needs the room) and it comes back with the next message.
  const [screenClosed, setScreenClosed] = useState(false);
  useEffect(() => {
    if (isRunning) setScreenClosed(false);
  }, [isRunning]);
  const machineRunning = status.state === "running";
  const showScreen = machineRunning && !screenClosed;

  // Keep the transcript pinned to the newest content while the user is at the
  // bottom (the same contract as the code view: reading earlier messages must
  // never be yanked away).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const pin = () => {
      if (pendingSubmitScroll.current) {
        pendingSubmitScroll.current = false;
        el.scrollTop = el.scrollHeight;
        return;
      }
      if (!userScrolledUp.current) el.scrollTop = el.scrollHeight;
    };
    const onScroll = () => {
      userScrolledUp.current =
        el.scrollHeight - el.scrollTop - el.clientHeight >= 80;
    };
    pin();
    el.addEventListener("scroll", onScroll, { passive: true });
    const observer = new ResizeObserver(pin);
    observer.observe(el);
    const content = el.firstElementChild;
    if (content) observer.observe(content);
    return () => {
      el.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, []);

  const turns = useMemo(() => buildTurns(messages), [messages]);
  const toolResults = useMemo(() => {
    const map = new Map<
      string,
      Extract<SessionView["messages"][number], { role: "toolResult" }>
    >();
    for (const message of messages) {
      if (message.role === "toolResult") map.set(message.toolCallId, message);
    }
    return map;
  }, [messages]);

  const submit = () => {
    const text = input.trim();
    if (text.length === 0 || sessionInfo === undefined) return;
    onPrompt(text);
    onInputChange("");
    pendingSubmitScroll.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  /** A rewind refills the composer with the message's text, so a corrected
   * prompt can be sent without retyping it. */
  const handleRewind = async (
    timestamp: number,
    text: string,
    _images: UserMessageImage[],
  ) => {
    await onRewind(timestamp);
    onInputChange(text);
  };

  const hasTodos = todos.length > 0;
  const hasTasks = tasks.length > 0;
  const hasBackgrounds = backgrounds.length > 0;
  const hasPanels = hasTodos || hasTasks || hasBackgrounds;

  return (
    <div className="stella">
      <div className="stella-main">
        {agent !== null && (
          <header className="stella-header">
            <h1>{agent.name}</h1>
            {status.starting && (
              <span className="stella-note" role="status">
                {t("chat.stella.machine.starting")}
              </span>
            )}
            {status.state !== "running" && !status.starting &&
              status.reason !== "" && (
              <span className="stella-note error-text" role="alert">
                {status.reason}
              </span>
            )}
          </header>
        )}
        {hasPanels && (
          <div className="stella-panels">
            {hasTodos && <TodoPanel todos={todos} />}
            {hasTasks && <TaskPanel tasks={tasks} />}
            {hasBackgrounds && <BackgroundPanel commands={backgrounds} />}
          </div>
        )}
        <div className="chat-scroll" ref={scrollRef}>
          <div className="chat-column">
            {messages.length === 0 && streamingText.length === 0 && (
              <div className="chat-empty">
                <div className="chat-empty-inner">
                  {conversationError !== null
                    ? (
                      <p className="error-text" role="alert">
                        {t("chat.stella.conversationError", {
                          error: conversationError,
                        })}
                      </p>
                    )
                    : <p>{t("chat.stella.empty")}</p>}
                </div>
              </div>
            )}
            {turns.map((turn, index) => (
              <ConversationTurn
                key={`${turn.user.timestamp}-${index}`}
                turn={turn}
                toolResults={toolResults}
                runningTools={runningTools}
                visualBase={visualBase}
                running={isRunning && index === turns.length - 1}
                endedAt={index === turns.length - 1
                  ? open?.agentEndedAt
                  : undefined}
                onRewind={handleRewind}
              />
            ))}
            {streamingText.length > 0 && (
              <div className="msg">
                <div className="msg-body markdown">
                  <MarkdownBlock
                    text={streamingText}
                    visualBase={visualBase}
                  />
                  <span className="cursor" />
                </div>
              </div>
            )}
            {open?.error && <ErrorBanner text={open.error} />}
          </div>
        </div>
        <div className="input-area">
          <QuestionPanel
            pending={pendingQuestions}
            onAnswer={onAnswer}
          />
          <Composer
            value={input}
            onChange={onInputChange}
            placeholder={agent === null
              ? t("chat.stella.noAgent")
              : t("chat.stella.placeholder")}
            model={{
              provider: sessionInfo?.modelProvider ?? "",
              modelId: sessionInfo?.modelId ?? "",
            }}
            onModelSelect={() => {}}
            thinkingLevel={sessionInfo?.thinkingLevel}
            thinkingLevels={sessionInfo?.thinkingLevels}
            // No model line at all: switching models is a decision that
            // belongs to configuration, not to a conversation whose point is
            // to stay simple, and a line explaining that is one more thing to
            // read. The model follows the app's default (set in settings).
            hideModelSwitch
            hideModelLine
            submitLabel={t("chat.composer.submit")}
            submitIcon={IconSend}
            submitIconOnly
            // Nothing can be sent before the conversation exists (it is
            // created once an agent is picked and the machine runs), so the
            // button says so instead of accepting a prompt that goes nowhere.
            submitDisabled={!input.trim() || sessionInfo === undefined}
            onAbort={isRunning ? onAbort : undefined}
            onSubmit={submit}
            onOpenSettings={onOpenSettings}
            images={[]}
            onImagesChange={() => {}}
          />
        </div>
      </div>
      {showScreen && (
        <StellaPane
          running={machineRunning}
          vncPort={status.vncPort}
          onClose={() => setScreenClosed(true)}
        />
      )}
    </div>
  );
}
