import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { IconMessage, IconSend } from "@tabler/icons-react";
import { isViewRunning, type SessionView } from "../types.ts";
import type {
  AskAnswer,
  ModePrompt,
  PendingImage,
  ThinkingLevel,
  ToolResultMessage,
} from "../types.ts";
import type { SavedPrompt } from "../types.ts";
import {
  Composer,
  type SlashCommand,
  type SlashCommandItem,
} from "./Composer.tsx";
import {
  slashCommands,
  slashPrompt,
  slashPromptFromText,
} from "../slashCommands.ts";
import { QuestionPanel } from "./QuestionPanel.tsx";
import { TodoPanel } from "./TodoPanel.tsx";
import { TaskPanel } from "./TaskPanel.tsx";
import { BackgroundPanel } from "./BackgroundPanel.tsx";
import { MarkdownBlock } from "./chat/MarkdownBlock.tsx";
import { ErrorBanner } from "./chat/ErrorBanner.tsx";
import { buildTurns, ConversationTurn } from "./chat/ConversationTurn.tsx";
import type { UserMessageImage } from "./chat/types.ts";
import { api } from "../api.ts";

export { buildTurns } from "./chat/ConversationTurn.tsx";

interface ChatViewProps {
  view: SessionView;
  /** Peer owning the session ("" = this server); forwarded to the model
   * picker so remote sessions list the peer's models. */
  peerId?: string;
  /** Draft (unsent) composer content, owned by the App per tab so it
   * survives tab switches (this view remounts on every switch). */
  input: string;
  onInputChange: (value: string) => void;
  images: PendingImage[];
  onImagesChange: (images: PendingImage[]) => void;
  onPrompt: (text: string, images: PendingImage[], mode?: ModePrompt) => void;
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

export function ChatView(
  {
    view,
    peerId,
    input,
    onInputChange,
    images,
    onImagesChange,
    onPrompt,
    onAbort,
    onRewind,
    onAnswer,
    onModelChange,
    onThinkingLevelChange,
    onOpenSettings,
  }: ChatViewProps,
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Set on submit: the sent message must become visible even if the user was
  // scrolled up reading earlier messages. The user message arrives
  // asynchronously via the event stream, so the intent is remembered until
  // the next content change forces the scroll.
  const pendingSubmitScroll = useRef(false);
  // Whether the user has scrolled up from the bottom to read earlier
  // messages. While false the view stays pinned to the newest content.
  const userScrolledUp = useRef(false);
  const isRunning = isViewRunning(view);

  // --- saved prompts ------------------------------------------------------

  const [savedPrompts, setSavedPrompts] = useState<SavedPrompt[]>([]);

  useEffect(() => {
    let stale = false;
    api.getSavedPrompts()
      .then((result) => {
        if (stale) return;
        setSavedPrompts(result.prompts);
      })
      .catch(() => {
        // Non-critical: saved prompts just won't appear in the menu.
      });
    return () => {
      stale = true;
    };
  }, []);

  // Build the slash commands list including the /prompt submenu.
  // In chat mode only saved prompts are shown (agent modes need a workspace).
  const allSlashCommands = useMemo<SlashCommand[]>(() => {
    const promptItems: SlashCommandItem[] = savedPrompts.map((p) => ({
      id: p.id,
      label: p.label,
      description: p.prompt.slice(0, 80) + (p.prompt.length > 80 ? "..." : ""),
    }));
    if (view.info.chat) {
      // Chat mode: only saved prompts, no agent modes.
      if (promptItems.length === 0) return [];
      return [{
        id: "prompt",
        label: "保存済みプロンプト",
        description: "登録済みのプロンプトを挿入",
        icon: IconMessage,
        items: promptItems,
      }];
    }
    // Workspace mode: agent modes + saved prompts.
    const commands = [...slashCommands];
    if (promptItems.length > 0) {
      commands.push({
        id: "prompt",
        label: "保存済みプロンプト",
        description: "登録済みのプロンプトを挿入",
        icon: IconMessage,
        items: promptItems,
      });
    }
    return commands;
  }, [view.info.chat, savedPrompts]);

  // Pin the scroll to the newest content while the user is at the bottom.
  // A ResizeObserver fires on every content layout change (streaming
  // deltas, tool state changes, images, error rows), so the follow does not
  // depend on listing each source of growth. User intent comes from the
  // scroll events instead of a proximity check at update time: a single
  // large delta (a whole code block in one chunk) must not leave the view
  // stuck above the fold with the scrollbar reading "bottom". Never yank
  // the position out from under someone reading earlier messages; a
  // submitted message is the exception.
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
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      userScrolledUp.current = !nearBottom;
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

  /** Send the composer text, or an explicit message (slash commands build
   * their own prompt; the input is cleared either way). `mode` is passed
   * through when the prompt was generated by a slash command, so the
   * server creates a ModeMessage (short text + badge) instead of a plain
   * user message.
   *
   * Composer text that starts with a text-taking command line (`/plan
   * 依頼文`) is wrapped into that mode's prompt even when the slash menu
   * was bypassed (send button, Ctrl+Enter); without the request text
   * nothing is sent (the plan mode needs its subject). */
  const submit = (message?: string, mode?: ModePrompt) => {
    let text = (message ?? input).trim();
    if (!text && images.length === 0) return;
    if (message === undefined && !view.info.chat) {
      const line = slashPromptFromText(text);
      if (line !== null) {
        if (line.kind === "needs-text") return;
        text = line.text;
        mode = line.mode;
      }
    }
    // While the agent is running the prompt is steered into the running
    // loop (the server accepts it, no need to block the send button).
    onPrompt(text, images, mode);
    onInputChange("");
    onImagesChange([]);
    // Bring the scroll to the bottom right away and force it again when the
    // sent message arrives (see the effect above) so it is never left hidden
    // below the fold.
    pendingSubmitScroll.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  /** A slash command was chosen. Agent modes (existing commands) build
   * their prompt and send it like a regular submit (with mode metadata);
   * the /prompt submenu inserts the saved prompt text into the composer so
   * the user can edit and send it. `text` is the composer text after the
   * command token (empty for a bare `/command`); text-taking modes (e.g.
   * plan) wrap it as their subject and are not sent while it is missing. */
  const handleSlashCommand = (
    command: SlashCommand,
    item?: SlashCommandItem,
    text?: string,
  ) => {
    if (command.id === "prompt" && item) {
      const saved = savedPrompts.find((p) => p.id === item.id);
      if (saved) {
        onInputChange(saved.prompt);
      }
      return;
    }
    const result = slashPrompt(command, item, text);
    if (result !== null) submit(result.text, result.mode);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape" && isRunning) {
      e.preventDefault();
      onAbort();
    }
  };

  // The App-owned callbacks are recreated on every App render; the
  // memoized ConversationTurn must not re-render when only streaming text
  // changed, so the latest callbacks are kept in refs and the stable
  // wrappers below are what every turn receives.
  const onRewindRef = useRef(onRewind);
  useEffect(() => {
    onRewindRef.current = onRewind;
  }, [onRewind]);
  const onInputChangeRef = useRef(onInputChange);
  useEffect(() => {
    onInputChangeRef.current = onInputChange;
  }, [onInputChange]);
  const onImagesChangeRef = useRef(onImagesChange);
  useEffect(() => {
    onImagesChangeRef.current = onImagesChange;
  }, [onImagesChange]);

  /** Rewind the transcript from a user message onward, then restore the
   * message text and images to the composer so the user can re-send a
   * corrected prompt. The composer is only filled once the deletion
   * succeeded (a failure is shown as a session error); the rewound
   * message's images replace any current attachments. */
  const handleRewind = useCallback(
    async (timestamp: number, text: string, images: UserMessageImage[]) => {
      await onRewindRef.current(timestamp);
      onInputChangeRef.current(text);
      onImagesChangeRef.current(images.map(({ data, mimeType }) => ({
        data: `data:${mimeType};base64,${data}`,
        mimeType,
      })));
    },
    [],
  );

  // Turns and the tool-result index only change when the message list
  // changes; keeping their identities stable lets the memoized
  // ConversationTurn skip re-rendering while only the streaming text (or
  // the composer's own state) changed.
  const turns = useMemo(() => buildTurns(view.messages), [view.messages]);
  const toolResults = useMemo(() => {
    const map = new Map<string, ToolResultMessage>();
    for (const message of view.messages) {
      if (message.role === "toolResult") {
        map.set(message.toolCallId, message);
      }
    }
    return map;
  }, [view.messages]);

  return (
    <div className="chat">
      <div className="chat-panels">
        <TodoPanel todos={view.todos} />
        <TaskPanel tasks={view.tasks} />
        <BackgroundPanel commands={view.backgrounds} />
      </div>
      <div className="chat-scroll" ref={scrollRef}>
        <div className="chat-column">
          {view.messages.length === 0 && view.streamingText.length === 0 && (
            <div className="chat-empty" style={{ height: "50vh" }}>
              <div className="chat-empty-inner">
                {view.info.chat
                  ? (
                    <p>
                      メッセージを入力してください。ワークスペースを使わない
                      シンプルチャットです。
                    </p>
                  )
                  : (
                    <p>
                      タスクを入力してください。ファイルの読み書きとシェルコマンドを
                      ワークスペース内で実行します。
                    </p>
                  )}
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
          {view.error && <ErrorBanner text={view.error} />}
        </div>
      </div>
      <div className="input-area">
        <QuestionPanel pending={view.pendingQuestions} onAnswer={onAnswer} />
        <Composer
          value={input}
          onChange={onInputChange}
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
          onSubmit={() => submit()}
          onOpenSettings={onOpenSettings}
          mentionWorkspaceId={view.info.chat
            ? undefined
            : view.info.workspaceId}
          mentionPeerId={peerId}
          slashCommands={allSlashCommands}
          onSlashCommand={handleSlashCommand}
          images={images}
          onImagesChange={onImagesChange}
        />
      </div>
    </div>
  );
}
