import { errorMessage } from "@lumisca/core/shared";
import { IconFolderShare, IconSend } from "@tabler/icons-preact";
import type { KeyboardEvent } from "preact/compat";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  sessionAttachmentBase,
  sessionVisualBase,
  stellaUploadBase,
} from "../api-client.ts";
import { useAgentMachine } from "../hooks/useAgentMachine.ts";
import { useNarrowViewport, useReducedMotion } from "../hooks/useMediaQuery.ts";
import { usePresence } from "../hooks/usePresence.ts";
import { useT } from "../i18n.ts";
import { inDesktopShell } from "../shell.ts";
import type { StellaConversationState } from "../stella-state.ts";
import type {
  PendingFile,
  PendingImage,
  PromptUploader,
  StellaAgentSummary,
  StellaStatus,
} from "../types.ts";
import { Composer } from "./Composer.tsx";
import { LoadingSkeleton } from "./LoadingSkeleton.tsx";
import { StellaPane } from "./StellaPane.tsx";
import { ShareFolderDialog } from "./stella/ShareFolderDialog.tsx";
import { StellaSearchBar } from "./stella/StellaSearchBar.tsx";
import { StellaTranscript } from "./stella/StellaTranscript.tsx";

interface StellaViewProps {
  /** The agent whose conversation this is (the sidebar picks it). Its name
   * and face are the title bar's, not this view's (see
   * StellaTitleBarHeader); what this view needs it for is the agent's own
   * asset base and the placeholder, and its absence (first run, before an
   * agent exists) is why the composer is disabled. */
  agent: StellaAgentSummary | null;
  /** The conversation, or null while there is nothing to show yet. */
  conversation: StellaConversationState | null;
  /** The conversation's session id, for the asset base of `visual:` images.
   * The client addresses the conversation by agent; the id is only what the
   * assets are stored under. */
  sessionId: string | null;
  /** Why the conversation could not be opened (no provider configured, the
   * machine failing to start), or null. Shown in place of the transcript: a
   * disabled composer with no explanation reads as a bug. */
  conversationError: string | null;
  /** The conversation is being opened. The transcript shows the wait instead
   * of an empty pane: opening means starting the machine, which takes real
   * time on a cold one and on a slow link. */
  loading: boolean;
  /** The machine's state: `starting` covers the first-run image build (the
   * one wait the user sees); `state` decides whether the screen pane can
   * connect. null while the first read is in flight. */
  status: StellaStatus | null;
  /** Whether the reader wants the machine's screen open. Owned by the caller
   * because the control that flips it lives in the title bar, above this
   * view (see StellaTitleBarHeader): a pane whose switch is in another
   * component cannot keep that switch's state here. */
  screenOpen: boolean;
  onScreenOpenChange: (open: boolean) => void;
  searchOpen?: boolean;
  onSearchOpenChange?: (open: boolean) => void;
  /** Unsent composer text, owned by the App so it survives a remount. */
  input: string;
  onInputChange: (value: string) => void;
  /** Images attached to the next send (data URLs), owned by the App for the
   * same reason as the text: a remount must not throw away an attachment
   * the user picked. */
  images: PendingImage[];
  onImagesChange: (images: PendingImage[]) => void;
  /** Files to put in the machine (the conversation is the mode that has one). */
  files: PendingFile[];
  onFilesChange: (files: PendingFile[]) => void;
  /** Starts one file's transfer to this conversation's agent. */
  onUploadFile: PromptUploader;
  onPrompt: (
    text: string,
    images: PendingImage[],
    files: PendingFile[],
  ) => Promise<void>;
  onAbort: () => void;
  /** Switch an agent back on. The conversation draws this beside the
   * read-only notice in place of the composer: the row's menu is the other
   * way in, and this is the one the reader is looking at. */
  onEnableAgent: (agentId: string) => Promise<void>;
  /** Rewind from a message onward (the transcript's undo). */
  onRewind: (timestamp: number) => Promise<void>;
  /** Read the entries before the loaded window (the reader reached the top
   * of the conversation). Returns whether a read started. */
  onLoadOlder: () => boolean;
  /** Whether that read is still in flight. */
  loadingOlder: boolean;
  /** The user finished at the screen (the `vm_ask_user` hand-over). */
  onFinishHandover: (note: string, toolCallId: string) => Promise<void>;
  /** The user entered the value `vm_env` asked for. */
  onProvideEnv: (value: string, toolCallId: string) => Promise<void>;
  /** The user refused to enter a value. */
  onDeclineEnv: (toolCallId: string) => Promise<void>;
  /** The user lent a folder the agent asked for (`share_request`): the
   * dialog's loan answers the blocked run. */
  onLendShare: (toolCallId: string) => Promise<void>;
  /** The user refused to lend one. */
  onDeclineShare: (toolCallId: string) => Promise<void>;
  onOpenSettings: () => void;
}

