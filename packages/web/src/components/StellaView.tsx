import { IconEye, IconEyeOff, IconSend } from "@tabler/icons-preact";
import { useState } from "preact/compat";
import { sessionAttachmentBase, sessionVisualBase } from "../api-client.ts";
import { useT } from "../i18n.ts";
import type { StellaAgent, StellaStatus } from "../types.ts";
import { Composer } from "./Composer.tsx";
import { StellaPane } from "./StellaPane.tsx";
import { StellaTranscript } from "./stella/StellaTranscript.tsx";
import { AgentAvatar } from "./stella/AgentAvatar.tsx";
import { AgentIconDialog } from "./stella/AgentIconDialog.tsx";
import type { StellaConversationState } from "../stella-state.ts";

interface StellaViewProps {
  /** The agent whose conversation this is (the sidebar picks it). Its name is
   * the conversation's title and its avatar opens the icon dialog; its
   * absence (first run, before an agent exists) is why the composer is
   * disabled. */
  agent: StellaAgent | null;
  /** The agent row the server answered after an icon change, so the App can
   * replace it without re-reading the list. */
  onAgentChanged: (agent: StellaAgent) => void;
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
  /** The machine's state: `starting` covers the first-run image build (the
   * one wait the user sees); `state` decides whether the screen pane can
   * connect. null while the first read is in flight. */
  status: StellaStatus | null;
  /** Unsent composer text, owned by the App so it survives a remount. */
  input: string;
  onInputChange: (value: string) => void;
  onPrompt: (text: string) => void;
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
 * Neither are the progress panels (todo / tasks / background commands), and
 * the transcript is not code mode's: a conversation receives the user's words
 * and the agent's words, and the server never sends the tool rows, context
 * publications or checkpoints behind them (see StellaTranscript). This view
 * therefore has nothing to filter — the difference is in the data, not in a
 * flag.
 */
export function StellaView(
  {
    agent,
    onAgentChanged,
    conversation,
    sessionId,
    conversationError,
    status,
    input,
    onInputChange,
    onPrompt,
    onAbort,
    onRewind,
    onLoadOlder,
    loadingOlder,
    onFinishHandover,
    onOpenSettings,
  }: StellaViewProps,
) {
  const t = useT();
  // The transcript owns the scroll element (see TranscriptScrollOptions.
  // pinToken): this view only records that a submit happened.
  const [pinToken, setPinToken] = useState(0);
  // Picking a picture is a decision about the agent, so the control sits on
  // the agent's own face in the header rather than in a settings dialog:
  // it is where the user looks when they want that agent to look different.
  const [editingIcon, setEditingIcon] = useState(false);
  const visualBase = sessionVisualBase("", sessionId ?? "");
  const attachBase = sessionAttachmentBase("", sessionId ?? "");
  const isRunning = conversation?.running === true;
  // The screen is the user's while the agent waits for them: the pane turns
  // interactive and a bar above it says what to do and offers "done".
  const handover = conversation?.handover ?? null;
  // The machine's screen is a panel the user opens and closes, like a side
  // panel: it starts open (the machine is the promise of this mode, and
  // watching the work is why it is drawn beside the conversation), the
  // header's toggle hides and shows it, and closing it stays closed. It used
  // to reopen on its own whenever a message was sent, which meant the button
  // could not be trusted: one send brought back the pane the user had just
  // dismissed.
  const [screenOpen, setScreenOpen] = useState(true);
  // A hand-over is the agent stopping and asking the user to act ON the
  // screen. Showing it is not a convenience but the only way to continue the
  // run, so that one case overrides the user's choice — and taking the screen
  // back afterwards leaves the panel as the user last wanted it.
  const handedOver = handover !== null;
  const machineRunning = status?.state === "running";
  const showScreen = machineRunning && (screenOpen || handedOver);

  const submit = () => {
    const text = input.trim();
    if (text.length === 0 || conversation === null) return;
    onPrompt(text);
    onInputChange("");
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
        {agent !== null && (
          <header className="stella-header">
            <button
              type="button"
              className="stella-header-avatar"
              onClick={() => setEditingIcon(true)}
              title={t("chat.stella.agents.icon.edit")}
              aria-label={t("chat.stella.agents.icon.edit")}
            >
              <AgentAvatar
                agentId={agent.id}
                name={agent.name}
                icon={agent.icon}
                size={28}
              />
            </button>
            <h1>{agent.name}</h1>
            {status?.starting === true && (
              <span className="stella-note" role="status">
                {t("chat.stella.machine.starting")}
              </span>
            )}
            {status !== null && status.state !== "running" &&
              !status.starting &&
              status.reason !== "" && (
              <span className="stella-note error-text" role="alert">
                {status.reason}
              </span>
            )}
            {
              /* The screen toggle sits at the header's right edge, opposite
             * the agent it belongs to: the pane it shows and hides is the
             * second column of this view, so the control lives on the edge
             * between the two. Hidden while the machine cannot show a picture
             * at all — a disabled toggle would promise a pane that will not
             * appear — and while a hand-over is waiting for the user, because
             * then the pane cannot be dismissed either. */
            }
            {machineRunning && !handedOver && (
              <button
                type="button"
                className={`stella-screen-toggle${showScreen ? " on" : ""}`}
                onClick={() => setScreenOpen((open) => !open)}
                aria-pressed={showScreen}
                title={t(
                  showScreen
                    ? "chat.stella.machine.hideScreen"
                    : "chat.stella.machine.showScreen",
                )}
                aria-label={t(
                  showScreen
                    ? "chat.stella.machine.hideScreen"
                    : "chat.stella.machine.showScreen",
                )}
              >
                {showScreen ? <IconEyeOff size={15} /> : <IconEye size={15} />}
              </button>
            )}
          </header>
        )}
        {conversationError !== null
          ? (
            <div className="chat-scroll">
              <div className="chat-column">
                <p className="error-text" role="alert">
                  {t("chat.stella.conversationError", {
                    error: conversationError,
                  })}
                </p>
              </div>
            </div>
          )
          : conversation === null
          ? (
            <div className="chat-scroll">
              <div className="chat-column">
                <p>{t("chat.stella.empty")}</p>
              </div>
            </div>
          )
          : (
            <StellaTranscript
              conversation={conversation}
              visualBase={visualBase}
              attachBase={attachBase}
              onRewind={handleRewind}
              onSend={(text) => onPrompt(text)}
              onLoadOlder={onLoadOlder}
              loadingOlder={loadingOlder}
              pinToken={pinToken}
            />
          )}
        <div className="input-area">
          <Composer
            value={input}
            onChange={onInputChange}
            placeholder={agent === null
              ? t("chat.stella.noAgent")
              : t("chat.stella.placeholder")}
            model={null}
            onModelSelect={() => {}}
            // No model line at all: switching models is a decision that
            // belongs to configuration, not to a conversation whose point is
            // to stay simple, and a line explaining that is one more thing to
            // read. The model follows the app's default (set in settings).
            modelBar="none"
            submitLabel={t("chat.composer.submit")}
            submitIcon={IconSend}
            submitIconOnly
            // Nothing can be sent before the conversation exists (it is
            // created once an agent is picked and the machine runs), so the
            // button says so instead of accepting a prompt that goes nowhere.
            submitDisabled={!input.trim() || conversation === null}
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
          vncPort={status?.vncPort ?? null}
          handover={handover === null ? null : {
            toolCallId: handover.toolCallId,
            reason: handover.reason,
            instructions: handover.instructions,
          }}
          onFinishHandover={onFinishHandover}
          // The pane's own × means the same thing as the header's toggle. A
          // hand-over is the one state where leaving is not the user's call
          // (the run is blocked on this pane), so there is no × at all.
          onClose={handedOver ? undefined : () => setScreenOpen(false)}
        />
      )}
      {agent !== null && editingIcon && (
        <AgentIconDialog
          agent={agent}
          onChanged={onAgentChanged}
          onClose={() => setEditingIcon(false)}
        />
      )}
    </div>
  );
}
