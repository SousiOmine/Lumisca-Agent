import { IconSend } from "@tabler/icons-preact";
import { useEffect, useState } from "preact/compat";
import { sessionAttachmentBase, sessionVisualBase } from "../api-client.ts";
import { useT } from "../i18n.ts";
import type { AppModeStatus } from "../types.ts";
import { Composer } from "./Composer.tsx";
import { useTranscriptScroll } from "../hooks/useTranscriptScroll.ts";
import { StellaPane } from "./StellaPane.tsx";
import { StellaTranscript } from "./stella/StellaTranscript.tsx";
import type { StellaConversationState } from "../stella-state.ts";

interface StellaViewProps {
  /** The agent whose conversation this is (the sidebar picks it). Its name is
   * the conversation's title; its absence (first run, before an agent exists)
   * is why the composer is disabled. */
  agent: { name: string } | null;
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
   * connect. */
  status: AppModeStatus;
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
  const { pinOnNextContent } = useTranscriptScroll();
  const visualBase = sessionVisualBase("", sessionId ?? "");
  const attachBase = sessionAttachmentBase("", sessionId ?? "");
  const isRunning = conversation?.running === true;
  // The screen is the user's while the agent waits for them: the pane turns
  // interactive and a bar above it says what to do and offers "done".
  const handover = conversation?.handover ?? null;
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

  const submit = () => {
    const text = input.trim();
    if (text.length === 0 || conversation === null) return;
    onPrompt(text);
    onInputChange("");
    pinOnNextContent();
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
          vncPort={status.vncPort}
          handover={handover === null ? null : {
            toolCallId: handover.toolCallId,
            reason: handover.reason,
            instructions: handover.instructions,
          }}
          onFinishHandover={onFinishHandover}
          onClose={() => setScreenClosed(true)}
        />
      )}
    </div>
  );
}