/** Whether an arriving loan should open the panel by itself.
 *
 * Opening it is what shows the lent folder and the way to take it back. A
 * phone has no room for it beside the conversation: there the panel is the
 * whole screen, so opening it by itself covers the conversation the reader
 * just tapped and the only way on is its close button. The title bar's
 * toggle still opens it there. `hadLoans` is what the view saw last time,
 * so a loan that was already there when the conversation arrived is not
 * announced a second time. */
export function opensPaneForLoans(
  narrow: boolean,
  loans: number,
  hadLoans: boolean,
): boolean {
  return !narrow && loans > 0 && !hadLoans;
}

/**
 * stella mode's conversation: one agent, one running conversation, one
 * machine behind it.
 *
 * What is NOT here is the point. There is no workspace picker, no tab strip,
 * no session history and — since the machine starts itself when a message
 * needs it — no start / stop / reset controls. The machine's state appears
 * only as the one wait that cannot be hidden (a first-run image build) and as
 * errors.
 *
 * The model line IS here, unlike the other configuration: a conversation
 * lives for years, and its model can be retired from the catalog or lose its
 * provider. Without a way to switch, the only escape would be deleting the
 * agent and the whole conversation with it. It stays one line in the
 * composer's footer, exactly as in code mode.
 *
 * Neither are the progress panels (todo / tasks / background commands), and
 * the transcript is not code mode's: a conversation receives the user's words
 * and the agent's words, and the server never sends the tool rows, context
 * publications or checkpoints behind them (see StellaTranscript). This view
 * therefore has nothing to filter — the difference is in the data, not in a
 * flag.
 */
