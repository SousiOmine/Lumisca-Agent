import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/compat";
import { IconSend } from "@tabler/icons-preact";
import {
  COMPACTION_DEFAULT_RESERVE_PERCENT,
  COMPACTION_RESERVE_PERCENT_KEY,
  compactionUsageRatio,
  inputBudgetTokens,
  parsePercentSetting,
} from "@lumisca/core/shared";
import { sessionAttachmentBase, sessionVisualBase } from "../api-client.ts";
import { isViewRunning, type SessionView } from "../types.ts";
import type {
  AskAnswer,
  ModePrompt,
  PendingImage,
  ThinkingLevel,
} from "../types.ts";
import {
  Composer,
  type SlashCommand,
  type SlashCommandItem,
} from "./Composer.tsx";
import {
  buildSlashCommands,
  resolveComposerText,
  slashPrompt,
} from "../slashCommands.ts";
import { QuestionPanel } from "./QuestionPanel.tsx";
import { TodoPanel } from "./TodoPanel.tsx";
import { TaskPanel } from "./TaskPanel.tsx";
import { BackgroundPanel } from "./BackgroundPanel.tsx";
import { GoalPanel } from "./GoalPanel.tsx";
import type { UserMessageImage } from "./chat/types.ts";
import { useProviderModels } from "../providers.ts";
import { useSavedPrompts } from "../hooks/useSavedPrompts.ts";
import { useSetting } from "../settingsStore.ts";
import { useSkills } from "../hooks/useSkills.ts";
import { useT } from "../i18n.ts";
import { Transcript } from "./Transcript.tsx";

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
  /** Send the prompt. Rejects when the server did not take it, so the
   * composer can put the text back (see submit). */
  onPrompt: (
    text: string,
    images: PendingImage[],
    mode?: ModePrompt,
  ) => Promise<void>;
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
  /** Cancel the session's active goal (the goal panel's button). */
  onCancelGoal: () => void;
  /** Run a client-side slash command (kind "action"): `/compact` condenses
   * the session's older history into a checkpoint. `instructions` carries
   * the text the user typed after the command (`/compact ファイル操作を詳しく`),
   * which the summarizer uses as its extra focus. */
  onActionCommand?: (commandId: string, instructions?: string) => void;
  /** Read the history before the loaded window (the reader reached the top
   * of the transcript). Returns whether a read started. */
  onLoadOlder: () => boolean;
  /** Whether that read is still in flight (the transcript holds the reader's
   * position until it lands). */
  loadingOlder: boolean;
  /** Open the provider settings from the model picker's "設定画面" link. */
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
    onCancelGoal,
    onActionCommand,
    onLoadOlder,
    loadingOlder,
    onOpenSettings,
  }: ChatViewProps,
) {
  // The transcript owns the scroll element, so a submit can only ASK it to
  // jump (see TranscriptScrollOptions.pinToken): this view holds the intent,
  // not the ref.
  const [pinToken, setPinToken] = useState(0);
  // A prompt is on its way to the server. The composer stays filled until it
  // lands (see submit), so the send button has to say "not yet" explicitly —
  // an empty input used to be what kept a second send from starting.
  const [sending, setSending] = useState(false);
  const t = useT();
  const isRunning = isViewRunning(view);

  // Where this session's `visual:` image references resolve. The assets live
  // where the agent runs, so a peer's session is read through the hub's
  // federation proxy (the same base the per-session API calls use).
  const visualBase = sessionVisualBase(peerId ?? "", view.info.id);
  const attachBase = sessionAttachmentBase(peerId ?? "", view.info.id);

  // --- saved prompts (shared hook so the menu refreshes after the settings
  // panel mutates the list) ----------------------------------------------
  const { prompts: savedPrompts, error: promptsError } = useSavedPrompts();

  // The session's skill catalog (the `/skill` palette): the same discovery
  // the agent's skill tool ran, fetched from the machine running the agent
  // (the workspace may live on a peer).
  const { skills, error: skillsError } = useSkills(
    peerId ?? "",
    view.info.workspaceId,
  );

  // The owning peer's provider catalog (the composer's context meter below
  // reads the same one). Its `configured` flags are the same verdict the
  // settings screen shows, so the send button can explain itself: a session
  // running on a provider that is not set up in Lumisca can never stream.
  // A provider the peer does not list at all (retired upstream) is left
  // alone — an absent entry is not a verdict.
  const { providers, modelsByProvider } = useProviderModels(peerId ?? "");
  const sessionProvider = providers.find(
    (p) => p.id === view.info.modelProvider,
  );
  const providerUnconfigured = sessionProvider?.configured === false;

  // In chat mode only skills, actions and saved prompts are shown (agent
  // modes need a workspace). The translator is a dependency: the menu text
  // follows the app language.
  const allSlashCommands = useMemo<SlashCommand[]>(
    () => buildSlashCommands(savedPrompts, view.info.chat ?? false, skills, t),
    [view.info.chat, savedPrompts, skills, t],
  );

  /** Send the composer text, or an explicit message (slash commands build
   * their own prompt; the input is cleared either way). `mode` is passed
   * through when the prompt was generated by an agent mode, so the server
   * creates a ModeMessage (short text + badge) instead of a plain user
   * message; the skill palette sends a plain message — its text already is
   * the instruction to load the skill.
   *
   * Composer text the menu completed in place is resolved here even when
   * the menu was bypassed (send button, Ctrl+Enter): a client-side action
   * (`/compact [指示]`, which runs its API instead of sending anything), a
   * text-taking mode (`/plan 依頼文` — workspace sessions only) or the
   * skill palette (`/skill 名前 依頼文`, which a chat session has too). An
   * incomplete command line (`/plan` without a request, `/skill` without a
   * skill name) sends nothing.
   *
   * Nothing leaves the composer while the session's provider is not
   * configured (the run — and the `/compact` summarization — would fail
   * with a not-configured error): the send button is disabled for the same
   * reason, and the banner above the composer says which provider is
   * missing. */
  const submit = (message?: string, mode?: ModePrompt) => {
    let text = (message ?? input).trim();
    if (!text && images.length === 0) return;
    if (providerUnconfigured) return;
    if (message === undefined) {
      // One resolver for both composers (see slashCommands.resolveComposerText).
      const resolved = resolveComposerText(text, {
        chat: view.info.chat === true,
        skills,
        t,
        allowActions: true,
      });
      if (resolved.kind === "incomplete") return;
      if (resolved.kind === "action") {
        onInputChange("");
        onImagesChange([]);
        onActionCommand?.(resolved.commandId, resolved.instructions);
        return;
      }
      text = resolved.text;
      mode = resolved.mode;
    }
    // While the agent is running the prompt is steered into the running
    // loop (the server accepts it, no need to block the send button).
    //
    // The composer is cleared only once the server has taken it: clearing
    // first meant a failed send (the server stopped, the network down, the
    // request rejected) threw away what the reader had written, and a long
    // prompt was the most expensive thing to lose. `sending` blocks a second
    // submit while the first is in flight — without it, putting the text back
    // on failure would invite a double send.
    setSending(true);
    void (async () => {
      try {
        await onPrompt(text, images, mode);
        onInputChange("");
        onImagesChange([]);
        setPinToken((token) => token + 1);
      } catch {
        // The view already shows why (useSessionActions puts the classified
        // error on the session). Putting the text back is this function's
        // share: the remark is the same text the reader wrote.
        onInputChange(message ?? input);
        onImagesChange(images);
      } finally {
        setSending(false);
      }
    })();
  };

  /** Send a card's answer as the next prompt. The answer IS the message: the
   * composer's text and staged images stay where they are, and a failure is
   * left to the session's error banner instead of being written back into the
   * composer the reader is typing in. */
  const sendCardAnswer = (text: string) => {
    const answer = text.trim();
    if (answer.length === 0 || providerUnconfigured) return;
    setSending(true);
    void (async () => {
      try {
        await onPrompt(answer, [], undefined);
        setPinToken((token) => token + 1);
      } catch {
        // The view already shows why (useSessionActions puts the classified
        // error on the session).
      } finally {
        setSending(false);
      }
    })();
  };
  const sendCardAnswerRef = useRef(sendCardAnswer);
  useEffect(() => {
    sendCardAnswerRef.current = sendCardAnswer;
  });
  /** Stable wrapper: every turn is memoized, and a new function on each
   * render would redraw the whole transcript. */
  const handleCardSend = useCallback((text: string) => {
    sendCardAnswerRef.current(text);
  }, []);

  /** A `run` or `action` command was picked at the start of the input (the
   * composer handles completion and insertion itself — see
   * Composer.applySlashPick). Agent modes (existing commands) build their
   * prompt and send it like a regular submit (with mode metadata).
   * Client-side actions (`/compact`) call their API instead of sending a
   * prompt; the command token leaves the composer either way, exactly like
   * a submit clears it. */
  const handleSlashCommand = (
    command: SlashCommand,
    item?: SlashCommandItem,
  ) => {
    if (command.kind === "action") {
      if (providerUnconfigured) return;
      onInputChange("");
      onActionCommand?.(command.id);
      return;
    }
    const result = slashPrompt(command, item, "", t);
    if (result !== null) {
      submit(result.text, result.mode);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Escape during an IME conversion cancels the conversion, not the run.
    if (e.isComposing || e.keyCode === 229) return;
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

  // Context meter for the composer footer: the latest turn's input usage
  // against the current model's window, plus the session-average cache
  // hit rate. The window comes from the owning peer's model list ("" =
  // this server); without usage yet the meter stays hidden.
  // The summary comes from the view: the server counts the whole transcript
  // (the view holds a window of it) and the reducer keeps it current as
  // messages stream in, so the meter is not recomputed here.
  const summary = view.usage;
  const currentModel = modelsByProvider.get(view.info.modelProvider)?.find(
    (m) => m.id === view.info.modelId,
  );
  // The meter measures against the prompt budget, not the raw window: a
  // model that publishes an input cap (models.dev `limit.input`) rejects a
  // prompt past the cap, and the window counts the completion too.
  const contextWindow = inputBudgetTokens({
    contextWindow: currentModel?.contextWindow ??
      view.info.model?.contextWindow,
    maxInputTokens: currentModel?.maxInputTokens ??
      view.info.model?.maxInputTokens,
  });
  const contextUsage = summary.currentTokens === undefined
    ? undefined
    : { summary, contextWindow };
  // Where the meter turns amber: the point the next compaction check
  // condenses the history from (`window - reserveShare`). The reservation
  // comes from the shared settings store (read once for the page, so a tab
  // switch does not re-read the settings table); an unset or unreadable
  // value falls back to the compactor's default, so the meter is right out
  // of the box.
  const compactionReservePercent = parsePercentSetting(
    useSetting(COMPACTION_RESERVE_PERCENT_KEY),
  );
  const contextWarnRatio = compactionUsageRatio(
    contextWindow,
    compactionReservePercent ?? COMPACTION_DEFAULT_RESERVE_PERCENT,
  );

  return (
    <div className="chat">
      <Transcript
        messages={view.messages}
        onLoadOlder={onLoadOlder}
        loadingOlder={loadingOlder}
        hasOlder={view.older !== null}
        pinToken={pinToken}
        streamingText={view.streamingText}
        liveCard={view.liveCard}
        liveTools={view.liveTools}
        runningTools={view.runningTools}
        running={isRunning}
        agentEndedAt={view.agentEndedAt}
        error={view.error}
        visualBase={visualBase}
        attachBase={attachBase}
        onRewind={handleRewind}
        onCardSend={handleCardSend}
        empty={view.info.chat
          ? <p>{t("chat.empty.chat")}</p>
          : <p>{t("chat.empty.workspace")}</p>}
      />
      <div className="input-area">
        <div className="progress-panels">
          <GoalPanel goal={view.goal} onCancel={onCancelGoal} />
          <TodoPanel todos={view.todos} />
          <TaskPanel tasks={view.tasks} />
          <BackgroundPanel commands={view.backgrounds} />
        </div>
        <QuestionPanel pending={view.pendingQuestions} onAnswer={onAnswer} />
        {
          /* The slash menu is the only place these lists appear, and a menu
            that opens with no entries says nothing about why. The failure is
            said here, above the composer, where the user would have typed the
            command: an empty palette is not an empty catalog, and the two must
            not read the same. */
        }
        {skillsError !== null && (
          <p className="settings-note" role="status">
            {t("chat.skills.unavailable")}
          </p>
        )}
        {promptsError !== null && (
          <p className="settings-note" role="status">
            {t("chat.prompts.unavailable")}
          </p>
        )}
        {providerUnconfigured && (
          <div className="settings-note" role="status">
            <span>
              {t("chat.composer.providerUnconfigured", {
                provider: sessionProvider?.name ?? view.info.modelProvider,
              })}
            </span>
            {onOpenSettings && (
              <button
                type="button"
                className="btn small"
                onClick={onOpenSettings}
              >
                {t("chrome.modelPicker.settingsLink")}
              </button>
            )}
          </div>
        )}
        <Composer
          value={input}
          onChange={onInputChange}
          placeholder={t("chat.composer.placeholder")}
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
          submitLabel={t("chat.composer.submit")}
          submitIcon={IconSend}
          submitIconOnly
          submitDisabled={(!input.trim() && images.length === 0) ||
            providerUnconfigured || sending}
          onAbort={isRunning ? onAbort : undefined}
          onSubmit={() => submit()}
          onOpenSettings={onOpenSettings}
          mentionWorkspaceId={view.info.chat
            ? undefined
            : view.info.workspaceId}
          mentionPeerId={peerId}
          slashCommands={allSlashCommands.length > 0
            ? allSlashCommands
            : undefined}
          onSlashCommand={handleSlashCommand}
          images={images}
          onImagesChange={onImagesChange}
          contextUsage={contextUsage}
          contextWarnRatio={contextWarnRatio}
        />
      </div>
    </div>
  );
}
