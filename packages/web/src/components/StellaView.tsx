import { IconFolderShare, IconSend } from "@tabler/icons-preact";
import { useEffect, useRef, useState } from "preact/compat";
import {
  sessionAttachmentBase,
  sessionVisualBase,
  stellaUploadBase,
} from "../api-client.ts";
import { useReducedMotion } from "../hooks/useMediaQuery.ts";
import { usePresence } from "../hooks/usePresence.ts";
import { useT } from "../i18n.ts";
import { inDesktopShell } from "../shell.ts";
import type { StellaConversationState } from "../stella-state.ts";
import type {
  PendingFile,
  PendingImage,
  StellaAgentSummary,
  StellaStatus,
} from "../types.ts";
import { Composer } from "./Composer.tsx";
import { StellaPane } from "./StellaPane.tsx";
import { ShareFolderDialog } from "./stella/ShareFolderDialog.tsx";
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
  onPrompt: (
    text: string,
    images: PendingImage[],
    files: PendingFile[],
  ) => void;
  onAbort: () => void;
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
  input,
  onInputChange,
  images,
  onImagesChange,
  files,
  onFilesChange,
  onPrompt,
  onAbort,
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
  // Lending a folder is a shell action (the folder is on the user's computer
  // and the picker is the shell's), so a browser tab does not offer it.
  const canShareFolder = inDesktopShell();
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  // A loan is a fact the user must see: opening the panel is what shows the
  // folder and the way to take it back. Only on the way in — closing the
  // panel while a folder is lent is the reader's choice, and this must not
  // reopen it under them.
  const lentBefore = useRef(shares.length > 0);
  useEffect(() => {
    if (shares.length > 0 && !lentBefore.current) onScreenOpenChange(true);
    lentBefore.current = shares.length > 0;
  }, [shares.length, onScreenOpenChange]);
  // The screen is the user's while the agent waits for them: the pane turns
  // interactive and a bar above it says what to do and offers "done".
  const handover = conversation?.handover ?? null;
  // A hand-over is the agent stopping and asking the user to act ON the
  // screen. Showing it is not a convenience but the only way to continue the
  // run, so that one case overrides the user's choice — and taking the screen
  // back afterwards leaves the panel as the user last wanted it.
  const handedOver = handover !== null;
  const machineRunning = status?.state === "running";
  // The panel is the conversation's information, not only its screen: a lent
  // folder is worth opening it for while the machine is still starting.
  const showScreen = screenOpen || handedOver;
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
      (text.length === 0 && images.length === 0 && files.length === 0) ||
      conversation === null
    ) {
      return;
    }
    onPrompt(text, images, files);
    onInputChange("");
    onImagesChange([]);
    onFilesChange([]);
    setPinToken((token) => token + 1);
  };

  /** A rewind refills the composer with the message's text, so a corrected
   * prompt can be sent without retyping it. */
  const handleRewind = async (timestamp: number, text: string) => {
    await onRewind(timestamp);
    onInputChange(text);
  };

  return (
    <div className="stella">
      <div className="stella-main">
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
              <p className="stella-loading" role="status">
                {loading ? t("chat.stella.loading") : t("chat.stella.empty")}
              </p>
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
                status.state !== "running" &&
                !status.starting &&
                status.reason !== "" && (
                  <p className="error-text" role="alert">
                    {status.reason}
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
            onRewind={handleRewind}
            onSend={(text) => onPrompt(text, [], [])}
            onProvideEnv={onProvideEnv}
            onDeclineEnv={onDeclineEnv}
            onPickShare={() => setShareDialogOpen(true)}
            onDeclineShare={onDeclineShare}
            onLoadOlder={onLoadOlder}
            loadingOlder={loadingOlder}
            pinToken={pinToken}
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
          <Composer
            value={input}
            onChange={onInputChange}
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
              (!input.trim() && images.length === 0 && files.length === 0) ||
              conversation === null
            }
            onAbort={isRunning ? onAbort : undefined}
            onSubmit={submit}
            onOpenSettings={onOpenSettings}
            images={images}
            onImagesChange={onImagesChange}
            files={files}
            onFilesChange={onFilesChange}
            onShareFolder={
              canShareFolder && conversation !== null && sessionId !== null
                ? () => setShareDialogOpen(true)
                : undefined
            }
            sharing={shares.length > 0}
          />
        </div>
      </div>
      {pane.mounted && (
        <StellaPane
          running={machineRunning}
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