export function StellaView({
  agent,
  conversation,
  sessionId,
  conversationError,
  loading,
  status,
  screenOpen,
  onScreenOpenChange,
  searchOpen = false,
  onSearchOpenChange,
  input,
  onInputChange,
  images,
  onImagesChange,
  files,
  onFilesChange,
  onUploadFile,
  onPrompt,
  onAbort,
  onEnableAgent,
  onRewind,
  onLoadOlder,
  loadingOlder,
  onFinishHandover,
  onProvideEnv,
  onDeclineEnv,
  onLendShare,
  onDeclineShare,
  onOpenSettings,
}: StellaViewProps) {
  const t = useT();
  // The transcript owns the scroll element (see TranscriptScrollOptions.
  // pinToken): this view only records that a submit happened.
  const [pinToken, setPinToken] = useState(0);
  const [sending, setSending] = useState(false);
  const [highlightedKey, setHighlightedKey] = useState<string | null>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (highlightTimer.current !== null) clearTimeout(highlightTimer.current);
    },
    [],
  );
  // Ctrl/Cmd+F opens in-conversation search while viewing a stella agent.
  useEffect(() => {
    if (agent === null || onSearchOpenChange === undefined) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) {
        return;
      }
      if (event.key.toLowerCase() !== "f") return;
      event.preventDefault();
      onSearchOpenChange(true);
    };
    globalThis.addEventListener("keydown", onKeyDown);
    return () => globalThis.removeEventListener("keydown", onKeyDown);
  }, [agent, onSearchOpenChange]);

  const jumpToEntry = (key: string): boolean => {
    const root = mainRef.current;
    if (root === null) return false;
    const nodes = root.querySelectorAll<HTMLElement>("[data-entry-key]");
    for (const node of nodes) {
      if (node.dataset.entryKey !== key) continue;
      node.scrollIntoView({ block: "center" });
      setHighlightedKey(key);
      if (highlightTimer.current !== null) clearTimeout(highlightTimer.current);
      highlightTimer.current = setTimeout(() => {
        setHighlightedKey(null);
        highlightTimer.current = null;
      }, 1800);
      return true;
    }
    return false;
  };
  const visualBase = sessionVisualBase("", sessionId ?? "");
  const attachBase = sessionAttachmentBase("", sessionId ?? "");
  const uploadBase = stellaUploadBase(agent?.id ?? "");
  // Folders lent from the user's own computer. The server drops a grant when
  // it expires and announces the whole list again, so the client counts what
  // it was given and never keeps a clock of its own.
  const shares = conversation?.shares ?? [];
  // The card the run is blocked on, when it is a request for a folder (a
  // disconnect draws no card: the page carries it out on its own).
  const lendRequest =
    conversation?.shareRequest?.kind === "lend"
      ? conversation.shareRequest
      : null;
  const isRunning = conversation?.running === true;
  /** The agent is switched off: the transcript is history, and everything
   * that would make the agent DO something is gone from this screen. */
  const disabled = conversation?.disabled === true;
  /** The enable request in flight, and why it failed. Kept here rather than
   * in the hook's conversation error, which replaces the transcript: a
   * failed enable leaves the history the reader is looking at. */
  const [enabling, setEnabling] = useState(false);
  const [enableError, setEnableError] = useState<string | null>(null);
  // Lending a folder is a shell action (the folder is on the user's computer
  // and the picker is the shell's), so a browser tab does not offer it.
  const canShareFolder = inDesktopShell();
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  // A loan is a fact the user must see: opening the panel is what shows the
  // folder and the way to take it back. Only on the way in — closing the
  // panel while a folder is lent is the reader's choice, and this must not
  // reopen it under them.
  const narrow = useNarrowViewport();
  const lentBefore = useRef(shares.length > 0);
  useEffect(() => {
    if (opensPaneForLoans(narrow, shares.length, lentBefore.current)) {
      onScreenOpenChange(true);
    }
    lentBefore.current = shares.length > 0;
  }, [narrow, shares.length, onScreenOpenChange]);
  // The screen is the user's while the agent waits for them: the pane turns
  // interactive and a bar above it says what to do and offers "done".
  const handover = conversation?.handover ?? null;
  // A hand-over is the agent stopping and asking the user to act ON the
  // screen. Showing it is not a convenience but the only way to continue the
  // run, so that one case overrides the user's choice — and taking the screen
  // back afterwards leaves the panel as the user last wanted it.
  const handedOver = handover !== null;
  // The conversation's OWN machine. The machines are one per agent and sleep
  // when nobody uses them, so its state is polled here rather than taken from
  // the installation-wide status.
  const agentMachine = useAgentMachine(agent?.id ?? null, !disabled);
  // A machine that is neither running nor asleep is broken or being
  // prepared; the sentence it gives is worth showing.
  const machineProblem =
    agentMachine.machine !== null &&
    agentMachine.machine.state !== "running" &&
    agentMachine.machine.state !== "stopped"
      ? agentMachine.machine.reason
      : "";
  // The panel is the conversation's information, not only its screen: a lent
  // folder is worth opening it for while the machine is still starting.
  const showScreen = !disabled && (screenOpen || handedOver);
  // The pane leaves the way it arrived: motion.ts plays its exit, so it has to
  // stay mounted for that. Without this the column vanished in one frame and
  // tore the conversation's width back out from under the eye.
  const reduceMotion = useReducedMotion();
  const pane = usePresence(showScreen, { instant: reduceMotion });

  const submit = () => {
    const text = input.trim();
    // An image alone is a prompt (the model can look at it and answer), the
    // same rule the server applies to the body it receives.
    if (
      sending ||
      (text.length === 0 && images.length === 0 && files.length === 0) ||
      conversation === null
    ) {
      return;
    }
    // A prompt names the server's id for each file, so sending before the
    // last transfer is done would send a prompt without that attachment.
    if (files.some((file) => file.status !== "done")) return;
    // Keep the draft intact until the server accepts the prompt, matching
    // ChatView.submit so a transient outage never discards an unsent message.
    const pendingInput = input;
    const pendingImages = images;
    const pendingFiles = files;
    setSending(true);
    void (async () => {
      try {
        await onPrompt(text, pendingImages, pendingFiles);
        onInputChange("");
        onImagesChange([]);
        onFilesChange([]);
        setPinToken((token) => token + 1);
      } catch {
        onInputChange(pendingInput);
        onImagesChange(pendingImages);
        onFilesChange(pendingFiles);
      } finally {
        setSending(false);
      }
    })();
  };

  const onComposerKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape" && isRunning) {
      e.preventDefault();
      onAbort();
    }
  };

  /** A rewind refills the composer with the message's text, so a corrected
   * prompt can be sent without retyping it. */
  const handleRewind = async (timestamp: number, text: string) => {
    await onRewind(timestamp);
    onInputChange(text);
  };

  return (
    <div className="stella">
      <div className="stella-main" ref={mainRef}>
        {searchOpen && agent !== null && onSearchOpenChange !== undefined && (
          <StellaSearchBar
            agentId={agent.id}
            agentName={agent.name}
            onClose={() => onSearchOpenChange(false)}
            onJumpToEntry={jumpToEntry}
          />
        )}
        {conversationError !== null ? (
          <div className="chat-scroll">
            <div className="chat-column">
              <p className="error-text" role="alert">
                {t("chat.stella.conversationError", {
                  error: conversationError,
                })}
              </p>
            </div>
          </div>
        ) : conversation === null ? (
          <div className="chat-scroll">
            <div className="chat-column">
              {loading && (
                <LoadingSkeleton
                  label={t("chat.stella.loading")}
                  className="stella-loading"
                />
              )}
              {/* The first-run build is the one wait this mode cannot
               * hide. It lives here rather than in the title bar: it is
               * a sentence, and the title bar is one line of a name. */}
              {status?.starting === true && (
                <p className="stella-loading" role="status">
                  {t("chat.stella.machine.starting")}
                </p>
              )}
              {/* A failure explains why nothing works, so it must be
               * visible even while the conversation is empty. */}
              {status !== null &&
                !status.availability.available &&
                status.reason !== "" && (
                  <p className="error-text" role="alert">
                    {status.reason}
                  </p>
                )}
              {machineProblem !== "" && (
                <p className="error-text" role="alert">
                  {machineProblem}
                </p>
              )}
            </div>
          </div>
        ) : (
          <StellaTranscript
            conversation={conversation}
            author={
              agent === null
                ? { id: "", name: "", icon: "" }
                : { id: agent.id, name: agent.name, icon: agent.icon }
            }
            visualBase={visualBase}
            attachBase={attachBase}
            uploadBase={uploadBase}
            // A disabled conversation is history: the rewind button would
            // rewrite a transcript the server refuses to open, and a card's
            // answer would be a message nobody can send.
            onRewind={disabled ? undefined : handleRewind}
            onSend={
              disabled
                ? undefined
                : (text) => {
                    void onPrompt(text, [], []).catch(() => {});
                  }
            }
            onProvideEnv={onProvideEnv}
            onDeclineEnv={onDeclineEnv}
            onPickShare={() => setShareDialogOpen(true)}
            onDeclineShare={onDeclineShare}
            onLoadOlder={onLoadOlder}
            loadingOlder={loadingOlder}
            pinToken={pinToken}
            highlightedKey={highlightedKey}
          />
        )}
        <div className="input-area">
          {/* A loan is a fact about what this message can reach, not
           * progress: it stays while it lasts, as a count above the field
           * and as the field's own frame in the same colour (composer.css,
           * the lent folders block). The paths are the folders the user
           * picked, on hover, so the count can be checked without leaving
           * the conversation. */}
          {shares.length > 0 && (
            <p
              className="share-notice"
              role="status"
              title={shares.map((share) => share.path).join("\n")}
            >
              <IconFolderShare size={13} className="share-notice-icon" />
              {shares.length === 1
                ? t("chat.stella.share.activeOne")
                : t("chat.stella.share.active", { count: shares.length })}
            </p>
          )}
          {disabled ? (
            // The one thing a disabled agent can still do is be switched
            // back on. The notice says why nothing here works, and the
            // button is the way out of it without going back to the list.
            <div className="stella-disabled-note">
              <p className="stella-disabled-text">
                {t("chat.stella.disabledNotice")}
              </p>
              {loading ? (
                // The switch was flipped and the conversation is being
                // opened (a cold machine takes minutes). The button is gone
                // rather than pressable a second time for nothing.
                <p className="stella-loading" role="status">
                  {t("chat.stella.loading")}
                </p>
              ) : (
                <button
                  type="button"
                  className="btn"
                  disabled={enabling || agent === null}
                  onClick={() => {
                    if (agent === null) return;
                    setEnabling(true);
                    setEnableError(null);
                    void onEnableAgent(agent.id)
                      .catch((failure: unknown) =>
                        setEnableError(errorMessage(failure)),
                      )
                      .finally(() => setEnabling(false));
                  }}
                >
                  {t("chat.stella.agents.enable")}
                </button>
              )}
              {enableError !== null && (
                <p className="error-text" role="alert">
                  {enableError}
                </p>
              )}
            </div>
          ) : (
            <Composer
              value={input}
              onChange={onInputChange}
              onKeyDown={onComposerKeyDown}
              placeholder={
                agent === null
                  ? t("chat.stella.noAgent")
                  : t("chat.stella.placeholder")
              }
              // No model line here. A stella conversation is one ongoing
              // chat, so its model belongs to the AGENT and is set once in the
              // agent's edit dialog (AgentEditDialog) rather than chosen per
              // message: a control the user changes rarely does not deserve a
              // row of every screen. The escape from a retired model is there
              // too.
              model={conversation?.model ?? null}
              onModelSelect={() => {}}
              modelBar="none"
              submitLabel={t("chat.composer.submit")}
              submitIcon={IconSend}
              submitIconOnly
              // Nothing can be sent before the conversation exists (it is
              // created once an agent is picked and the machine runs), so the
              // button says so instead of accepting a prompt that goes nowhere.
              submitDisabled={
                sending ||
                (!input.trim() && images.length === 0 && files.length === 0) ||
                conversation === null ||
                files.some((file) => file.status !== "done")
              }
              onAbort={isRunning ? onAbort : undefined}
              onSubmit={submit}
              onOpenSettings={onOpenSettings}
              images={images}
              onImagesChange={onImagesChange}
              files={files}
              onFilesChange={onFilesChange}
              onUploadFile={onUploadFile}
              fileTarget={agent?.id}
              onShareFolder={
                canShareFolder && conversation !== null && sessionId !== null
                  ? () => setShareDialogOpen(true)
                  : undefined
              }
              sharing={shares.length > 0}
            />
          )}
        </div>
      </div>
      {pane.mounted && (
        <StellaPane
          machine={agentMachine.machine}
          waking={agentMachine.waking}
          wakeError={agentMachine.error}
          onWake={() => void agentMachine.wake()}
          onActivity={agentMachine.touch}
          shares={shares}
          agentId={agent?.id ?? null}
          handover={
            handover === null
              ? null
              : {
                  toolCallId: handover.toolCallId,
                  reason: handover.reason,
                  instructions: handover.instructions,
                  expiresAt: handover.expiresAt,
                }
          }
          onFinishHandover={onFinishHandover}
          // The pane's own × means the same thing as the header's toggle. A
          // hand-over is the one state where leaving is not the user's call
          // (the run is blocked on this pane), so there is no × at all.
          onClose={handedOver ? undefined : () => onScreenOpenChange(false)}
          exiting={pane.exiting}
          onExitDone={pane.done}
        />
      )}
      {shareDialogOpen && sessionId !== null && (
        <ShareFolderDialog
          sessionId={sessionId}
          onClose={() => setShareDialogOpen(false)}
          // A loan made from the menu answers a waiting `share_request` too:
          // the card and the menu ask the same question, so whichever way the
          // folder was chosen, the run continues from it.
          {...(lendRequest !== null
            ? {
                onLent: () => {
                  // The loan is the answer; the card goes when the server
                  // says so. An answer that does not reach the server is
                  // reported by the tool's own deadline — there is nothing
                  // to draw here for a request that is already on screen.
                  void onLendShare(lendRequest.toolCallId).catch(() => {});
                },
              }
            : {})}
        />
      )}
    </div>
  );
}
