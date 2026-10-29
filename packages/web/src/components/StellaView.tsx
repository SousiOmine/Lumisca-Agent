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
import { useElementHeight } from "../hooks/useElementHeight.ts";
import { Composer } from "./Composer.tsx";
import { MarkdownBlock } from "./chat/MarkdownBlock.tsx";
import { ErrorBanner } from "./chat/ErrorBanner.tsx";
import { buildTurns, ConversationTurn } from "./chat/ConversationTurn.tsx";
import type { UserMessageImage } from "./chat/types.ts";
import { QuestionPanel } from "./QuestionPanel.tsx";
import { TodoPanel } from "./TodoPanel.tsx";
import { TaskPanel } from "./TaskPanel.tsx";
import { BackgroundPanel } from "./BackgroundPanel.tsx";
import { StellaMachinePanel } from "./StellaMachinePanel.tsx";
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
  /** stella's single conversation view, or null while the conversation does
   * not exist yet — the machine is started from this screen, so the screen
   * must render before there is anything to talk to. */
  view: SessionView | null;
  /** The conversation's session info, when it exists (the composer's model
   * display); absent together with `view`. */
  info?: SessionInfo;
  /** Why the conversation could not be opened (a provider not configured,
   * the machine failing to start), or null. Shown in place of the empty
   * transcript: a disabled composer with no explanation reads as a bug. */
  conversationError: string | null;
  /** The machine's current state, for the header and the screen pane. */
  status: AppModeStatus;
  onStatus: (status: AppModeStatus) => void;
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
 * stella mode: one conversation with one assistant, working inside a virtual
 * machine.
 *
 * Deliberately not a session view with the tabs removed. What a session view
 * offers — a workspace picker, a session history, a tab strip, a model
 * switcher per tab — is the cognitive load this mode exists to remove. What
 * it keeps is the transcript, the composer, the question card and the three
 * panels that reflect work in progress (todo, tasks, background commands),
 * since those are what the user watches while the agent works.
 *
 * The machine's screen is a pane beside the chat rather than a hidden tab:
 * stella's promise is that the agent works somewhere the user can see, and a
 * screen nobody looks at keeps none of it.
 */
export function StellaView(
  {
    view,
    info,
    conversationError,
    status,
    onStatus,
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
  // The floating panels are positioned from the viewport; this header is
  // between that edge and the transcript, so its height is published for the
  // stylesheet to offset them (see stella.css).
  const headerRef = useRef<HTMLElement>(null);
  useElementHeight(headerRef, "--stella-header-height");
  const userScrolledUp = useRef(false);
  const pendingSubmitScroll = useRef(false);
  // The conversation does not exist until the machine runs: an empty view
  // stands in so the screen (and its Start button) renders regardless.
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
  const [showScreen, setShowScreen] = useState(status.state === "running");

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

  const machineRunning = status.state === "running";

  return (
    <div className="stella">
      <div className="stella-main">
        <header className="stella-header" ref={headerRef}>
          <div className="stella-title">
            <h1>{t("chat.stella.title")}</h1>
            <p>{t("chat.stella.subtitle")}</p>
          </div>
          <StellaMachinePanel status={status} onStatus={onStatus} />
          <button
            type="button"
            className="btn small"
            onClick={() => setShowScreen((value) => !value)}
          >
            {showScreen
              ? t("chat.stella.machine.closeScreen")
              : t("chat.stella.machine.openScreen")}
          </button>
        </header>
        <div className="chat-panels">
          <TodoPanel todos={todos} />
          <TaskPanel tasks={tasks} />
          <BackgroundPanel commands={backgrounds} />
        </div>
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
            placeholder={t("chat.stella.placeholder")}
            model={{
              provider: sessionInfo?.modelProvider ?? "",
              modelId: sessionInfo?.modelId ?? "",
            }}
            onModelSelect={() => {}}
            thinkingLevel={sessionInfo?.thinkingLevel}
            thinkingLevels={sessionInfo?.thinkingLevels}
            // No model picker: switching models is a decision that belongs to
            // configuration, not to a conversation whose point is to stay
            // simple. The model follows the app's default (set in settings).
            hideModelSwitch
            submitLabel={t("chat.composer.submit")}
            submitIcon={IconSend}
            submitIconOnly
            // Nothing can be sent before the conversation exists (it is
            // created once the machine runs), so the button says so instead of
            // accepting a prompt that would go nowhere.
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
          onClose={() => setShowScreen(false)}
        />
      )}
    </div>
  );
}
